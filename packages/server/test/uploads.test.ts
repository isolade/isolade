import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db";
import { GUEST_UPLOADS_DIR, safeFilename, UploadStore, uploadGuestPath } from "../src/uploads";

// UploadStore only owns the metadata rows now (the route streams the bytes), so
// it runs against an in-memory DB. An isolated XDG_STATE_HOME keeps stateDir()
// off the real machine for the path helpers.
const XDG_VARS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
let root: string;
let prev: Map<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "isolade-uploads-"));
  prev = new Map(XDG_VARS.map((v) => [v, process.env[v]] as const));
  process.env.XDG_STATE_HOME = join(root, "state");
});

afterEach(() => {
  for (const [v, value] of prev) {
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function record(store: UploadStore, instanceId: string, filename: string, mediaType = "image/png") {
  return store.record({ id: randomUUID(), instanceId, filename, mediaType, size: 3 });
}

describe("uploads paths", () => {
  test("safeFilename strips directory components (no traversal)", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("note.txt")).toBe("note.txt");
    expect(safeFilename("...")).toBe("file");
  });

  test("guest path is absolute, under the uploads dir, and preserves the filename", () => {
    expect(uploadGuestPath("abc", "note.txt")).toBe(`${GUEST_UPLOADS_DIR}/abc/note.txt`);
    // Filename is sanitized in the path too.
    expect(uploadGuestPath("abc", "../x")).toBe(`${GUEST_UPLOADS_DIR}/abc/x`);
  });
});

describe("UploadStore", () => {
  test("record inserts a row and returns the wire metadata", () => {
    const store = new UploadStore(createDb(":memory:"));
    const upload = store.record({
      id: "u1",
      instanceId: "inst-1",
      filename: "note.txt",
      mediaType: "text/plain",
      size: 11,
    });
    expect(upload).toEqual({ id: "u1", filename: "note.txt", mediaType: "text/plain", size: 11 });
    expect(store.get("u1")?.instanceId).toBe("inst-1");
  });

  test("attach claims staged uploads and lets edits reuse them within the chat", () => {
    const store = new UploadStore(createDb(":memory:"));
    const a = record(store, "i", "a");
    const b = record(store, "i", "b");
    const other = record(store, "other", "c");

    // Bogus + cross-instance ids are ignored; the two real ones attach in order.
    const attached = store.attach("i", "chat-1", "msg-1", [b.id, a.id, other.id, "nope"]);
    expect(attached.map((r) => r.id)).toEqual([b.id, a.id]);

    // An edited sibling can retain one attachment without taking it off the
    // original message. Reordering and duplicate ids are normalized too.
    expect(store.attach("i", "chat-1", "msg-2", [a.id, a.id]).map((r) => r.id)).toEqual([a.id]);
    expect(
      store
        .listForMessage("msg-1")
        .map((u) => u.id)
        .toSorted(),
    ).toEqual([a.id, b.id].toSorted());
    expect(store.listForMessage("msg-2").map((u) => u.id)).toEqual([a.id]);

    // Another chat cannot steal or reuse a claimed upload.
    expect(store.attach("i", "chat-2", "msg-3", [a.id])).toEqual([]);

    // Grouped read returns them under their message.
    const byMessage = store.byMessageForChat("chat-1");
    expect((byMessage.get("msg-1") ?? []).map((u) => u.id).toSorted()).toEqual(
      [a.id, b.id].toSorted(),
    );
    expect(store.listForMessage("msg-1").length).toBe(2);
    expect((byMessage.get("msg-2") ?? []).map((u) => u.id)).toEqual([a.id]);

    store.removeForChat("chat-1");
    expect(store.byMessageForChat("chat-1").size).toBe(0);
    expect(store.get(a.id)).toBeUndefined();
  });
});
