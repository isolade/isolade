import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// A profile is the whole unit: identity (Claude/Codex auth, appearance, git,
// network, secret values) AND a single build definition. Its config.toml lives
// at configDir()/isolade/profiles/<id>/config.toml, and this row memoizes the
// latest build outputs. Identity is the directory slug (stable across
// display-name renames). Switching the active profile re-skins the entire app.
export const profiles = sqliteTable("profiles", {
  /** Stable slug, also the directory name under configDir()/profiles/<id>/. */
  id: text("id").primaryKey(),
  /** Human-facing display name, mutable independently of `id`. */
  name: text("name").notNull(),
  /** Latest built image ref, or null until the first successful build. */
  image: text("image"),
  status: text("status", { enum: ["pending", "building", "ready", "error"] })
    .notNull()
    .default("pending"),
  errorMessage: text("error_message"),
  buildLog: text("build_log"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// An instance is the user-facing "chat": one VM, one auto-generated title.
// The title is null until the first message is summarized.
export const instances = sqliteTable("instances", {
  id: text("id").primaryKey(),
  vmId: text("vm_id").notNull(),
  title: text("title"),
  status: text("status", {
    enum: ["initializing", "running", "stopped", "restarting", "error"],
  })
    .notNull()
    .default("running"),
  // Free-form description of the most recent VM-lifecycle failure (boot
  // re-attach, user-triggered restart, etc). Surfaced in the UI, and cleared
  // on the next successful restart.
  lastError: text("last_error"),
  // Whether the one-time `[setup]` phase has completed for this instance. Set
  // once setup's sync steps pass (or immediately when there are none). Gates
  // whether restart re-runs setup, so a failed/interrupted setup can be retried
  // but a succeeded one is never re-provisioned. Internal, not sent to clients.
  setupDone: integer("setup_done", { mode: "boolean" }).notNull().default(false),
  image: text("image").notNull(),
  // The profile this VM was created from: its image, config, auth, git,
  // network, secrets. An instance resolves its mounts from its OWN profile,
  // never the currently active one, so switching profiles never disturbs a
  // running VM.
  profileId: text("profile_id"),
  // Unpushed git work inside the VM, summed across every repo under
  // /workspace: working-tree lines added/deleted vs the nearest commit
  // known to exist on a remote (untracked files count as additions).
  // Refreshed by DiffStatsPoller while the VM runs. Stopped VMs keep
  // their last value. Null until the first probe lands, and for VMs with
  // no git repos.
  diffAdded: integer("diff_added"),
  diffDeleted: integer("diff_deleted"),
  // True when an assistant turn has finished that the user hasn't viewed yet.
  // Set at turn completion, cleared when the instance is opened. Drives the
  // sidebar's bold "unread" title. (The companion "working" signal is derived
  // live from the stream hub and is never stored.)
  unread: integer("unread", { mode: "boolean" }).notNull().default(false),
  // Archived chats are hidden from the main sidebar list (collapsed under an
  // "Archived" disclosure) and their VM is kept stopped: archiving stops it,
  // boot-time resync leaves it stopped, and unarchiving boots it back up.
  // Clearing the archive deletes every archived chat outright. Legacy rows
  // backfill to false.
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  // Pinned chats surface under a dedicated "Pinned" heading at the top of the
  // sidebar so frequently-used chats stay within reach. Purely presentational:
  // unlike archiving, pinning never touches the VM lifecycle. A chat is pinned
  // XOR archived (archiving clears the pin) so it lands in exactly one section.
  // Legacy rows backfill to false.
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  // Whether this VM was created with the host sandbox exposed into it
  // (`expose_sandbox`, isolade within isolade, see sandbox-forward.ts). The
  // create-time resolution is frozen here because ISOLADE_SANDBOX_URL lives in
  // the persisted VM record: restart/attach re-establish the forward from this
  // flag, so the tunnel always matches the env the guest actually sees. A
  // profile config toggle only affects instances created after it.
  exposeSandbox: integer("expose_sandbox", { mode: "boolean" }).notNull().default(false),
  // The profile ids seeded into this dev VM's nested isolade (see seed.ts),
  // frozen at create like exposeSandbox: the seed bundle is staged and mounted
  // at create, so this row — never the guest-writable bundle — records what
  // the host actually granted. Null/empty for ordinary instances.
  seedProfiles: text("seed_profiles", { mode: "json" }).$type<string[]>(),
  // Millisecond precision (timestamp_ms), unlike the second-precision timestamps
  // on other tables: updatedAt drives the recency-sorted sidebar, and several
  // instances can finish a turn within the same wall-clock second. Seconds tied
  // them and the order flickered. Milliseconds give a real activity order.
  // The table's SQL default (see createSchema in db/index.ts) is in ms too.
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Dynamically-added port forwards for an instance. Config-declared ports
// (config.toml `ports`) are NOT stored here. They're re-derived from the
// profile config on every boot and always forwarded. This table holds only
// the extras opened at runtime (via the UI or the in-VM agent helper), so they
// survive a restart. Provenance beyond "config vs runtime" isn't tracked.
export const portForwards = sqliteTable(
  "port_forwards",
  {
    instanceId: text("instance_id").notNull(),
    remotePort: integer("remote_port").notNull(),
    // Requested host loopback port. Null → the kernel picks a free one (the
    // default). Set for PINNED forwards, where the host port must equal a
    // value some external party dialed by number — e.g. an OAuth redirect_uri
    // (`localhost:K`) reaching a login flow inside a nested isolade.
    hostPort: integer("host_port"),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.remotePort] })],
);

// Pull requests attached to an instance via the in-VM `isolade pr add` CLI.
// One row per (instance, PR). `state`/`title`/`isDraft` cache the last value a
// background `gh` probe read from inside the VM (state="unknown" until the
// first probe lands, and for non-GitHub hosts we can't read). `url` is the
// canonical web link, synthesized on attach so the badge links out immediately.
export const instancePrs = sqliteTable(
  "instance_prs",
  {
    instanceId: text("instance_id").notNull(),
    /** PR host, e.g. "github.com" or a GitHub Enterprise domain. */
    host: text("host").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    title: text("title"),
    state: text("state", { enum: ["open", "closed", "merged", "unknown"] })
      .notNull()
      .default("unknown"),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
    url: text("url").notNull(),
    // Attach order, so the badges render in the order the agent added them.
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.host, t.owner, t.repo, t.number] })],
);

// One always-warm "titling" VM per profile, used to mint chat titles instantly
// without waiting for an instance's own VM to cold-boot. These VMs are
// ephemeral: created when a profile becomes active, destroyed when it's no
// longer in use, and NEVER resumed across a server restart. The table exists
// only so a crashed server can find and destroy leftover VMs on the next boot
// (see TitleVmManager.reapOrphans). The live state of record is in-memory. Just
// (profileId → vmId): the breadcrumb needs nothing else to reap an orphan.
export const titleVms = sqliteTable("title_vms", {
  /** The profile whose credentials/image this VM runs with. One VM per profile. */
  profileId: text("profile_id").primaryKey(),
  vmId: text("vm_id").notNull(),
});

// The per-instance shell terminal, surfaced in the right-hand side panel (one
// per instance, running /bin/bash). Persisted so the tab survives a restart.
export const terminals = sqliteTable("terminals", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  model: text("model").notNull(),
  provider: text("provider", { enum: ["anthropic", "openai"] }).notNull(),
  // Reasoning effort level for this chat. Server resolves to the model's
  // declared default when null (older rows pre-migration) or unsupported.
  effort: text("effort"),
  claudeSessionId: text("claude_session_id"),
  codexThreadId: text("codex_thread_id"),
  // Cumulative token counts across all turns in this chat. Updated at the
  // end of every turn from the provider's running total. Nullable so legacy
  // rows that predate the columns hydrate cleanly.
  inputTokens: integer("input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  cacheCreationInputTokens: integer("cache_creation_input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningOutputTokens: integer("reasoning_output_tokens"),
  // Most recent turn's breakdown, mirroring the cumulative fields above.
  // Powers the context-pressure bar after a reload. The cumulative totals
  // alone can't reconstruct "tokens packed into the last prompt".
  lastInputTokens: integer("last_input_tokens"),
  lastCachedInputTokens: integer("last_cached_input_tokens"),
  lastCacheCreationInputTokens: integer("last_cache_creation_input_tokens"),
  lastOutputTokens: integer("last_output_tokens"),
  lastReasoningOutputTokens: integer("last_reasoning_output_tokens"),
  // Provider-reported context window for the last turn. Codex emits this on
  // every usage update. Claude leaves it null and the UI falls back to the
  // catalog value.
  modelContextWindow: integer("model_context_window"),
  // Sticky `context_compacted` flag, set when the underlying CLI session
  // has been auto-compacted at least once. Cleared when the model/provider
  // changes (alongside the session ids).
  compacted: integer("compacted", { mode: "boolean" }),
  // Cumulative API-equivalent dollar cost. For Claude this is the authoritative
  // total_cost_usd reported by the CLI. For codex we derive it from the
  // catalog pricing × token totals.
  costUsd: real("cost_usd"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per SSE event emitted during an assistant turn: tool calls,
// thinking blocks, deltas, raw debug events, usage snapshots, etc. The
// `messageId` is generated server-side at the start of a turn and emitted
// to the client over the stream, so events can be associated with their
// eventual chat_messages row even before the row exists (in-flight turn).
// Reading back all events for a message and feeding them through the
// client's chunk reducer reconstructs the exact rendered turn.
export const chatEvents = sqliteTable("chat_events", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id").notNull(),
  // Monotonic per-message ordering. Per-turn counter (not global) so we
  // never need a MAX(seq) lookup on the hot path.
  seq: integer("seq").notNull(),
  // SSE event name: "delta" | "thinking" | "tool_call_start" |
  // "tool_call_input" | "tool_call_result" | "raw" | "usage" |
  // "context_compacted" | "title". Stored as text rather than an enum so
  // adding new event variants doesn't require a schema migration.
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Raw usage event log: one append-only row per metrics event, the sole source
// of truth for everything on the Usage page. The per-chat columns above hold
// only the *current* cumulative total, so they can't answer "how much did I
// spend last Tuesday?" or "in the last 5 hours?". This log does: each usage
// event records its delta (new cumulative − previous cumulative for that chat)
// with a precise timestamp and the model in effect for it, and each chat
// creation records a `chat_created` marker row (zero tokens). It's append-only
// (never rewritten or deleted when a chat is deleted), so every derived view
// survives deletion:
//   - the contribution-graph heatmap groups rows by local calendar day,
//   - the "Lifetime" cards sum every row for a profile grouped by provider,
//   - "across N chats" counts the `chat_created` rows,
//   - and a precise timestamp keeps arbitrary windows (hourly, rolling 5h/7d,
//     per-model over time) a read-time GROUP BY away.
// See ChatManager.getUsageHistory / getAggregateTotals.
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(),
    provider: text("provider", { enum: ["anthropic", "openai"] }).notNull(),
    /** The model in effect for this event (the turn's model, or the chat's model
        at creation). Kept so per-model-over-time views are a query away. */
    model: text("model").notNull(),
    /** "usage" for a turn's token delta, "chat_created" for a creation marker
        (zero tokens, counted for the lifetime chat total). */
    kind: text("kind", { enum: ["usage", "chat_created"] }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningOutputTokens: integer("reasoning_output_tokens").notNull().default(0),
    // API-equivalent dollar cost for this event (Claude: authoritative delta.
    // Codex: derived from catalog pricing × tokens).
    costUsd: real("cost_usd").notNull().default(0),
    // Pricing-weighted input-equivalent for this turn, at the model in effect
    // for it. Persisted (not recomputed) so it stays correct if catalog pricing
    // later changes, since it captures the rate at the time. Drives subscription-share.
    effectiveInputTokens: real("effective_input_tokens").notNull().default(0),
    // Millisecond precision (timestamp_ms): the day bucket is derived from this
    // at read time, and sub-second ordering lets rolling-window queries be exact.
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Serves the per-profile scans (lifetime + history) and future
    // (profile, provider, time-range) rolling-window queries.
    lookup: index("idx_usage_events_lookup").on(t.profileId, t.provider, t.createdAt),
  }),
);

// Generic singleton/key-value store for small, machine-local, global state that
// has no natural per-profile or per-instance home. One row per key, the value a
// JSON blob owned by whichever module writes it. Today it backs the update-check
// state (key "update-check"), which used to live in a sibling update-check.json;
// folding it in here keeps that disposable state in the one DB rather than as a
// stray file under dataDir(). Deliberately NOT a home for secrets: secret values
// stay out of the database (see secrets-store.ts).
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Instance = typeof instances.$inferSelect;
export type NewInstance = typeof instances.$inferInsert;
export type PortForwardRow = typeof portForwards.$inferSelect;
export type NewPortForwardRow = typeof portForwards.$inferInsert;
export type InstancePrRow = typeof instancePrs.$inferSelect;
export type NewInstancePrRow = typeof instancePrs.$inferInsert;
export type TitleVm = typeof titleVms.$inferSelect;
export type NewTitleVm = typeof titleVms.$inferInsert;
export type Terminal = typeof terminals.$inferSelect;
export type NewTerminal = typeof terminals.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type ChatEvent = typeof chatEvents.$inferSelect;
export type NewChatEvent = typeof chatEvents.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type AppStateRow = typeof appState.$inferSelect;
export type NewAppStateRow = typeof appState.$inferInsert;
