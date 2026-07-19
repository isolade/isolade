import { StringDecoder } from "node:string_decoder";
import { PushQueue } from "@isolade/shared";
import type { SandboxApi } from "../sandbox-client";

const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;
const MAX_STDERR_CHARS = 16 * 1024;

// Per-turn callbacks supplied by ClaudeBackend. The session owns transport and
// turn framing. The backend owns *interpreting* events (deltas, tool calls,
// thinking, usage accounting). Keeping that split means all the carefully
// tuned token-accounting logic stays in one place and the session stays a thin
// I/O layer.
export interface TurnHooks {
  // Invoked for every parsed CLI event except transport-level
  // `control_response` records, which are correlated internally. Includes the
  // terminal `result` event so the backend can do its turn-cumulative usage
  // accounting before the turn resolves.
  onEvent: (event: Record<string, unknown>) => void;
  // A stdout line that didn't parse as JSON: CLI bug, truncation, version
  // skew. The backend surfaces it as a `raw` event + warns.
  onNonJsonLine: (line: string, err: unknown) => void;
  // The assistant text assembled so far, read once when the turn settles.
  getContent: () => string;
}

interface ActiveTurn {
  hooks: TurnHooks;
  signal?: AbortSignal;
  settled: boolean;
  resolve: (content: string) => void;
  reject: (err: unknown) => void;
  onAbort?: () => void;
  // Force-kill watchdog armed after we send an interrupt. See `interrupt()`.
  watchdog: ReturnType<typeof setTimeout> | null;
}

interface PendingControl {
  subtype: string;
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ControlRequest =
  | { subtype: "interrupt" }
  | { subtype: "set_model"; model?: string }
  | {
      subtype: "apply_flag_settings";
      settings: { effortLevel: string | null };
    }
  | { subtype: "get_context_usage" };

export interface ClaudeSessionOpts {
  sandboxClient: Pick<SandboxApi, "execStream">;
  vmId: string;
  // Fully-formed `claude -p …` command, including `--input-format stream-json`
  // and any `--resume <id>`. Fixed for the life of the process.
  command: string;
  model: string;
  effort: string | undefined;
  // Called exactly once when the process ends (clean exit, crash, or
  // force-kill) so the backend can drop this session from its map.
  onExit: () => void;
  // How long to wait after sending an interrupt before force-killing the
  // process. A graceful interrupt normally winds the turn down in <100ms. This
  // only fires if the CLI wedges. Default 5s.
  interruptGraceMs?: number;
  // How long `shutdown()` waits for a graceful stdin-EOF exit before
  // force-killing. Default 5s.
  shutdownGraceMs?: number;
  // Bound for a correlated control request. Default 15s.
  controlTimeoutMs?: number;
}

// One long-lived `claude -p --input-format stream-json` process. User turns are
// pushed onto stdin as newline-delimited JSON. The process stays alive between
// turns (so background tasks it spawned survive) until `shutdown()` closes
// stdin or the process dies on its own.
export class ClaudeSession {
  readonly vmId: string;
  model: string;
  effort: string | undefined;

  private readonly opts: ClaudeSessionOpts;
  private readonly interruptGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly controlTimeoutMs: number;

  private readonly stdin = new PushQueue<Buffer>();
  // The process is force-killed by aborting this, which closes the underlying WS,
  // which the sandbox turns into a SIGKILL of the child. Distinct from the
  // per-turn AbortSignal the caller passes (that one triggers a *graceful*
  // interrupt, not a kill).
  private readonly processAbort = new AbortController();

  private started = false;
  private dead = false;
  private sessionId: string | undefined;
  private stderr = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private active: ActiveTurn | null = null;
  private processPromise: Promise<{ exitCode: number }> | null = null;
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private controlSeq = 0;
  private readonly pendingControls = new Map<string, PendingControl>();

  constructor(opts: ClaudeSessionOpts) {
    this.opts = opts;
    this.vmId = opts.vmId;
    this.model = opts.model;
    this.effort = opts.effort;
    this.interruptGraceMs = opts.interruptGraceMs ?? 5_000;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? 5_000;
    this.controlTimeoutMs = opts.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  }

  isDead(): boolean {
    return this.dead;
  }

  // Start the process WITHOUT a turn, so it's already booted (bundle loaded,
  // auth checked, system prompt set) by the time the first runTurn pushes a
  // message. Used to pre-warm titling sessions, since the whole point is to move the
  // ~1.5-3s of process startup off the latency path of the actual title.
  // Idempotent and safe to call before any turn.
  warmUp(): void {
    if (!this.started && !this.dead) this.start();
  }

  // Run one user turn on this process. Resolves with the assistant content when
  // the CLI emits its `result` event. Rejects if the process dies mid-turn.
  // If the caller's signal aborts, the turn is *interrupted* (not killed) and
  // this rejects with an AbortError once the CLI winds down, leaving the
  // process alive and reusable for the next turn.
  async runTurn(opts: {
    userText: string;
    signal?: AbortSignal;
    hooks: TurnHooks;
  }): Promise<{ content: string; sessionId?: string }> {
    if (this.dead) throw new Error("claude session is no longer alive");
    if (this.active) throw new Error("a turn is already in progress for this session");
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

    const turnPromise = new Promise<string>((resolve, reject) => {
      this.active = {
        hooks: opts.hooks,
        signal: opts.signal,
        settled: false,
        resolve,
        reject,
        watchdog: null,
      };
    });
    const active = this.active!;

    if (opts.signal) {
      const onAbort = () => this.interrupt();
      active.onAbort = onAbort;
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Start the process lazily on the first turn, and only *after* `active`
    // is set, so synchronously-delivered events (in tests, and in principle a
    // very fast first chunk) always have a turn to land on.
    if (!this.started) this.start();

    this.writeUserMessage(opts.userText);

    try {
      const content = await turnPromise;
      // A late-arriving abort (e.g. the hub's idle-grace timer firing just as
      // the turn finishes) should still surface as a cancel, not a success.
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return { content, sessionId: this.sessionId };
    } catch (err) {
      // If we were aborting, normalize whatever ended the turn (graceful
      // interrupt result, or a watchdog force-kill rejection) into the same
      // AbortError the old kill-the-process path produced, so app.ts's
      // cancellation branch is unchanged.
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      throw err;
    } finally {
      if (opts.signal && active.onAbort) {
        opts.signal.removeEventListener("abort", active.onAbort);
      }
      if (active.watchdog) {
        clearTimeout(active.watchdog);
        active.watchdog = null;
      }
      this.active = null;
    }
  }

  // Update launch-time choices without replacing the process. The CLI applies
  // these controls to subsequent turns, so callers invoke this only while the
  // session is idle. Keeping the process preserves background commands and
  // other in-memory state that a --resume restart would lose.
  async reconfigure(model: string, effort: string | undefined): Promise<void> {
    if (this.active) throw new Error("cannot reconfigure claude during an active turn");
    if (model !== this.model) {
      await this.sendControl({ subtype: "set_model", model });
      this.model = model;
    }
    if (effort !== this.effort) {
      await this.sendControl({
        subtype: "apply_flag_settings",
        settings: { effortLevel: effort ?? null },
      });
      this.effort = effort;
    }
  }

  // Return the structured data behind /context from this live process. This
  // avoids spawning and resuming a second CLI, and avoids parsing a Markdown
  // rendering whose formatting is not an API.
  async getContextUsage(): Promise<Record<string, unknown>> {
    if (this.active) throw new Error("cannot probe claude context during an active turn");
    return this.sendControl({ subtype: "get_context_usage" });
  }

  // Graceful shutdown: close stdin so the CLI drains the current turn (if any)
  // and exits, killing its background tasks. Force-kills if it doesn't exit
  // within the grace window. Safe to call more than once.
  async shutdown(): Promise<void> {
    if (this.dead) {
      this.stdin.end();
      return;
    }
    this.stdin.end();
    if (this.started) {
      this.shutdownTimer = setTimeout(() => {
        this.processAbort.abort();
      }, this.shutdownGraceMs);
      this.shutdownTimer.unref?.();
      try {
        await this.processPromise;
      } catch {
        // Exit is reported via onProcessEnd. A rejected processPromise (e.g.
        // WS dropped) is not a shutdown failure from the caller's view.
      }
    }
  }

  private start(): void {
    this.started = true;
    this.processPromise = this.opts.sandboxClient.execStream(this.vmId, this.opts.command, {
      stdin: this.stdin,
      signal: this.processAbort.signal,
      stdout: (chunk: Buffer) => this.onStdout(chunk),
      stderr: (chunk: Buffer) => {
        this.appendStderr(this.stderrDecoder.write(chunk));
      },
    });
    this.processPromise
      .then(({ exitCode }) => this.onProcessEnd(exitCode, undefined))
      .catch((err) => this.onProcessEnd(undefined, err));
  }

  private writeUserMessage(text: string): void {
    if (this.dead) return;
    this.stdin.push(
      Buffer.from(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
        }) + "\n",
      ),
    );
  }

  // Ask the CLI to abandon the in-flight turn. It acks with a
  // `control_response` (swallowed in handleLine), injects a synthetic
  // `[Request interrupted by user]` user turn, and ends the turn with a
  // `result` whose subtype is `error_during_execution`, at which point the
  // turn settles and runTurn throws AbortError. The process stays alive.
  private interrupt(): void {
    const active = this.active;
    if (this.dead || !active || active.settled) return;
    void this.sendControl({ subtype: "interrupt" }).catch(() => {
      // The turn result or force-kill watchdog below is authoritative for the
      // caller. A missing interrupt acknowledgement must not become an
      // unhandled rejection.
    });
    // Safety net: if the CLI doesn't wind the turn down, force-kill so the
    // caller's turn can't hang forever. This kills background tasks too, but
    // only as a last resort when the graceful interrupt didn't take.
    active.watchdog = setTimeout(() => {
      if (this.active === active && !active.settled) this.processAbort.abort();
    }, this.interruptGraceMs);
    active.watchdog.unref?.();
  }

  private onStdout(chunk: Buffer): void {
    this.lineBuffer += this.stdoutDecoder.write(chunk);
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop()!;
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch (err) {
      this.active?.hooks.onNonJsonLine(line, err);
      return;
    }

    if (event.type === "control_response") {
      this.handleControlResponse(event);
      return;
    }

    // Track the CLI's session id for the turn's return value (the backend
    // separately persists it from the same event).
    if (
      event.type === "system" &&
      event.subtype === "init" &&
      typeof event.session_id === "string"
    ) {
      this.sessionId = event.session_id;
    }

    const active = this.active;
    if (!active) return; // event with no turn in flight, nothing to attribute it to

    try {
      active.hooks.onEvent(event);
    } catch (err) {
      console.warn("[claude-session] turn event handler threw:", err);
    }

    // `result` is the terminal event of a turn (one per turn, even across tool
    // roundtrips). The backend's onEvent has already run its result accounting
    // above, so getContent() now reflects the final assistant text.
    if (event.type === "result") {
      const hooks = active.hooks;
      this.settleTurn(active, () => active.resolve(hooks.getContent()));
    }
  }

  private settleTurn(active: ActiveTurn, fn: () => void): void {
    if (active.settled) return;
    active.settled = true;
    if (active.watchdog) {
      clearTimeout(active.watchdog);
      active.watchdog = null;
    }
    fn();
  }

  private sendControl(request: ControlRequest): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(new Error("claude session is no longer alive"));
    if (!this.started) this.start();

    const requestId = `ctrl-${++this.controlSeq}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(new Error(`claude control request timed out: ${request.subtype}`));
      }, this.controlTimeoutMs);
      timer.unref?.();
      this.pendingControls.set(requestId, {
        subtype: request.subtype,
        resolve,
        reject,
        timer,
      });
      this.stdin.push(
        Buffer.from(
          JSON.stringify({
            type: "control_request",
            request_id: requestId,
            request,
          }) + "\n",
        ),
      );
    });
  }

  private handleControlResponse(event: Record<string, unknown>): void {
    const response = event.response;
    if (!response || typeof response !== "object") return;
    const body = response as Record<string, unknown>;
    const requestId = body.request_id;
    if (typeof requestId !== "string") return;
    const pending = this.pendingControls.get(requestId);
    if (!pending) return;
    this.pendingControls.delete(requestId);
    clearTimeout(pending.timer);

    if (body.subtype === "error") {
      const detail = typeof body.error === "string" ? `: ${body.error}` : "";
      pending.reject(new Error(`claude control request failed (${pending.subtype})${detail}`));
      return;
    }
    if (body.subtype !== "success") {
      pending.reject(new Error(`invalid claude control response (${pending.subtype})`));
      return;
    }
    const result = body.response;
    pending.resolve(
      result && typeof result === "object" ? (result as Record<string, unknown>) : {},
    );
  }

  private appendStderr(text: string): void {
    if (!text) return;
    this.stderr = (this.stderr + text).slice(-MAX_STDERR_CHARS);
  }

  private rejectPendingControls(err: Error): void {
    for (const pending of this.pendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingControls.clear();
  }

  private onProcessEnd(exitCode: number | undefined, err: unknown): void {
    if (this.dead) return;
    this.lineBuffer += this.stdoutDecoder.end();
    if (this.lineBuffer.trim()) this.handleLine(this.lineBuffer);
    this.lineBuffer = "";
    this.appendStderr(this.stderrDecoder.end());
    this.dead = true;
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
    // Release the stdin iterator so execStream's stdin pump isn't left parked.
    this.stdin.end();

    const message = err
      ? err instanceof Error
        ? err.message
        : String(err)
      : `claude exited with code ${exitCode}${this.stderr ? `: ${this.stderr.trim()}` : ""}`;
    this.rejectPendingControls(new Error(message));

    const active = this.active;
    if (active && !active.settled) {
      // The process died with a turn still streaming. Surface it the same way
      // the old per-turn process exit did (`claude exited with code N`), so the
      // failure isn't mistaken for a clean turn.
      this.settleTurn(active, () => active.reject(new Error(message)));
    }

    this.opts.onExit();
  }
}
