import { describe, expect, it } from "bun:test";
import { deriveThread, type TreeMessage, tipForSibling } from "../src/lib/chat-tree";

type M = TreeMessage & { content?: string };

function msg(id: string, role: "user" | "assistant", parentId?: string | null): M {
  return { id, role, parentId };
}

// The canonical branchy shape: a two-turn chat whose second question was
// edited once. List order is insertion order (u2b is newest).
//   u1 → a1 → u2  → a2
//             u2b → a2b
const branchy: M[] = [
  msg("u1", "user", null),
  msg("a1", "assistant", "u1"),
  msg("u2", "user", "a1"),
  msg("a2", "assistant", "u2"),
  msg("u2b", "user", "a1"),
  msg("a2b", "assistant", "u2b"),
];

describe("deriveThread", () => {
  it("shows a linear chat unchanged", () => {
    const messages = [msg("u1", "user", null), msg("a1", "assistant", "u1")];
    const view = deriveThread(messages, "a1");
    expect(view.path.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(view.versions.size).toBe(0);
    expect(view.tipId).toBe("a1");
  });

  it("follows the active leaf onto the edited branch", () => {
    const view = deriveThread(branchy, "a2b");
    expect(view.path.map((m) => m.id)).toEqual(["u1", "a1", "u2b", "a2b"]);
    expect(view.versions.get("u2b")).toEqual({
      index: 2,
      count: 2,
      siblingIds: ["u2", "u2b"],
    });
    // Messages without siblings carry no version info.
    expect(view.versions.has("u1")).toBe(false);
    expect(view.versions.has("a2b")).toBe(false);
  });

  it("shows the original branch when the leaf points there", () => {
    const view = deriveThread(branchy, "a2");
    expect(view.path.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(view.versions.get("u2")).toEqual({
      index: 1,
      count: 2,
      siblingIds: ["u2", "u2b"],
    });
  });

  it("descends from a mid-path leaf to the branch tip (newest child)", () => {
    // Leaf at a1: both branches hang below, and the newest (u2b) wins.
    const view = deriveThread(branchy, "a1");
    expect(view.path.map((m) => m.id)).toEqual(["u1", "a1", "u2b", "a2b"]);
  });

  it("falls back to the newest message for an unknown or absent leaf", () => {
    expect(deriveThread(branchy, null).tipId).toBe("a2b");
    expect(deriveThread(branchy, "gone").tipId).toBe("a2b");
    expect(deriveThread([], null).path).toEqual([]);
  });

  it("chains legacy messages (no parentId field) linearly", () => {
    const legacy: M[] = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "u2", role: "user" },
    ];
    const view = deriveThread(legacy, null);
    expect(view.path.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(view.versions.size).toBe(0);
  });

  it("versions of the first message are the roots group", () => {
    const messages: M[] = [
      msg("u1", "user", null),
      msg("a1", "assistant", "u1"),
      msg("u1b", "user", null),
      msg("a1b", "assistant", "u1b"),
    ];
    const view = deriveThread(messages, "a1b");
    expect(view.path.map((m) => m.id)).toEqual(["u1b", "a1b"]);
    expect(view.versions.get("u1b")).toEqual({
      index: 2,
      count: 2,
      siblingIds: ["u1", "u1b"],
    });
  });
});

describe("tipForSibling", () => {
  it("returns the sibling's subtree tip", () => {
    expect(tipForSibling(branchy, "u2")).toBe("a2");
    expect(tipForSibling(branchy, "u2b")).toBe("a2b");
  });

  it("returns the sibling itself when it has no descendants", () => {
    const messages = [...branchy, msg("u2c", "user", "a1")];
    expect(tipForSibling(messages, "u2c")).toBe("u2c");
  });

  it("follows the newest chain below the sibling", () => {
    // u2 gained a second assistant answer (e.g. a stopped turn's partial
    // followed by a recovered one): the newest wins.
    const messages = [...branchy, msg("a2x", "assistant", "u2")];
    expect(tipForSibling(messages, "u2")).toBe("a2x");
  });
});
