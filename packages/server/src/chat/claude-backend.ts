import type { ChatManager } from "../chats";
import { type ChatEffort, type ContextBreakdown, findChatModel } from "../contracts";
import { KeyedQueue } from "../keyed-queue";
import type { SandboxApi } from "../sandbox-client";
import {
  type ChatBackend,
  type ChatEvent,
  emptyUsage,
  type TokenUsage,
  type TurnMeta,
} from "./backend";
import { ClaudeSession, type TurnHooks } from "./claude-session";
import {
  buildTitleCommand,
  buildTitlePrompt,
  buildTitleSessionCommand,
  cleanTitle,
  parseTitleResult,
  TITLE_MODEL,
} from "./title-generator";

const CLAUDE_EFFORTS = new Set<ChatEffort>(["low", "medium", "high", "xhigh", "max"]);

// Bound on a single warm-session title turn. The cold one-shot path had a 20s
// exec timeout. The persistent session has no built-in timeout, so we cap the
// turn with an abort signal and fall back to the one-shot if it's exceeded.
const TITLE_TURN_TIMEOUT_MS = 20_000;
// The `/clear` reset turn is a local CLI op (~10ms), so a few seconds is ample, and
// a wedged reset must not block the next title's turn behind it.
const TITLE_RESET_TIMEOUT_MS = 5_000;

// How long a chat's persistent `claude` process may sit idle (no turns) before
// it's reaped. Keeping it alive is what lets background tasks survive between
// turns. Reaping bounds how many idle CLI processes can pile up across many
// abandoned chats. The window is generous on purpose. A user reading a long
// answer before replying shouldn't lose their warm process and its background
// jobs.
const DEFAULT_SESSION_IDLE_MS = 15 * 60_000;

export class ClaudeBackend implements ChatBackend {
  // Anthropic only reports per-turn usage. codex maintains the running total
  // on the wire. We mirror codex by accumulating across turns per chat so the
  // unified `usage` event always carries both `last` and `total`. Cleared when
  // a chat starts without a resumable Claude session.
  private chatTotals = new Map<string, TokenUsage>();
  // Same story for cost: Claude's `total_cost_usd` reports the cost of the
  // current turn only, so we sum it across turns ourselves.
  private chatCosts = new Map<string, number>();

  // One long-lived `claude -p --input-format stream-json` process per chat.
  // Reused across turns so the conversation (and any background tasks the
  // agent spawned) persist. Model and effort changes are applied through the
  // CLI control protocol. A process is recreated only when it dies, moves to
  // another VM, or rejects a control request.
  private sessions = new Map<string, ClaudeSession>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleMs: number;

  // One long-lived titling process per titling VM (keyed by vmId, NOT chatId,
  // because a profile's titling VM is shared across its chats). Pre-warmed by
  // TitleVmManager when the VM is created, so a title is just an inference turn
  // with no CLI startup. Reaped with the VM in disposeForVm. Independent of the
  // per-chat `sessions` above (different command: lean, no tools, no resume).
  private titleSessions = new Map<string, ClaudeSession>();
  // Per-VM serialization: ClaudeSession runs one turn at a time, and the titling
  // VM is shared, so two first-messages racing must queue rather than collide.
  private titleQueue = new KeyedQueue();

  constructor(
    private sandboxClient: SandboxApi,
    private chatManager: ChatManager,
    opts: { idleMs?: number } = {},
  ) {
    this.idleMs = opts.idleMs ?? DEFAULT_SESSION_IDLE_MS;
  }

  resetTotals(chatId: string) {
    this.chatTotals.delete(chatId);
    this.chatCosts.delete(chatId);
  }

  // Shut down the persistent process for one chat (chat deleted). Closes stdin
  // so the CLI drains and exits, taking its background tasks with it.
  disposeChat(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    this.sessions.delete(chatId);
    this.clearIdle(chatId);
    void session.shutdown();
  }

  // Shut down every persistent process running in a VM (instance restart /
  // delete). The processes live inside the VM and would die with it anyway,
  // tearing them down proactively avoids a dead session lingering in the map
  // until the next turn. Mirrors codexManager.close(vmId).
  disposeForVm(vmId: string): void {
    for (const [chatId, session] of this.sessions) {
      if (session.vmId === vmId) this.disposeChat(chatId);
    }
    const titleSession = this.titleSessions.get(vmId);
    if (titleSession) {
      this.titleSessions.delete(vmId);
      void titleSession.shutdown();
    }
  }

  // Pre-warm a titling process for a VM so the first title pays no CLI startup.
  // Called by TitleVmManager once a titling VM is ready. Idempotent and
  // best-effort: a failed start just means the next generateTitle falls back to
  // a cold one-shot (or re-warms). No-op if a live titling session already
  // exists for the VM.
  warmTitleSession(vmId: string): void {
    const existing = this.titleSessions.get(vmId);
    if (existing && !existing.isDead()) return;
    try {
      const session = this.createTitleSession(vmId);
      this.titleSessions.set(vmId, session);
      session.warmUp();
    } catch (err) {
      console.warn(`[title] warm-up failed for vmId=${vmId}:`, err);
      this.titleSessions.delete(vmId);
    }
  }

  private createTitleSession(vmId: string): ClaudeSession {
    const session: ClaudeSession = new ClaudeSession({
      sandboxClient: this.sandboxClient,
      vmId,
      command: buildTitleSessionCommand(TITLE_MODEL),
      model: TITLE_MODEL,
      effort: undefined,
      onExit: () => {
        if (this.titleSessions.get(vmId) === session) this.titleSessions.delete(vmId);
      },
    });
    return session;
  }

  async sendMessage(opts: {
    vmId: string;
    chatId: string;
    message: string;
    model: string;
    effort: ChatEffort;
    sessionId?: string;
    fork?: { anchorId: string }; // anchorId = transcript uuid to resume at
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onEvent?: (event: ChatEvent) => void;
    onMeta?: (meta: TurnMeta) => void;
  }): Promise<{ content: string; sessionId?: string }> {
    // Claude CLI accepts: low | medium | high | xhigh | max. Other values
    // from the union (none/minimal, which are codex-only) are dropped. The model
    // falls back to its own default.
    const claudeEffort = CLAUDE_EFFORTS.has(opts.effort) ? opts.effort : undefined;
    // Forking only means anything against a resumable session. (The turn
    // service never sends one without the other, so this is just a guard.)
    const fork = opts.sessionId ? opts.fork : undefined;

    let session = this.sessions.get(opts.chatId);
    if (session && (fork !== undefined || session.isDead() || session.vmId !== opts.vmId)) {
      // A dead or wrong-VM session can't be reused. A fork turn also always
      // retires the live process: there is no control request to rewind a
      // live conversation, so it's positioned at the old branch's tail, and
      // the resume-at/fork flags only exist at launch. (Model/effort changes,
      // by contrast, apply to the live process via reconfigure below.)
      this.sessions.delete(opts.chatId);
      this.clearIdle(opts.chatId);
      if (!session.isDead()) void session.shutdown();
      session = undefined;
    }

    if (session) {
      // Don't let an idle timer retire the process while a control request is
      // waiting for its correlated response.
      this.clearIdle(opts.chatId);
      if (session.model !== opts.model || session.effort !== claudeEffort) {
        try {
          await session.reconfigure(opts.model, claudeEffort);
        } catch (err) {
          // Older or incompatible CLI versions may reject a control. Preserve
          // compatibility by falling back to the old resume-and-restart path.
          console.warn("[claude] live model/effort update failed, restarting session:", err);
          if (this.sessions.get(opts.chatId) === session) {
            this.sessions.delete(opts.chatId);
          }
          if (!session.isDead()) void session.shutdown();
          session = undefined;
        }
      }
    }

    if (!session) {
      // No resume id → brand new session, so the running totals from any
      // previous chat under this id are stale.
      if (!opts.sessionId) this.resetTotals(opts.chatId);
      const created = this.createChatSession(
        opts.chatId,
        opts.vmId,
        opts.model,
        claudeEffort,
        opts.sessionId,
        fork,
      );
      this.sessions.set(opts.chatId, created);
      session = created;
    }

    // Don't let the idle reaper fire while a turn is running. A long turn
    // (minutes) must not trip the timer and force-kill its own process
    // mid-stream. We re-arm once the turn settles.
    this.clearIdle(opts.chatId);

    const hooks = this.buildTurnHooks(opts);
    try {
      const result = await session.runTurn({
        userText: opts.message,
        signal: opts.signal,
        hooks,
      });
      return {
        content: result.content,
        sessionId: result.sessionId ?? opts.sessionId,
      };
    } finally {
      // Re-arm the idle reaper only if this exact session is still the live
      // one and didn't die during the turn (onExit already cleaned that up).
      if (this.sessions.get(opts.chatId) === session && !session.isDead()) {
        this.armIdle(opts.chatId, session);
      }
    }
  }

  private buildCommand(
    model: string,
    effort: string | undefined,
    resumeSessionId: string | undefined,
    fork?: { anchorId: string },
  ): string {
    const args = [
      "claude",
      "-p",
      // Realtime streaming input: lets one process span many turns (push each
      // user message as newline-delimited JSON) and accept interrupt control
      // messages mid-turn.
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Headless `-p` defaults to NOT requesting thinking summaries: since
      // ~v2.1.8 the CLI only flips the display to "summarized" in interactive
      // mode, so stream-json emits thinking blocks with a signature but no
      // text and zero thinking_delta events, starving the parser below
      // (content_block_delta(thinking_delta), ~L565). The `showThinkingSummaries`
      // setting is gated to interactive too. This undocumented flag is the only
      // lever that sets the display unconditionally, so the thinking text
      // actually streams in headless mode.
      "--thinking-display",
      "summarized",
      "--model",
      model,
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      // Disallowed tools. `--disallowedTools` is variadic (space/comma
      // separated) and is a hard removal, not a permission prompt, so it still
      // takes effect under `--dangerously-skip-permissions` above.
      //
      // AskUserQuestion is an interactive built-in tool the CLI resolves
      // itself. In headless `-p` mode there's no UI to present the picker, so
      // the CLI auto-fails the call with an `is_error` result ("Answer
      // questions?"). stream-json input doesn't help, because the CLI owns the
      // tool_use_id and rejects any client answer before it lands, so all the
      // call does is burn a turn and produce an apologetic "awaiting your
      // response" reply. Disallow it so the model never reaches for it.
      //
      // Agent/Task/Workflow are the subagent-spawning and orchestration tools.
      // isolade runs one coding agent per chat in its own VM, and we want that
      // agent doing the work inline in its main loop, not fanning out to
      // subagents whose token cost and output we don't surface and that the
      // `--resume` conversation can't introspect. `Agent` is the canonical
      // spawner (`Task` is a legacy alias for it) and `Workflow` orchestrates
      // fleets of subagents. Denying both closes every fan-out path (blocking
      // just one lets the model fall back to the other), and background
      // subagents are launched through `Agent` too, so they're covered.
      //
      // Deliberately NOT denied: background shell commands, which run through
      // the `Bash` tool (`run_in_background: true`, output read back with
      // `Read`), a separate path we rely on and keep working. The
      // `TaskCreate`/`TaskUpdate` family is the model's todo/plan tracker, not
      // a subagent launcher, so it stays enabled as well.
      "--disallowedTools",
      "AskUserQuestion",
      "Agent",
      "Task",
      "Workflow",
    ];
    if (effort) {
      args.push("--effort", effort);
    }
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    if (resumeSessionId && fork) {
      // Recompute from an earlier point (an edited message): resume the
      // session only up to and including the anchored assistant message,
      // and fork that prefix into a NEW session id instead of appending.
      // The source session's file stays intact, which is what keeps the
      // original branch continuable. The CLI reports the forked id in its
      // `system/init` event, and the turn hooks below pick it up from there.
      args.push("--resume-session-at", fork.anchorId, "--fork-session");
    }
    return args.join(" ");
  }

  private createChatSession(
    chatId: string,
    vmId: string,
    model: string,
    effort: string | undefined,
    sessionId: string | undefined,
    fork?: { anchorId: string },
  ): ClaudeSession {
    const created = new ClaudeSession({
      sandboxClient: this.sandboxClient,
      vmId,
      command: this.buildCommand(model, effort, sessionId, fork),
      model,
      effort,
      onExit: () => {
        // The process ended on its own (VM restart, crash, idle reap that
        // already closed stdin). Drop it so the next turn starts fresh.
        if (this.sessions.get(chatId) === created) {
          this.sessions.delete(chatId);
          this.clearIdle(chatId);
        }
      },
    });
    return created;
  }

  private armIdle(chatId: string, session: ClaudeSession): void {
    this.clearIdle(chatId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(chatId);
      if (this.sessions.get(chatId) === session) {
        this.sessions.delete(chatId);
        void session.shutdown();
      }
    }, this.idleMs);
    timer.unref?.();
    this.idleTimers.set(chatId, timer);
  }

  private clearIdle(chatId: string): void {
    const timer = this.idleTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(chatId);
    }
  }

  // Build the per-turn event handler for one `runTurn`. This is the Claude CLI
  // stream-json parser: it owns delta streaming, tool-call/thinking assembly,
  // and the token/cost accounting. The session feeds it each parsed event and
  // reads `getContent()` when the turn's `result` event lands.
  private buildTurnHooks(opts: {
    chatId: string;
    model: string;
    onDelta: (text: string) => void;
    onEvent?: (event: ChatEvent) => void;
    onMeta?: (meta: TurnMeta) => void;
  }): TurnHooks {
    let fullContent = "";
    // Per-turn state for assembling streaming content blocks. Anthropic
    // streams tool args as content_block_delta(input_json_delta) and
    // thinking text as content_block_delta(thinking_delta), both keyed by
    // content_block index. We accumulate per index and flush on the matching
    // content_block_stop with a single typed event.
    const toolIndexToId = new Map<number, string>();
    const toolInputBuffers = new Map<string, string>();
    const thinkingBuffers = new Map<number, string>();

    // Per-turn usage assembly. Anthropic sends input/cache counts on
    // `message_start.message.usage` and incrementally updates output_tokens
    // through `message_delta.usage`. We track the current turn's tallies
    // and re-emit `usage` whenever either changes so the UI gauge ticks
    // live during streaming.
    // `turnUsage` tracks the LATEST sub-call's usage (a turn with tool use
    // produces one sub-call per roundtrip). Each `message_start` replaces it,
    // `message_delta` increments output_tokens. We deliberately do NOT merge
    // the `result` envelope's `usage` into this, because that field sums across
    // every sub-call in the turn, which over-counts `cache_read_input_tokens`
    // by ~N× for N sub-calls (the same cached conversation prefix is billed
    // every roundtrip). For the context-pressure bar, the LAST sub-call's
    // prompt size is what we want. For billing totals, see `turnTotal` below.
    let turnUsage: TokenUsage = emptyUsage();
    const modelWindow = findChatModel(opts.model)?.contextWindow;
    const emitUsage = (turnCostUsd?: number, turnTotalForChat?: TokenUsage) => {
      const prev = this.chatTotals.get(opts.chatId) ?? emptyUsage();
      const prevCost = this.chatCosts.get(opts.chatId) ?? 0;
      // `total` is the running sum across turns. During streaming we use the
      // latest sub-call as an estimate of "this turn's billable"; at the
      // final `result` event we override with the CLI's authoritative
      // turn-cumulative count so the persisted total reflects every
      // sub-call's tokens, not just the last one.
      const turnBillable = turnTotalForChat ?? turnUsage;
      const total: TokenUsage = {
        inputTokens: prev.inputTokens + turnBillable.inputTokens,
        cachedInputTokens: prev.cachedInputTokens + turnBillable.cachedInputTokens,
        cacheCreationInputTokens:
          prev.cacheCreationInputTokens + turnBillable.cacheCreationInputTokens,
        outputTokens: prev.outputTokens + turnBillable.outputTokens,
        reasoningOutputTokens: prev.reasoningOutputTokens + turnBillable.reasoningOutputTokens,
        totalTokens: prev.totalTokens + turnBillable.totalTokens,
      };
      // During streaming we don't yet know this turn's cost, so emit the
      // accumulated cost from prior turns so the gauge doesn't blink off
      // mid-turn. The final `result` envelope supplies turnCostUsd and we
      // emit prev+turn one last time before rolling it into chatCosts.
      const costUsd =
        turnCostUsd != null ? prevCost + turnCostUsd : prevCost > 0 ? prevCost : undefined;
      opts.onEvent?.({
        type: "usage",
        last: turnUsage,
        total,
        modelContextWindow: modelWindow,
        costUsd,
      });
    };
    // Anthropic's `usage` object across message_start / message_delta / result.
    // Fields we read:
    //   input_tokens               : fresh prompt tokens billed this turn
    //   cache_read_input_tokens    : tokens served from the prompt cache
    //   cache_creation_input_tokens : tokens written to the prompt cache
    //   output_tokens              : assistant output so far
    // Cache reads and writes are tracked in separate buckets because they
    // have different billing rates and different rate-limit weights. See
    // the TokenUsage doc above.
    const mergeUsage = (u: Record<string, unknown> | undefined) => {
      if (!u || typeof u !== "object") return false;
      let changed = false;
      const setIfNum = (key: keyof TokenUsage, val: unknown) => {
        if (typeof val === "number" && val !== turnUsage[key]) {
          turnUsage = { ...turnUsage, [key]: val };
          changed = true;
        }
      };
      setIfNum("inputTokens", u.input_tokens);
      setIfNum("outputTokens", u.output_tokens);
      // message_delta usually omits cache fields, so only overwrite when
      // present so we don't reset to 0 mid-turn.
      if (typeof u.cache_read_input_tokens === "number") {
        setIfNum("cachedInputTokens", u.cache_read_input_tokens);
      }
      if (typeof u.cache_creation_input_tokens === "number") {
        setIfNum("cacheCreationInputTokens", u.cache_creation_input_tokens);
      }
      const total =
        turnUsage.inputTokens +
        turnUsage.cachedInputTokens +
        turnUsage.cacheCreationInputTokens +
        turnUsage.outputTokens +
        turnUsage.reasoningOutputTokens;
      if (total !== turnUsage.totalTokens) {
        turnUsage = { ...turnUsage, totalTokens: total };
        changed = true;
      }
      return changed;
    };
    // Top-level message envelope events from the CLI (message_start/delta/
    // stop, content_block_start/stop for text) and the echoed `assistant`
    // record are protocol scaffolding. Text comes through deltas, tool
    // results come through `user` blocks. Suppress them entirely.
    const isEnvelopeNoise = (inner: { type?: unknown; content_block?: unknown }) => {
      if (
        inner.type === "message_start" ||
        inner.type === "message_delta" ||
        inner.type === "message_stop"
      ) {
        return true;
      }
      const block = inner.content_block as { type?: unknown } | undefined;
      const blockType = block?.type;
      if (
        (inner.type === "content_block_start" || inner.type === "content_block_stop") &&
        (blockType === "text" || blockType === undefined)
      ) {
        return true;
      }
      return false;
    };

    const onEvent = (event: any) => {
      let handled = false;

      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        this.chatManager.updateSessionId(opts.chatId, event.session_id);
        // Session-level fact for the turn's message row: on a fork this is
        // the freshly minted session id, and reporting it here (not just on
        // success) keeps even interrupted turns forkable later.
        opts.onMeta?.({ sessionId: event.session_id });
        handled = true;
      }

      // The CLI emits `system/api_retry` while it backs off after a
      // failed API call. error_status is the HTTP status (when there
      // was one). error is a short string like "unknown" / "overloaded".
      if (event.type === "system" && event.subtype === "api_retry") {
        const attempt = typeof event.attempt === "number" ? event.attempt : 0;
        const maxRetries = typeof event.max_retries === "number" ? event.max_retries : 0;
        const retryDelayMs = typeof event.retry_delay_ms === "number" ? event.retry_delay_ms : 0;
        const errorStatus = typeof event.error_status === "number" ? event.error_status : null;
        const error = typeof event.error === "string" ? event.error : null;
        opts.onEvent?.({
          type: "api_retry",
          attempt,
          maxRetries,
          retryDelayMs,
          errorStatus,
          error,
        });
        handled = true;
      }

      if (event.type === "stream_event") {
        const inner = event.event;
        if (
          inner?.type === "content_block_delta" &&
          inner?.delta?.type === "text_delta" &&
          inner?.delta?.text
        ) {
          opts.onDelta(inner.delta.text);
          fullContent += inner.delta.text;
          handled = true;
        } else if (
          inner?.type === "content_block_start" &&
          inner?.content_block?.type === "tool_use" &&
          typeof inner.content_block.id === "string" &&
          typeof inner.content_block.name === "string" &&
          typeof inner.index === "number"
        ) {
          const id = inner.content_block.id as string;
          const name = inner.content_block.name as string;
          toolIndexToId.set(inner.index, id);
          toolInputBuffers.set(id, "");
          opts.onEvent?.({ type: "tool_call_start", id, name });
          handled = true;
        } else if (
          inner?.type === "content_block_start" &&
          inner?.content_block?.type === "thinking" &&
          typeof inner.index === "number"
        ) {
          thinkingBuffers.set(inner.index, "");
          handled = true;
        } else if (
          inner?.type === "content_block_delta" &&
          inner?.delta?.type === "input_json_delta" &&
          typeof inner.index === "number"
        ) {
          const id = toolIndexToId.get(inner.index);
          if (id !== undefined) {
            const partial =
              typeof inner.delta.partial_json === "string" ? inner.delta.partial_json : "";
            toolInputBuffers.set(id, (toolInputBuffers.get(id) ?? "") + partial);
          }
          handled = true;
        } else if (
          inner?.type === "content_block_delta" &&
          inner?.delta?.type === "thinking_delta" &&
          typeof inner.index === "number" &&
          thinkingBuffers.has(inner.index)
        ) {
          const text = typeof inner.delta.thinking === "string" ? inner.delta.thinking : "";
          thinkingBuffers.set(inner.index, (thinkingBuffers.get(inner.index) ?? "") + text);
          handled = true;
        } else if (
          inner?.type === "content_block_stop" &&
          typeof inner.index === "number" &&
          toolIndexToId.has(inner.index)
        ) {
          const id = toolIndexToId.get(inner.index)!;
          const raw = toolInputBuffers.get(id) ?? "";
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? {} : JSON.parse(raw);
          } catch (err) {
            // The CLI streamed an `input_json_delta` chain that
            // doesn't parse as JSON when joined. This is a
            // claude-side bug, so preserve the raw bytes so the
            // user sees something useful in the tool card
            // instead of an empty object, and warn so it shows
            // up in server logs.
            console.warn(
              `[claude] tool input not valid JSON (chat=${opts.chatId} tool=${id} bytes=${raw.length}):`,
              err,
            );
            parsed = { __raw: raw, __parseError: String(err) };
          }
          opts.onEvent?.({ type: "tool_call_input", id, input: parsed });
          toolIndexToId.delete(inner.index);
          toolInputBuffers.delete(id);
          handled = true;
        } else if (
          inner?.type === "content_block_stop" &&
          typeof inner.index === "number" &&
          thinkingBuffers.has(inner.index)
        ) {
          const text = thinkingBuffers.get(inner.index) ?? "";
          if (text.length > 0) opts.onEvent?.({ type: "thinking", text });
          thinkingBuffers.delete(inner.index);
          handled = true;
        } else if (
          inner?.type === "content_block_delta" &&
          inner?.delta?.type === "signature_delta"
        ) {
          // Cryptographic signatures attached to thinking blocks have
          // no UI value on their own.
          handled = true;
        } else if (inner?.type === "message_start" && inner?.message?.usage) {
          if (mergeUsage(inner.message.usage as Record<string, unknown>)) {
            emitUsage();
          }
          handled = true;
        } else if (inner?.type === "message_delta" && inner?.usage) {
          if (mergeUsage(inner.usage as Record<string, unknown>)) {
            emitUsage();
          }
          handled = true;
        } else if (
          inner &&
          typeof inner === "object" &&
          isEnvelopeNoise(inner as Record<string, unknown>)
        ) {
          handled = true;
        }
      }

      // Top-level `assistant` events echo the final assembled message.
      // We already streamed it via deltas, so they produce no UI event. But
      // their transcript `uuid` is this turn's fork anchor: the LAST
      // assistant message's uuid is exactly what `--resume-session-at`
      // needs to replay the session "through this turn". Later events
      // overwrite earlier ones (a turn with tool use echoes one assistant
      // message per roundtrip), so what sticks is the turn's end.
      if (event.type === "assistant") {
        if (typeof event.uuid === "string" && event.uuid.length > 0) {
          opts.onMeta?.({ anchorId: event.uuid });
        }
        handled = true;
      }

      // Tool results come back from the runtime as a follow-up `user`
      // message in the next turn's stream. The CLI echoes them as
      // top-level user events with content blocks of type tool_result.
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content as unknown[]) {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "tool_result"
          ) {
            const tr = block as {
              tool_use_id?: unknown;
              content?: unknown;
              is_error?: unknown;
            };
            if (typeof tr.tool_use_id === "string") {
              const output = stringifyToolResultContent(tr.content);
              opts.onEvent?.({
                type: "tool_call_result",
                id: tr.tool_use_id,
                output,
                isError: tr.is_error === true,
              });
            }
          }
        }
        handled = true;
      }

      if (event.type === "result") {
        if (event.result) {
          fullContent = event.result;
        }
        // The final `result` envelope carries the turn-cumulative
        // billable token counts (summed across every sub-call this turn
        // produced) plus total_cost_usd. We keep `turnUsage` pointing
        // at the latest sub-call so the emitted `last` stays usable as
        // a context-pressure signal, and roll the cumulative figure
        // into chatTotals separately for accurate lifetime billing.
        const turnTotal = parseClaudeResultUsage(
          event.usage as Record<string, unknown> | undefined,
        );
        const turnCostUsd =
          typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined;
        emitUsage(turnCostUsd, turnTotal);
        const prev = this.chatTotals.get(opts.chatId) ?? emptyUsage();
        this.chatTotals.set(opts.chatId, {
          inputTokens: prev.inputTokens + turnTotal.inputTokens,
          cachedInputTokens: prev.cachedInputTokens + turnTotal.cachedInputTokens,
          cacheCreationInputTokens:
            prev.cacheCreationInputTokens + turnTotal.cacheCreationInputTokens,
          outputTokens: prev.outputTokens + turnTotal.outputTokens,
          reasoningOutputTokens: prev.reasoningOutputTokens + turnTotal.reasoningOutputTokens,
          totalTokens: prev.totalTokens + turnTotal.totalTokens,
        });
        if (turnCostUsd != null) {
          const prevCost = this.chatCosts.get(opts.chatId) ?? 0;
          this.chatCosts.set(opts.chatId, prevCost + turnCostUsd);
        }
        handled = true;
      }

      if (!handled) opts.onEvent?.({ type: "raw", source: "claude", payload: event });
    };

    const onNonJsonLine = (line: string, err: unknown) => {
      // A line from `claude -p --output-format stream-json`
      // didn't parse as JSON. This is exactly the "dumb stuff"
      // we want to know about: CLI bugs, mid-line truncation,
      // version skew. Surface it both in logs (server-side
      // diagnosis) and as a raw event (so the debug pane
      // shows what we couldn't make sense of).
      console.warn(
        `[claude] non-JSON line on stdout (chat=${opts.chatId}, ${line.length} bytes):`,
        err,
        line.slice(0, 200),
      );
      opts.onEvent?.({
        type: "raw",
        source: "claude",
        payload: { __nonJsonLine: line, __parseError: String(err) },
      });
    };

    return { onEvent, onNonJsonLine, getContent: () => fullContent };
  }

  // Ask the chat's persistent process for the structured data behind
  // `/context`. If the process was reaped while idle, resume it once and keep
  // that replacement as the chat's new live process.
  async probeContext(opts: {
    vmId: string;
    chatId: string;
    model: string;
    effort: ChatEffort;
    sessionId?: string;
  }): Promise<ContextBreakdown> {
    if (!opts.sessionId) {
      return {
        available: false,
        reason: "no session yet, send a message first",
      };
    }
    const claudeEffort = CLAUDE_EFFORTS.has(opts.effort) ? opts.effort : undefined;
    let session = this.sessions.get(opts.chatId);
    if (session && (session.isDead() || session.vmId !== opts.vmId)) {
      this.sessions.delete(opts.chatId);
      this.clearIdle(opts.chatId);
      if (!session.isDead()) void session.shutdown();
      session = undefined;
    }

    if (session) {
      this.clearIdle(opts.chatId);
      if (session.model !== opts.model || session.effort !== claudeEffort) {
        try {
          await session.reconfigure(opts.model, claudeEffort);
        } catch (err) {
          console.warn("[claude] live model/effort update failed during context probe:", err);
          if (this.sessions.get(opts.chatId) === session) {
            this.sessions.delete(opts.chatId);
          }
          if (!session.isDead()) void session.shutdown();
          session = undefined;
        }
      }
    }

    if (!session) {
      session = this.createChatSession(
        opts.chatId,
        opts.vmId,
        opts.model,
        claudeEffort,
        opts.sessionId,
      );
      this.sessions.set(opts.chatId, session);
    }

    try {
      const response = await session.getContextUsage();
      const breakdown = parseContextUsage(response);
      return breakdown ?? { available: false, reason: "invalid context usage response" };
    } finally {
      if (this.sessions.get(opts.chatId) === session && !session.isDead()) {
        this.armIdle(opts.chatId, session);
      }
    }
  }

  // Generate a short chat title via the in-VM `claude` CLI. Routed through the
  // CLI (not a direct Anthropic API call) so it uses the CLI's own auth + token
  // refresh. The host has no API key and must not call the Messages API
  // directly with the subscription OAuth token (see title-generator.ts).
  //
  // Fast path: a pre-warmed persistent stream-json process (one turn ~1.6s, no
  // CLI startup). Falls back to a cold one-shot `claude -p` if no warm session
  // is ready or the warm turn fails. Best-effort: returns null on any failure
  // and the caller falls back to a truncation of the first message. Serialized
  // per VM since the titling session (and VM) is shared across a profile's chats.
  async generateTitle(vmId: string, firstMessage: string): Promise<string | null> {
    return this.titleQueue.run(vmId, () => this.runTitle(vmId, firstMessage));
  }

  private async runTitle(vmId: string, firstMessage: string): Promise<string | null> {
    let session = this.titleSessions.get(vmId);
    if (!session || session.isDead()) {
      try {
        session = this.createTitleSession(vmId);
        this.titleSessions.set(vmId, session);
        session.warmUp();
      } catch {
        // Couldn't start a persistent session (e.g. no execStream), so fall back.
        if (session && this.titleSessions.get(vmId) === session) this.titleSessions.delete(vmId);
        session = undefined;
      }
    }
    if (session) {
      try {
        let resultText = "";
        await session.runTurn({
          userText: buildTitlePrompt(firstMessage),
          signal: AbortSignal.timeout(TITLE_TURN_TIMEOUT_MS),
          hooks: {
            onEvent: (event) => {
              if (event.type === "result" && typeof event.result === "string") {
                resultText = event.result;
              }
            },
            onNonJsonLine: () => {},
            getContent: () => resultText,
          },
        });
        // Reset the conversation so the NEXT title on this shared warm process
        // starts clean: independent titles, bounded context, without paying a
        // process restart. `/clear` is a local CLI op (~10ms, no model call), so
        // this is essentially free. Done before returning (and inside the per-VM
        // serialization) so the next title's turn can't collide with it.
        await this.resetTitleSession(vmId, session);
        const title = cleanTitle(resultText);
        if (title) return title;
      } catch (err) {
        console.warn("[title] warm session turn failed, falling back to one-shot:", err);
        // A timed-out / wedged session must not be reused, so retire it so the
        // next title warms a fresh one.
        if (this.titleSessions.get(vmId) === session) {
          this.titleSessions.delete(vmId);
          void session.shutdown();
        }
      }
    }
    return this.generateTitleOneShot(vmId, firstMessage);
  }

  // Clear the titling conversation between titles so each is independent, while
  // keeping the process warm. On failure, retire the session (the next title
  // warms a fresh, clean one) rather than risk reusing accumulated context.
  private async resetTitleSession(vmId: string, session: ClaudeSession): Promise<void> {
    try {
      await session.runTurn({
        userText: "/clear",
        signal: AbortSignal.timeout(TITLE_RESET_TIMEOUT_MS),
        hooks: {
          onEvent: () => {},
          onNonJsonLine: () => {},
          getContent: () => "",
        },
      });
    } catch {
      if (this.titleSessions.get(vmId) === session) {
        this.titleSessions.delete(vmId);
        void session.shutdown();
      }
    }
  }

  // Cold one-shot `claude -p`: the fallback when no warm session is available.
  private async generateTitleOneShot(vmId: string, firstMessage: string): Promise<string | null> {
    const command = buildTitleCommand(TITLE_MODEL, firstMessage);
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await this.sandboxClient.exec(vmId, command, {
        timeoutMs: 20_000,
      });
    } catch (err) {
      console.warn("[title] claude CLI exec failed:", err);
      return null;
    }
    if (result.exitCode !== 0) {
      console.warn(
        `[title] claude -p exited ${result.exitCode}${
          result.stderr ? `: ${result.stderr.trim().slice(0, 300)}` : ""
        }`,
      );
      return null;
    }
    return parseTitleResult(result.stdout);
  }
}

// Convert the CLI's stable structured control response into the existing API
// shape. `rawMaxTokens` is the full model context window used by `/context`
// for both its summary and category percentages. `maxTokens` may exclude the
// autocompact reserve, so it is not the denominator shown to users.
function parseContextUsage(response: Record<string, unknown>): ContextBreakdown | null {
  const totalTokens = finiteNonnegative(response.totalTokens);
  const contextWindow = finitePositive(response.rawMaxTokens);
  if (totalTokens == null || contextWindow == null) return null;

  const reportedPercent = finiteNonnegative(response.percentage);
  const rawCategories = Array.isArray(response.categories) ? response.categories : [];
  const categories = rawCategories.flatMap((category) => {
    if (!category || typeof category !== "object") return [];
    const value = category as Record<string, unknown>;
    const tokens = finiteNonnegative(value.tokens);
    if (typeof value.name !== "string" || tokens == null) return [];
    return [
      {
        name: value.name,
        tokens: Math.round(tokens),
        percent: Number(((tokens / contextWindow) * 100).toFixed(1)),
      },
    ];
  });

  return {
    available: true,
    totalTokens: Math.round(totalTokens),
    contextWindow: Math.round(contextWindow),
    percent: reportedPercent ?? Number(((totalTokens / contextWindow) * 100).toFixed(1)),
    categories,
  };
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Parse the `usage` object on Claude CLI's `result` envelope, which is the
// turn-cumulative billable counts (summed across every API call the CLI made
// to satisfy this user turn, one per tool roundtrip). Used only to advance
// the per-chat running total. It is emphatically NOT merged into the streaming
// `turnUsage`, since `cache_read_input_tokens` summed across sub-calls
// massively inflates what the UI shows as "context packed in".
function parseClaudeResultUsage(u: Record<string, unknown> | undefined): TokenUsage {
  if (!u || typeof u !== "object") return emptyUsage();
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const input = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreation = num(u.cache_creation_input_tokens);
  const output = num(u.output_tokens);
  return {
    inputTokens: input,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + cacheRead + cacheCreation + output,
  };
}

// tool_result.content can be a string (plain text), an array of typed content
// blocks (text/image), or null/undefined. Flatten to a single string for the
// UI's collapsible output box. Image blocks are referenced by a placeholder
// so the user knows they exist without us trying to render them.
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object") {
          const b = block as { type?: unknown; text?: unknown };
          if (b.type === "text" && typeof b.text === "string") return b.text;
          if (b.type === "image") return "[image]";
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}
