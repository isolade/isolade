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

function seedV3Db(path: string): { chatId: string; newestOrphanId: string } {
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
      active_leaf_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  sqlite.run(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_id TEXT,
      session_id TEXT,
      anchor_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  sqlite.run(`
    CREATE TABLE chat_events (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  const chatId = randomUUID();
  const committedId = randomUUID();
  const staleOrphanId = randomUUID();
  const newestOrphanId = randomUUID();
  sqlite.run(
    `INSERT INTO chats (id, instance_id, model, provider, active_leaf_id)
     VALUES (?, ?, 'claude-sonnet-4-5', 'anthropic', ?)`,
    [chatId, randomUUID(), committedId],
  );
  sqlite.run(
    `INSERT INTO chat_messages (id, chat_id, role, content) VALUES (?, ?, 'assistant', 'done')`,
    [committedId, chatId],
  );
  const insertEvent = (messageId: string, seq: number, type: string, payload: string) => {
    sqlite.run(
      `INSERT INTO chat_events (id, chat_id, message_id, seq, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1000)`,
      [randomUUID(), chatId, messageId, seq, type, payload],
    );
  };
  insertEvent(committedId, 0, "delta", JSON.stringify("done"));
  insertEvent(staleOrphanId, -1, "turn_started", "null");
  insertEvent(staleOrphanId, 0, "delta", JSON.stringify("stale"));
  insertEvent(newestOrphanId, -1, "turn_started", "null");
  insertEvent(newestOrphanId, 0, "delta", JSON.stringify("current"));
  sqlite.run(`PRAGMA user_version = 3`);
  sqlite.close();
  return { chatId, newestOrphanId };
}

describe("db migrations 3-6 (message tree, attachments, and rendering)", () => {
  it("backfills linear parent chains, the active leaf, and the parent index", () => {
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

      // A v2 database migrates all the way to the current shape, applying every
      // step in the ladder: message trees, uploads, reusable attachment
      // associations, and bounded render projections.
      const raw = new Database(path);
      const version = (raw.query("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      expect(version).toBe(6);
      // Migration 4 installed the uploads table.
      const uploadsTable = raw
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'uploads'`)
        .get();
      expect(uploadsTable).not.toBeNull();
      const messageUploadsTable = raw
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_uploads'`)
        .get();
      expect(messageUploadsTable).not.toBeNull();
      const index = raw
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_chat_messages_parent'",
        )
        .get() as { name: string } | null;
      expect(index?.name).toBe("idx_chat_messages_parent");
      const inFlightColumn = raw
        .query("SELECT name FROM pragma_table_info('chats') WHERE name = 'in_flight_message_id'")
        .get() as { name: string } | null;
      expect(inFlightColumn?.name).toBe("in_flight_message_id");
      const renderTable = raw
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_message_renders'",
        )
        .get() as { name: string } | null;
      expect(renderTable?.name).toBe("chat_message_renders");
      raw.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
  it("backfills the newest pre-v6 orphan turn into the hydration pointer", () => {
    const path = join(tmpdir(), `isolade-mig6-${randomUUID()}.db`);
    try {
      const { chatId, newestOrphanId } = seedV3Db(path);
      const db = createDb(path);
      const chat = db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).get();

      expect(chat?.inFlightMessageId).toBe(newestOrphanId);
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("does not revive an old orphan when a newer turn is committed", () => {
    const path = join(tmpdir(), `isolade-mig6-stale-${randomUUID()}.db`);
    try {
      const { chatId } = seedV3Db(path);
      const sqlite = new Database(path);
      const committedId = randomUUID();
      sqlite.run(
        `INSERT INTO chat_messages (id, chat_id, role, content) VALUES (?, ?, 'assistant', 'newer')`,
        [committedId, chatId],
      );
      sqlite.run(
        `INSERT INTO chat_events (id, chat_id, message_id, seq, type, payload, created_at)
         VALUES (?, ?, ?, 0, 'delta', ?, 1000)`,
        [randomUUID(), chatId, committedId, JSON.stringify("newer")],
      );
      sqlite.close();

      const db = createDb(path);
      const chat = db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).get();

      expect(chat?.inFlightMessageId).toBeNull();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});

describe("db migration 5 (message upload associations)", () => {
  it("keeps attachments made before the junction table existed", () => {
    const path = join(tmpdir(), `isolade-mig5-${randomUUID()}.db`);
    try {
      const raw = new Database(path);
      raw.run(`
        CREATE TABLE uploads (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          chat_id TEXT,
          message_id TEXT,
          filename TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      raw.run(
        `INSERT INTO uploads
          (id, instance_id, chat_id, message_id, filename, media_type, size)
         VALUES ('upload-1', 'instance-1', 'chat-1', 'message-1', 'image.png', 'image/png', 3)`,
      );
      raw.run(`PRAGMA user_version = 4`);
      raw.close();

      const db = createDb(path);
      const associations = db.select().from(schema.messageUploads).all();
      expect(associations).toEqual([
        {
          chatId: "chat-1",
          messageId: "message-1",
          uploadId: "upload-1",
          position: 0,
        },
      ]);
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
