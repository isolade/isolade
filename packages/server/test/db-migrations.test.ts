import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "crypto";
import { asc, eq, sql } from "drizzle-orm";
import { createDb, schema } from "../src/db";

// Build a database at the version-2 shape for the tables migration 3 touches
// (chats without active_leaf_id, chat_messages without the tree columns), so
// createDb has to run the real upgrade ladder against it. The other tables are
// left absent: createSchema's IF NOT EXISTS installs them at the current shape,
// which is identical for them across v2 → v3.
function seedV2Db(path: string): { chatId: string; emptyChatId: string; messageIds: string[] } {
  const sqlite = new Database(path);
  sqlite.run(`
    CREATE TABLE chats (
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
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  const chatId = randomUUID();
  const emptyChatId = randomUUID();
  for (const id of [chatId, emptyChatId]) {
    sqlite.run(
      `INSERT INTO chats (id, instance_id, model, provider) VALUES (?, ?, 'claude-sonnet-4-5', 'anthropic')`,
      [id, randomUUID()],
    );
  }
  // Same created_at for every row on purpose: the backfill must chain by
  // insertion order (rowid), not by the second-precision timestamp.
  const messageIds = [randomUUID(), randomUUID(), randomUUID()];
  const contents = ["hello", "hi there", "and again"];
  const roles = ["user", "assistant", "user"];
  for (const [i, id] of messageIds.entries()) {
    sqlite.run(
      `INSERT INTO chat_messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, 1000)`,
      [id, chatId, roles[i]!, contents[i]!],
    );
  }
  sqlite.run(`PRAGMA user_version = 2`);
  sqlite.close();
  return { chatId, emptyChatId, messageIds };
}

describe("db migration 3 (message tree)", () => {
  it("backfills linear parent chains and the active leaf", () => {
    const path = join(tmpdir(), `isolade-mig3-${randomUUID()}.db`);
    try {
      const { chatId, emptyChatId, messageIds } = seedV2Db(path);
      const db = createDb(path);

      const msgs = db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, chatId))
        .orderBy(asc(sql`rowid`))
        .all();
      expect(msgs.map((m) => m.id)).toEqual(messageIds);
      expect(msgs[0]!.parentId).toBeNull();
      expect(msgs[1]!.parentId).toBe(messageIds[0]!);
      expect(msgs[2]!.parentId).toBe(messageIds[1]!);
      // Session snapshots can't be reconstructed for old turns, so they stay null.
      expect(msgs.every((m) => m.sessionId === null && m.anchorId === null)).toBe(true);

      const chat = db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).get();
      expect(chat?.activeLeafId).toBe(messageIds[2]!);
      const empty = db.select().from(schema.chats).where(eq(schema.chats.id, emptyChatId)).get();
      expect(empty?.activeLeafId).toBeNull();

      const version = (
        new Database(path).query("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      expect(version).toBe(3);
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
