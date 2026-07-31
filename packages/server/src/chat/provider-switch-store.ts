import { eq } from "drizzle-orm";
import type { ChatEffort, ChatProvider } from "../contracts";
import type { Db } from "../db";
import { schema } from "../db";
import type { ProviderSwitchRow } from "../db/schema";

// Coarse classification of why a switch step could not complete. The handoff
// service maps a caught provider error into one of these so the availability
// matrix and the UI can react (retry vs cancel vs confirm cost) without parsing
// raw error strings. `null` means no error recorded yet.
export type SwitchErrorClass =
  | "source-unavailable"
  | "target-unavailable"
  | "target-context"
  | "transcript-missing"
  | "cancelled"
  | "unknown";

export type SwitchStatus = ProviderSwitchRow["status"];

// What the caller records at model selection. The lifecycle then advances the
// status and fills in auxiliary references as source-side compaction or a
// forked summary is produced.
export interface PendingSwitchInput {
  sourceLeafId: string | null;
  sourceProvider: ChatProvider;
  sourceModel: string;
  sourceSessionId: string | null;
  sourceAnchorId: string | null;
  targetProvider: ChatProvider;
  targetModel: string;
  targetEffort: ChatEffort | null;
}

// Fields the lifecycle updates as an attempt progresses. Everything is
// optional: an update touches only what changed, so a status bump doesn't
// clobber an auxiliary reference recorded by an earlier step.
export interface SwitchUpdate {
  status?: SwitchStatus;
  auxSessionId?: string | null;
  auxTurnId?: string | null;
  errorClass?: SwitchErrorClass | null;
  lastError?: string | null;
}

// Persisted state for the at-most-one pending cross-provider switch per chat.
// A separate store (rather than more methods on ChatManager) because the switch
// lifecycle is its own concern and the table is keyed by chat id, so it never
// needs the message-tree machinery ChatManager owns.
//
// The store never holds handoff or summary TEXT: only references to the
// auxiliary native session/turn that hold it (auxSessionId/auxTurnId). The text
// is read back from that native transcript, and the Isolade message/event
// stores are the raw fallback.
export class ProviderSwitchStore {
  constructor(private readonly db: Db) {}

  // Record (or replace) the pending switch for a chat. Selecting another model
  // before sending replaces the row wholesale rather than stacking, and resets
  // the lifecycle to `pending` with no auxiliary references or error, because
  // any work done for the previous target no longer applies.
  upsert(chatId: string, input: PendingSwitchInput): ProviderSwitchRow {
    const now = new Date();
    this.db
      .insert(schema.providerSwitches)
      .values({
        chatId,
        status: "pending",
        sourceLeafId: input.sourceLeafId,
        sourceProvider: input.sourceProvider,
        sourceModel: input.sourceModel,
        sourceSessionId: input.sourceSessionId,
        sourceAnchorId: input.sourceAnchorId,
        targetProvider: input.targetProvider,
        targetModel: input.targetModel,
        targetEffort: input.targetEffort,
        auxSessionId: null,
        auxTurnId: null,
        errorClass: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.providerSwitches.chatId,
        set: {
          status: "pending",
          sourceLeafId: input.sourceLeafId,
          sourceProvider: input.sourceProvider,
          sourceModel: input.sourceModel,
          sourceSessionId: input.sourceSessionId,
          sourceAnchorId: input.sourceAnchorId,
          targetProvider: input.targetProvider,
          targetModel: input.targetModel,
          targetEffort: input.targetEffort,
          auxSessionId: null,
          auxTurnId: null,
          errorClass: null,
          lastError: null,
          updatedAt: now,
        },
      })
      .run();
    return this.get(chatId)!;
  }

  get(chatId: string): ProviderSwitchRow | undefined {
    return this.db
      .select()
      .from(schema.providerSwitches)
      .where(eq(schema.providerSwitches.chatId, chatId))
      .get();
  }

  // Advance the lifecycle. Only the provided fields change, so a status bump
  // preserves an auxiliary reference an earlier step recorded (a compacted
  // Claude fork or a forked Codex summary reused across a retry). Returns the
  // updated row, or undefined when there is no pending switch to update.
  update(chatId: string, patch: SwitchUpdate): ProviderSwitchRow | undefined {
    const set: Partial<ProviderSwitchRow> = { updatedAt: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.auxSessionId !== undefined) set.auxSessionId = patch.auxSessionId;
    if (patch.auxTurnId !== undefined) set.auxTurnId = patch.auxTurnId;
    if (patch.errorClass !== undefined) set.errorClass = patch.errorClass;
    if (patch.lastError !== undefined) set.lastError = patch.lastError;
    this.db
      .update(schema.providerSwitches)
      .set(set)
      .where(eq(schema.providerSwitches.chatId, chatId))
      .run();
    return this.get(chatId);
  }

  // Mark a failed step. The switch stays in the table (retryable), and its
  // auxiliary references are kept so a completed source-side summary or
  // chunking step is reused when only target startup failed.
  fail(
    chatId: string,
    errorClass: SwitchErrorClass,
    lastError: string,
  ): ProviderSwitchRow | undefined {
    return this.update(chatId, { status: "failed", errorClass, lastError });
  }

  // Clear the pending switch. Called once the switch commits (the first target
  // request is accepted) or when its source leaf no longer identifies the
  // active branch (a branch change invalidates it).
  clear(chatId: string): void {
    this.db.delete(schema.providerSwitches).where(eq(schema.providerSwitches.chatId, chatId)).run();
  }

  // Every persisted switch, for crash recovery on server restart (the lifecycle
  // resumes each one from its last completed reference).
  listAll(): ProviderSwitchRow[] {
    return this.db.select().from(schema.providerSwitches).all();
  }
}
