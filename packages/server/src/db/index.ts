import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { dataDir } from "../xdg";
import * as schema from "./schema";

function defaultDbPath(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return `${dir}/isolade.db`;
}

/**
 * Current schema version, tracked in SQLite's `PRAGMA user_version`.
 *
 * When schema.ts changes in a way that alters the generated DDL:
 *   1. Update the CREATE TABLE statements in {@link createSchema} to match it
 *      exactly (so a fresh database is born at the new shape).
 *   2. Bump this constant by one.
 *   3. Register an upgrade step under the new number in {@link migrations} that
 *      brings an existing database to the same shape.
 *
 * Version 1 is the baseline installed wholesale by {@link createSchema}. There
 * is intentionally no migration for it. Backwards compatibility with databases
 * older than this baseline is not maintained. Recreate them if needed.
 *
 * The ladder that grew the schema during development was squashed for the first
 * public release: those steps were folded into {@link createSchema} so a fresh
 * database is born at the released shape, and {@link migrations} now starts
 * empty again. Any pre-release database is expected to already be at this exact
 * shape; recreating it (or re-stamping its user_version to 1) is the supported
 * way to bring it onto the squashed baseline.
 */
const SCHEMA_VERSION = 1;

/**
 * The complete, current schema: one CREATE TABLE (plus indexes) per table in
 * schema.ts, in the same column order. Every statement is idempotent
 * (`IF NOT EXISTS`) so this is safe to run on every boot: on a fresh database it
 * installs everything, on an existing one it is a no-op.
 */
function createSchema(sqlite: Database): void {
  // A profile is the whole unit: identity + a single build definition. This row
  // memoizes the build outputs (image/status/log). The config.toml that defines
  // the build lives at configDir()/isolade/profiles/<id>/config.toml.
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      build_log TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Instance timestamps are milliseconds since the epoch (drizzle timestamp_ms),
  // not seconds like the other tables: updated_at orders the recency-sorted
  // sidebar and needs sub-second resolution so turns finishing in the same
  // second don't tie. Inserts come through drizzle (which supplies the value),
  // so these SQL defaults are only a fallback, kept in the same ms unit for
  // consistency. unixepoch('subsec') yields fractional seconds, so *1000 → ms.
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      vm_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      last_error TEXT,
      setup_done INTEGER NOT NULL DEFAULT 0,
      image TEXT NOT NULL,
      profile_id TEXT,
      diff_added INTEGER,
      diff_deleted INTEGER,
      unread INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      expose_sandbox INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
    )
  `);

  // Runtime-added port forwards, so they survive a restart. Config-declared
  // ports are re-derived from the profile config each boot and not stored here.
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS port_forwards (
      instance_id TEXT NOT NULL,
      remote_port INTEGER NOT NULL,
      PRIMARY KEY (instance_id, remote_port)
    )
  `);

  // Pull requests attached to an instance via the in-VM `isolade pr add` CLI.
  // state/title/is_draft cache the last value a background `gh` probe read from
  // inside the VM; url is the canonical web link synthesized on attach.
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS instance_prs (
      instance_id TEXT NOT NULL,
      host TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT,
      state TEXT NOT NULL DEFAULT 'unknown',
      is_draft INTEGER NOT NULL DEFAULT 0,
      url TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (instance_id, host, owner, repo, number)
    )
  `);

  // Per-profile warm "titling" VMs. Ephemeral and never resumed across a
  // restart. This table only lets a crashed server destroy leftover VMs on the
  // next boot (TitleVmManager.reapOrphans clears it). One VM per profile, and the
  // (profile_id → vm_id) breadcrumb is all reaping needs.
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS title_vms (
      profile_id TEXT PRIMARY KEY,
      vm_id TEXT NOT NULL
    )
  `);

  // The per-instance shell terminal shown in the side panel (one per instance,
  // /bin/bash). Persisted so the tab survives a restart.
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS terminals (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      effort TEXT,
      claude_session_id TEXT,
      codex_thread_id TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      last_input_tokens INTEGER,
      last_cached_input_tokens INTEGER,
      last_cache_creation_input_tokens INTEGER,
      last_output_tokens INTEGER,
      last_reasoning_output_tokens INTEGER,
      model_context_window INTEGER,
      compacted INTEGER,
      cost_usd REAL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Append-only log of structured SSE events for each assistant turn. Lets the
  // UI reconstruct tool calls, thinking blocks, raw debug events, and per-turn
  // usage snapshots after a reload. chat_messages stores only the final
  // assistant text and is intentionally not enough to re-render the turn.
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS chat_events (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  sqlite.run(`
    CREATE INDEX IF NOT EXISTS idx_chat_events_lookup
    ON chat_events (chat_id, message_id, seq)
  `);
  // getEventsForMessage filters by message_id alone (resume / existence probe).
  // The composite index above leads with chat_id, so it can't serve a
  // message_id-only lookup, but this one can.
  sqlite.run(`
    CREATE INDEX IF NOT EXISTS idx_chat_events_message
    ON chat_events (message_id, seq)
  `);

  // Raw usage event log: one append-only row per metrics event, the source of
  // truth for the whole Usage page. Each usage event stores a turn's token delta
  // (see ChatManager.updateUsage) with a precise timestamp and the model in
  // effect. Each chat creation stores a `chat_created` marker (zero tokens). The
  // heatmap groups by local day, the "Lifetime" cards sum per provider, and
  // "across N chats" counts the markers, all derived at read time (see
  // getUsageHistory / getAggregateTotals). Append-only and never touched on chat
  // deletion, so every view survives it. `effective_input_tokens` is the
  // pricing-weighted input-equivalent for the turn at its model's rate, stored
  // (not recomputed) so it stays correct if catalog pricing later changes.
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      kind TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      effective_input_tokens REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
    )
  `);
  // Serves per-profile scans (lifetime + history) and future
  // (profile, provider, time-range) rolling-window queries.
  sqlite.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_events_lookup
    ON usage_events (profile_id, provider, created_at)
  `);

  // Generic singleton/key-value store for small, global, machine-local state
  // (one JSON value per key). Currently holds the update-check state, which used
  // to be a sibling update-check.json (see update-check-store.ts).
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/**
 * Upgrade steps for databases created by an older build, keyed by the version
 * they produce: `migrations[n]` upgrades a database at user_version `n - 1` to
 * `n`. Version 1 is the baseline (installed wholesale by {@link createSchema}),
 * so the first future entry will be `2`.
 *
 * Each step is a plain function that runs its DDL/DML. The runner wraps it in a
 * transaction and bumps user_version on success. Errors are deliberately NOT
 * caught: a failing migration throws out of {@link createDb} and halts boot
 * loudly rather than silently leaving a half-migrated schema behind.
 *
 * @example
 *   const migrations = {
 *     2: (sqlite: Database) => {
 *       sqlite.run(`ALTER TABLE chats ADD COLUMN foo TEXT`);
 *     },
 *   };
 */
const migrations: Record<number, (sqlite: Database) => void> = {};

function migrate(sqlite: Database): void {
  const { user_version: current } = sqlite.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  const hadUserTables =
    sqlite
      .query(
        `
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        LIMIT 1
      `,
      )
      .get() != null;

  // Ensure the current schema exists. Fresh DB: installs everything. Existing
  // DB: no-op (every statement is IF NOT EXISTS).
  createSchema(sqlite);

  if (current === 0 && !hadUserTables) {
    // Fresh database: createSchema already produced the latest schema, so stamp
    // it as current and skip the ladder, since those steps only bring databases from
    // older builds forward and would collide with the tables just created.
    sqlite.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  const startVersion = current === 0 ? 1 : current;

  // Existing database: apply each pending step in order, atomically. Any throw
  // propagates and halts boot instead of being swallowed.
  for (let target = startVersion + 1; target <= SCHEMA_VERSION; target++) {
    const migration = migrations[target];
    if (!migration) {
      throw new Error(
        `No migration registered to reach schema version ${target} ` +
          `(database is at ${current}, target is ${SCHEMA_VERSION})`,
      );
    }
    sqlite.transaction(() => {
      migration(sqlite);
      sqlite.run(`PRAGMA user_version = ${target}`);
    })();
  }
}

export function createDb(path?: string) {
  const dbPath = path ?? defaultDbPath();
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.run("PRAGMA journal_mode = WAL");

  migrate(sqlite);

  const db = drizzle(sqlite, { schema });
  return db;
}

// Re-exported so DB-access consumers (e.g. root-level scripts that can't
// resolve drizzle-orm on their own) build query predicates against the same
// drizzle instance this module uses.
export { eq } from "drizzle-orm";
export { schema };
export type Db = ReturnType<typeof createDb>;
