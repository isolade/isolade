import type { ChatManager } from "../chats";
import {
  type ChatEffort,
  type ContextBreakdown,
  codexPricingFor,
  type ModelPricing,
} from "../contracts";
import { KeyedQueue } from "../keyed-queue";
import type { SandboxApi } from "../sandbox-client";
import type { ChatBackend, ChatEvent, TokenUsage, TurnMeta } from "./backend";
import { type CodexConnection, CodexManager } from "./codex-manager";
import { buildTitlePrompt, CODEX_TITLE_MODEL, cleanTitle } from "./title-generator";

// How long a single title turn may run before we give up and let the caller
// fall back to a truncated title. Mirrors the claude title timeout.
const CODEX_TITLE_TIMEOUT_MS = 20_000;
const AUTH_FAILURE_REFRESH_COOLDOWN_MS = 60_000;

export class CodexBackend implements ChatBackend {
  private manager: CodexManager;
  private lastAuthFailureRefreshAt = new Map<string, number>();
  // Serialize title turns per VM. The titling VM is shared across a profile's
  // chats, so two first-messages racing on the same codex connection would
  // otherwise interleave their `item/agentMessage/delta` streams (the handler
  // is connection-wide, not thread-scoped). Chaining keeps each title turn's
  // deltas to itself. Titles are quick and this path is rare.
  private titleQueue = new KeyedQueue();
  // Per-connection record of which threads the app-server behind that
  // connection has loaded in memory. Codex only knows a thread if the current
  // app-server process started or resumed it. The map is keyed by the live
  // connection object, so a reconnect (new process, new object) naturally
  // resets to "nothing loaded" and forces a resume. WeakMap so a dropped
  // connection's entry is collected with it.
  private threadLiveness = new WeakMap<CodexConnection, Map<string, Promise<void>>>();

  constructor(
    sandboxClient: SandboxApi,
    private chatManager: ChatManager,
    manager?: CodexManager,
  ) {
    this.manager = manager ?? new CodexManager(sandboxClient);
  }

  getManager(): CodexManager {
    return this.manager;
  }

  // Return the thread id to run the turn against, ensuring the app-server
  // behind `conn` actually has it loaded. New chats (no prior thread) get a
  // fresh persistent thread. Existing chats resume their thread. If its rollout
  // is gone (e.g. the codex home was reset) we start a fresh thread instead of
  // failing every turn. codex-side context is lost, but isolade still shows
  // the full message history and the chat keeps working.
  private async resolveThread(
    conn: CodexConnection,
    chatId: string,
    sessionId: string | undefined,
  ): Promise<string> {
    if (sessionId) {
      try {
        await this.ensureThreadLive(conn, sessionId);
        return sessionId;
      } catch (err) {
        if (!isMissingRolloutError(err)) throw err;
        console.warn(
          `[codex] thread ${sessionId} has no persisted rollout; starting a fresh thread`,
        );
      }
    }
    const threadId = await this.startThread(conn);
    this.chatManager.updateSessionId(chatId, undefined, threadId);
    return threadId;
  }

  private async startThread(conn: CodexConnection): Promise<string> {
    const result = (await conn.send("thread/start", { ephemeral: false })) as {
      thread: { id: string };
    };
    const threadId = result.thread.id;
    // A freshly started thread is already in this app-server's memory, so record
    // it as live to skip a pointless (and failing, since there's no rollout yet) resume if
    // the same chat sends another turn on this connection.
    this.livenessMap(conn).set(threadId, Promise.resolve());
    return threadId;
  }

  // Fork `threadId` through `lastTurnId` (inclusive): codex copies the thread
  // up to that turn into a NEW thread and returns its id. This is how an
  // edited message recomputes from an earlier point: the fork carries exactly
  // the context that preceded the edited message, and the source thread stays
  // intact so its branch remains continuable. The source thread only needs to
  // exist on disk (thread/fork loads the rollout itself), no resume required.
  private async forkThread(
    conn: CodexConnection,
    chatId: string,
    threadId: string,
    lastTurnId: string,
  ): Promise<string> {
    const result = (await conn.send("thread/fork", {
      threadId,
      lastTurnId,
      ephemeral: false,
    })) as { thread: { id: string } };
    const forkedId = result.thread.id;
    // The fork is live in this app-server's memory, same as a fresh start.
    this.livenessMap(conn).set(forkedId, Promise.resolve());
    this.chatManager.updateSessionId(chatId, undefined, forkedId);
    return forkedId;
  }

  // Ensure the app-server behind `conn` has `threadId` loaded in memory. A
  // thread started by a previous app-server process (e.g. before a VM restart)
  // survives only as a persisted rollout on disk. codex needs an explicit
  // thread/resume to reload it, otherwise turn/start fails with
  // "thread not found: <id>". Resumed at most once per connection; concurrent
  // callers share the single in-flight resume.
  private ensureThreadLive(conn: CodexConnection, threadId: string): Promise<void> {
    const map = this.livenessMap(conn);
    const existing = map.get(threadId);
    if (existing) return existing;
    const p = conn
      .send("thread/resume", { threadId })
      .then(() => {})
      .catch((err: unknown) => {
        // Drop the cached failure so a later turn can retry the resume.
        if (map.get(threadId) === p) map.delete(threadId);
        throw err;
      });
    map.set(threadId, p);
    return p;
  }

  private livenessMap(conn: CodexConnection): Map<string, Promise<void>> {
    let map = this.threadLiveness.get(conn);
    if (!map) {
      map = new Map();
      this.threadLiveness.set(conn, map);
    }
    return map;
  }

  async sendMessage(opts: {
    vmId: string;
    chatId: string;
    message: string;
    model: string;
    effort: ChatEffort;
    sessionId?: string; // codexThreadId
    fork?: { anchorId: string }; // anchorId = the turn id to fork through
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onEvent?: (event: ChatEvent) => void;
    onMeta?: (meta: TurnMeta) => void;
  }): Promise<{ content: string; sessionId?: string }> {
    const conn = await this.manager.getOrCreate(opts.vmId);

    // Resolve the codex thread this turn runs against. A brand-new chat starts
    // a fresh persistent thread. An existing chat resumes its thread onto this
    // connection so a turn after a VM restart (which spawns a fresh app-server)
    // doesn't fail with "thread not found". See resolveThread. An edit forks
    // the source thread at the anchored turn instead, and unlike a missing
    // rollout on resume, a failed fork propagates rather than degrading to a
    // fresh thread: silently answering an edit without its context would be
    // worse than surfacing the error. Route failures here through the same
    // auth refresh as turn failures, since a token that went stale across
    // the restart may just need a refresh.
    let threadId: string;
    try {
      threadId =
        opts.fork && opts.sessionId
          ? await this.forkThread(conn, opts.chatId, opts.sessionId, opts.fork.anchorId)
          : await this.resolveThread(conn, opts.chatId, opts.sessionId);
    } catch (err) {
      await this.refreshAuthAfterPossibleStaleState(opts.vmId, err);
      throw err;
    }
    // The thread is a session-level fact: report it now so even a turn that
    // dies mid-stream records which thread its partial answer lives in.
    opts.onMeta?.({ sessionId: threadId });

    // Register notification handlers before sending the turn so we don't miss early events
    let fullContent = "";
    await new Promise<void>((resolve, reject) => {
      let turnStartPromise: Promise<{ turn: { id: string } }> | null = null;
      const offDelta = conn.on("item/agentMessage/delta", (params) => {
        const delta = (params as { delta?: string } | null)?.delta ?? "";
        if (delta) {
          fullContent += delta;
          opts.onDelta(delta);
        }
      });

      // Codex signals failure two ways: a dedicated `turn/failed` notification
      // (rare in practice) and, much more commonly, a `turn/completed` with
      // `turn.status === "failed"` plus a populated `turn.error`. We MUST
      // reject on the latter. Otherwise rate-limit hits, auth failures, and
      // upstream API errors all surface to the user as an empty assistant
      // message with no error event on the SSE stream.
      const offCompleted = conn.on("turn/completed", (params) => {
        const turn = (
          params as {
            turn?: { status?: string; error?: { message?: string } };
          } | null
        )?.turn;
        if (turn?.status === "failed") {
          cleanup();
          reject(new Error(turn.error?.message ?? "turn failed"));
          return;
        }
        for (const itemId of reasoning.keys()) finishReasoning(itemId);
        cleanup();
        resolve();
      });

      const offFailed = conn.on("turn/failed", (params) => {
        cleanup();
        const errMsg =
          (params as { error?: { message?: string } } | null)?.error?.message ?? "turn failed";
        reject(new Error(errMsg));
      });

      // Codex broadcasts work-item lifecycle as JSON-RPC notifications:
      //   item/started   → params.item contains type, id, status="inProgress",
      //                    plus item-type-specific fields (command, cwd, …)
      //   item/updated   → mid-flight changes, possibly carrying a final
      //                    status of completed/failed once the item is done
      //   item/completed → the explicit "this item is finished" notification,
      //                    with aggregatedOutput + exitCode populated
      // We map all of these to the same provider-agnostic tool_call_*
      // events the UI already renders for Claude.
      const seenTools = new Set<string>();
      const finishedTools = new Set<string>();
      // Codex's summaryTextDelta notifications are the public reasoning
      // summary stream. For each item, concatenating deltas within each
      // summaryIndex reconstructs the corresponding entry in the completed
      // item's `summary` array. Keep those parts separate while streaming so
      // we can preserve the section breaks and reconcile with the final item.
      const reasoning = new Map<string, { parts: Map<number, string>; done: boolean }>();
      const ensureReasoning = (itemId: string) => {
        const existing = reasoning.get(itemId);
        if (existing) return existing;
        const state = { parts: new Map<number, string>(), done: false };
        reasoning.set(itemId, state);
        opts.onEvent?.({ type: "thinking_start", id: itemId, provider: "codex" });
        return state;
      };
      const reasoningText = (state: { parts: Map<number, string> }) =>
        [...state.parts.entries()]
          .toSorted(([a], [b]) => a - b)
          .map(([, text]) => text)
          .filter((text) => text.length > 0)
          .join("\n\n");
      const finishReasoning = (itemId: string, item?: CodexItem) => {
        const state = ensureReasoning(itemId);
        if (state.done) return;
        state.done = true;
        const completedSummary = Array.isArray(item?.summary)
          ? item.summary.filter((part): part is string => typeof part === "string").join("\n\n")
          : undefined;
        opts.onEvent?.({
          type: "thinking_done",
          id: itemId,
          provider: "codex",
          text: completedSummary || reasoningText(state),
        });
      };

      // Liberal classifier: codex CLI versions have used "reasoning",
      // "thinking", and "reasoning_text" interchangeably; a substring match
      // covers all known variants.
      const isReasoning = (item: CodexItem) => /reason|think/i.test(item.type);

      // Plain message text items aren't tool calls. The assistant's reply
      // streams in through item/agentMessage/delta (rendered as Markdown).
      // The userMessage item is just codex echoing the turn input. Skipping
      // these on the tool-call path avoids phantom "Calling AgentMessage"
      // cards in the UI.
      const isMessage = (item: CodexItem) => /^(agent|assistant|user)?_?message$/i.test(item.type);

      const handleItemStart = (item: CodexItem) => {
        if (isReasoning(item)) {
          ensureReasoning(item.id);
          return;
        }
        if (isMessage(item)) return;
        if (seenTools.has(item.id)) return;
        seenTools.add(item.id);
        opts.onEvent?.({
          type: "tool_call_start",
          id: item.id,
          name: codexToolName(item.type),
        });
        opts.onEvent?.({
          type: "tool_call_input",
          id: item.id,
          input: codexToolInput(item),
        });
      };
      const handleItemFinish = (item: CodexItem) => {
        if (isReasoning(item)) {
          finishReasoning(item.id, item);
          return;
        }
        if (isMessage(item)) return;
        if (!seenTools.has(item.id)) handleItemStart(item);
        if (finishedTools.has(item.id)) return;
        finishedTools.add(item.id);
        const output = codexToolOutput(item);
        const isError =
          item.status === "failed" ||
          item.status === "errored" ||
          (typeof item.exitCode === "number" && item.exitCode !== 0);
        opts.onEvent?.({
          type: "tool_call_result",
          id: item.id,
          output,
          isError,
        });
      };

      const offStarted = conn.on("item/started", (params) => {
        const item = extractCodexItem(params);
        if (item) handleItemStart(item);
      });
      const offUpdated = conn.on("item/updated", (params) => {
        const item = extractCodexItem(params);
        if (!item) return;
        // Reasoning may stream text through item/updated even before a
        // terminal status. Text itself arrives through summaryTextDelta.
        if (isReasoning(item)) {
          if (
            item.status === "completed" ||
            item.status === "succeeded" ||
            item.status === "failed" ||
            item.status === "errored"
          ) {
            finishReasoning(item.id, item);
          } else {
            ensureReasoning(item.id);
          }
          return;
        }
        // Tool calls: only flip to "result" on terminal status; otherwise
        // keep the start path running so we don't drop fields populated
        // mid-flight.
        if (
          item.status === "completed" ||
          item.status === "succeeded" ||
          item.status === "failed" ||
          item.status === "errored"
        ) {
          handleItemFinish(item);
        } else {
          handleItemStart(item);
        }
      });
      const offItemDone = conn.on("item/completed", (params) => {
        const item = extractCodexItem(params);
        if (item) handleItemFinish(item);
      });

      const offReasoningDelta = conn.on("item/reasoning/summaryTextDelta", (params) => {
        const p = params as {
          itemId?: unknown;
          delta?: unknown;
          summaryIndex?: unknown;
        } | null;
        if (typeof p?.itemId !== "string" || typeof p.delta !== "string") return;
        const summaryIndex = typeof p.summaryIndex === "number" ? p.summaryIndex : 0;
        const state = ensureReasoning(p.itemId);
        if (state.done) return;
        const isNewPart = !state.parts.has(summaryIndex);
        state.parts.set(summaryIndex, (state.parts.get(summaryIndex) ?? "") + p.delta);
        opts.onEvent?.({
          type: "thinking_delta",
          id: p.itemId,
          provider: "codex",
          text: `${isNewPart && state.parts.size > 1 ? "\n\n" : ""}${p.delta}`,
        });
      });

      const offReasoningPart = conn.on("item/reasoning/summaryPartAdded", (params) => {
        const itemId = (params as { itemId?: unknown } | null)?.itemId;
        if (typeof itemId === "string") ensureReasoning(itemId);
      });

      // Token usage. The v2 app-server emits `thread/tokenUsage/updated`
      // throughout a turn with pre-aggregated `last` (this turn) and `total`
      // (entire thread) plus `modelContextWindow`, strictly more info than
      // Claude gives us. Codex doesn't include a dollar cost the way Claude
      // does, so we compute API-$ from the running token total × the
      // model's catalog pricing (when known).
      const pricing = codexPricingFor(opts.model);
      const offUsage = conn.on("thread/tokenUsage/updated", (params) => {
        const ev = params as {
          tokenUsage?: {
            last?: Record<string, unknown>;
            total?: Record<string, unknown>;
            modelContextWindow?: number | null;
          };
        } | null;
        if (!ev?.tokenUsage) return;
        const last = parseCodexUsage(ev.tokenUsage.last);
        const total = parseCodexUsage(ev.tokenUsage.total);
        const win =
          typeof ev.tokenUsage.modelContextWindow === "number"
            ? ev.tokenUsage.modelContextWindow
            : undefined;
        const costUsd = pricing ? computeApiCost(total, pricing) : undefined;
        opts.onEvent?.({
          type: "usage",
          last,
          total,
          modelContextWindow: win,
          costUsd,
        });
      });

      // Codex fires this when it auto-compacts the thread because the
      // context window is full. The UI flags the next gauge update as a
      // post-compaction snapshot rather than showing a confusing drop.
      const offCompacted = conn.on("thread/compacted", () => {
        opts.onEvent?.({ type: "context_compacted" });
      });

      // Anything else still flows through as an honest raw event so the user
      // can see what we don't yet recognize and tell us what to wire up.
      // Methods handled by typed listeners above are deliberately excluded.
      // Otherwise every codex notification produces both the typed
      // event AND a duplicate debug card.
      const HANDLED_METHODS = new Set<string>([
        "item/agentMessage/delta",
        "turn/completed",
        "turn/failed",
        "item/started",
        "item/updated",
        "item/completed",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
        "thread/tokenUsage/updated",
        "thread/compacted",
      ]);
      const offAny = conn.onAny((method, params) => {
        if (HANDLED_METHODS.has(method)) return;
        opts.onEvent?.({
          type: "raw",
          source: "codex",
          payload: { method, params },
        });
      });

      function cleanup() {
        offDelta();
        offCompleted();
        offFailed();
        offStarted();
        offUpdated();
        offItemDone();
        offReasoningDelta();
        offReasoningPart();
        offUsage();
        offCompacted();
        offAny();
        // Detach the abort listener on every exit path (not just when it
        // fires) so a completed turn doesn't leave a dangling listener on the
        // shared per-turn signal.
        opts.signal?.removeEventListener("abort", onAbort);
      }

      // User-initiated cancel: interrupt the actual Codex turn before
      // unblocking the chat. `turn/interrupt` needs the turn id returned by
      // `turn/start`, so an early Stop waits for that response first. The
      // interrupt is pushed onto app-server stdin (a synchronous `conn.send`)
      // before the reject in `.finally` runs, so it is guaranteed to reach the
      // app-server ahead of any later turn/start.
      const onAbort = () => {
        cleanup();
        const started = turnStartPromise;
        if (!started) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        void started
          .then((res) => {
            // Defensive: the turn-start result shape is asserted, not
            // validated. If codex ever omits the turn id there's nothing to
            // interrupt, so skip the send rather than throw into the catch.
            const turnId = res?.turn?.id;
            if (!turnId) return;
            void conn
              .send("turn/interrupt", { threadId, turnId })
              .catch((err: Error) => console.warn("[codex] turn interrupt failed:", err));
          })
          // turn/start has its own rejection handler below. Consume it on
          // this cancellation chain too so an abort racing a failed start
          // cannot create an unhandled rejection.
          .catch(() => {})
          .finally(() => reject(new DOMException("aborted", "AbortError")));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Opt the turn into reasoning summaries (otherwise codex emits empty
      // `reasoning` items with no summary/content). codex accepts
      // `auto` | `concise` | `detailed` | `none` for summary. `effort` is a
      // free-form, model-advertised `ReasoningEffort` string: codex clamps a
      // value a given model doesn't support to the nearest tier via
      // `nearest_effort`. Our chat efforts are always drawn from the model's
      // curated menu (see shared/catalog.ts), and codex clamps anything it
      // doesn't support, so pass the chat's effort straight through.
      turnStartPromise = conn.send("turn/start", {
        threadId,
        model: opts.model,
        // The text carries the user's message plus an attachments preamble
        // that cites every file's path. The agent opens images with view_image
        // and other files with its shell tools when it needs them.
        input: [{ type: "text", text: opts.message }],
        summary: "detailed",
        // (The turn id this resolves to is reported through onMeta below: it
        // is the anchor a future edit forks this thread at.)
        // Pin the standard ("default") service tier per turn rather than via
        // a launch-time `-c service_tier=...` flag. `serviceTier` is a
        // first-class turn param (it sits next to `effort` in the v2
        // turn-start struct), so this is exactly the path a future UI "fast
        // mode" toggle would use to send "priority" for a given chat, with no
        // app-server restart needed. It also guarantees a workspace image's
        // baked config.toml can't silently push turns onto a premium tier.
        serviceTier: "default",
        effort: opts.effort,
      }) as Promise<{ turn: { id: string } }>;
      turnStartPromise.catch((err: Error) => {
        cleanup();
        reject(err);
      });
      // Report the turn id as this turn's fork anchor. On a separate consumer
      // (rejections are owned by the .catch above) so meta reporting can't
      // interfere with turn-failure handling.
      void turnStartPromise.then(
        (res) => {
          const turnId = res?.turn?.id;
          if (turnId) opts.onMeta?.({ anchorId: turnId });
        },
        () => {},
      );
    }).catch(async (err) => {
      await this.refreshAuthAfterPossibleStaleState(opts.vmId, err);
      throw err;
    });

    return { content: fullContent, sessionId: threadId };
  }

  // Codex exposes per-turn token totals through `thread/tokenUsage/updated`
  // (already surfaced to the UI via the SSE `usage` event) but no
  // category-level breakdown analogous to claude's `/context`. Report
  // unavailable so the UI hides the section.
  async probeContext(): Promise<ContextBreakdown> {
    return { available: false, reason: "codex has no /context equivalent" };
  }

  // Mint a title by running one ephemeral codex turn in the VM. Best-effort:
  // any failure (unauth, quota, timeout, dropped connection) resolves to null
  // so the caller falls back to a truncated title. Serialized per VM (see
  // titleChains) so concurrent titles on a shared titling VM don't interleave.
  async generateTitle(vmId: string, firstMessage: string): Promise<string | null> {
    return this.titleQueue.run(vmId, () => this.runTitleTurn(vmId, firstMessage));
  }

  private async runTitleTurn(vmId: string, firstMessage: string): Promise<string | null> {
    let conn;
    try {
      conn = await this.manager.getOrCreate(vmId);
    } catch (err) {
      console.warn("[title] codex connect failed:", err);
      return null;
    }
    try {
      const startRes = (await conn.send("thread/start", {
        ephemeral: true,
      })) as {
        thread: { id: string };
      };
      const threadId = startRes.thread.id;

      const text = await new Promise<string>((resolve, reject) => {
        let collected = "";
        const offDelta = conn.on("item/agentMessage/delta", (params) => {
          const delta = (params as { delta?: string } | null)?.delta ?? "";
          if (delta) collected += delta;
        });
        const timer = setTimeout(
          () => settle(() => reject(new Error("codex title turn timed out"))),
          CODEX_TITLE_TIMEOUT_MS,
        );
        let done = false;
        const settle = (fn: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          offDelta();
          offCompleted();
          offFailed();
          fn();
        };
        const offCompleted = conn.on("turn/completed", (params) => {
          const turn = (
            params as {
              turn?: { status?: string; error?: { message?: string } };
            } | null
          )?.turn;
          if (turn?.status === "failed") {
            settle(() => reject(new Error(turn.error?.message ?? "turn failed")));
            return;
          }
          settle(() => resolve(collected));
        });
        const offFailed = conn.on("turn/failed", (params) => {
          const msg =
            (params as { error?: { message?: string } } | null)?.error?.message ?? "turn failed";
          settle(() => reject(new Error(msg)));
        });
        conn
          .send("turn/start", {
            threadId,
            model: CODEX_TITLE_MODEL,
            input: [{ type: "text", text: buildTitlePrompt(firstMessage) }],
            serviceTier: "default",
            effort: "low",
          })
          .catch((err: Error) => settle(() => reject(err)));
      });

      return cleanTitle(text);
    } catch (err) {
      console.warn("[title] codex generateTitle failed:", err);
      return null;
    }
  }

  private async refreshAuthAfterPossibleStaleState(vmId: string, err: unknown): Promise<void> {
    if (!shouldRefreshCodexAuthAfterFailure(err)) return;
    const now = Date.now();
    const last = this.lastAuthFailureRefreshAt.get(vmId) ?? 0;
    if (now - last < AUTH_FAILURE_REFRESH_COOLDOWN_MS) return;
    this.lastAuthFailureRefreshAt.set(vmId, now);
    try {
      await this.manager.refreshAuth(vmId);
    } catch (refreshErr) {
      console.warn("[codex] auth refresh after failed turn failed:", refreshErr);
    }
  }
}

interface CodexItem {
  id: string;
  type: string;
  status?: string;
  command?: string;
  cwd?: string;
  path?: string;
  aggregatedOutput?: unknown;
  exitCode?: number;
  durationMs?: number;
  // Item-type-specific extras (commandActions, edits, …), preserved as-is
  // so the UI can show them via the generic input pretty-printer.
  [k: string]: unknown;
}

function extractCodexItem(params: unknown): CodexItem | null {
  if (!params || typeof params !== "object") return null;
  const item = (params as { item?: unknown }).item;
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.type !== "string") return null;
  return o as CodexItem;
}

// Display name shown on the tool-call card. Codex item types are camelCase
// like "commandExecution"; we humanize the common ones and fall through for
// the rest so a future "imageGeneration" still gets a reasonable card label.
function codexToolName(itemType: string): string {
  switch (itemType) {
    case "commandExecution":
      return "Shell";
    case "fileEdit":
      return "Edit";
    case "fileRead":
      return "Read";
    case "webSearch":
      return "Web Search";
    default:
      return itemType.replace(/^[a-z]/, (c) => c.toUpperCase());
  }
}

// Codex reports a resume against a thread whose rollout file is gone as
// "no rollout found for thread id <id>" (distinct from the in-memory
// "thread not found" a turn hits). Only this error means the thread is
// genuinely unrecoverable and warrants starting fresh. Transport or auth
// failures should propagate so we don't discard a resumable thread.
function isMissingRolloutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no rollout found/i.test(message);
}

function shouldRefreshCodexAuthAfterFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes("usage_limit") ||
    lower.includes("usage limit") ||
    lower.includes("usage exhausted") ||
    lower.includes("usage was exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication") ||
    lower.includes("refresh token")
  );
}

// What goes into the collapsible `input` block on the card. We pass the
// whole item through so nothing the provider sent is hidden. The user
// sees the full payload (command, cwd, status, processId, durationMs,
// commandActions, …) and can spot anything we'd otherwise truncate.
function codexToolInput(item: CodexItem): Record<string, unknown> {
  return item as Record<string, unknown>;
}

// Codex's `TokenUsageBreakdown` shares field names with our `TokenUsage` but
// nests two subsets the way the OpenAI Responses API does (see
// codex-rs/protocol/src/protocol.rs::TokenUsage): `inputTokens` is the FULL
// prompt with `cachedInputTokens` a subset of it, and `outputTokens` is the
// FULL completion with `reasoningOutputTokens` a subset of it. Our schema
// follows Anthropic's convention where every bucket is disjoint (they sum to
// the total, and cost/weighting add them up — see computeApiCost and
// subscription-share's effectiveInputTokens). So we subtract each subset out on
// the way in: without it, cached tokens would double-count in the context
// pressure metric, and — because `reasoningOutputTokens > 0` for reasoning
// models — reasoning tokens would be billed twice in the API-$ estimate.
function parseCodexUsage(u: Record<string, unknown> | undefined): TokenUsage {
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const rawInput = num(u?.inputTokens);
  const cached = num(u?.cachedInputTokens);
  const rawOutput = num(u?.outputTokens);
  const reasoning = num(u?.reasoningOutputTokens);
  return {
    inputTokens: Math.max(0, rawInput - cached),
    cachedInputTokens: cached,
    // OpenAI's caching is implicit and the codex CLI doesn't separate cache
    // writes from reads, so this stays 0 to keep the unified TokenUsage shape valid.
    cacheCreationInputTokens: 0,
    outputTokens: Math.max(0, rawOutput - reasoning),
    reasoningOutputTokens: reasoning,
    totalTokens: num(u?.totalTokens),
  };
}

// Convert a TokenUsage total into a dollar cost using the model's pricing
// rates. Cache writes don't apply to codex (the CLI doesn't separate them),
// so we ignore `cacheCreationInputTokens` here.
function computeApiCost(usage: TokenUsage, pricing: ModelPricing): number {
  const fresh = (usage.inputTokens * pricing.inputPerMTok) / 1_000_000;
  const cached =
    pricing.cachedInputPerMTok != null
      ? (usage.cachedInputTokens * pricing.cachedInputPerMTok) / 1_000_000
      : 0;
  const output =
    ((usage.outputTokens + usage.reasoningOutputTokens) * pricing.outputPerMTok) / 1_000_000;
  return fresh + cached + output;
}

function codexToolOutput(item: CodexItem): string {
  const head: string[] = [];
  if (typeof item.exitCode === "number") head.push(`exit ${item.exitCode}`);
  if (typeof item.durationMs === "number") head.push(`${item.durationMs}ms`);
  const headerLine = head.length > 0 ? `[${head.join(" · ")}]\n` : "";

  const out = item.aggregatedOutput;
  let body: string;
  if (typeof out === "string") body = out;
  else if (out == null) body = "";
  else body = JSON.stringify(out, null, 2);

  return headerLine + body;
}
