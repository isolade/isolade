// Message-tree derivation for the chat view. Messages arrive as a flat list
// (in insertion order) whose `parentId` links form a tree: editing a message
// inserts a sibling under the same parent, so a message's versions are its
// parent's children in list order. The chat shows exactly one root-to-tip
// path at a time, picked by the chat's activeLeafId. Everything here is pure
// so it can be unit-tested and memoized as one derivation per render.

export interface TreeMessage {
  id: string;
  role: "user" | "assistant";
  parentId?: string | null;
}

export interface VersionInfo {
  /** 1-based position of the path's message among its siblings. */
  index: number;
  count: number;
  /** All versions (the parent's children) in insertion order. */
  siblingIds: string[];
}

export interface ThreadView<M extends TreeMessage> {
  /** The visible messages, root → tip. */
  path: M[];
  /** Per path-message version info, present only where there are ≥2 versions. */
  versions: Map<string, VersionInfo>;
  /** Id of the path's last message, or null for an empty chat. */
  tipId: string | null;
}

// The synthetic parent map: message id → parent id (null = root). Messages
// with `parentId === undefined` predate the tree (an old server, a mock) and
// are chained linearly to their predecessor so legacy data still renders as
// the linear conversation it is.
function parentsOf<M extends TreeMessage>(messages: M[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  let prev: string | null = null;
  for (const m of messages) {
    parents.set(m.id, m.parentId === undefined ? prev : m.parentId);
    prev = m.id;
  }
  return parents;
}

// Derive the visible thread. `activeLeafId` may point anywhere on the target
// branch (or at nothing, for legacy chats): unknown/absent leaves fall back
// to the newest message, and the path is extended tip-ward by newest child,
// mirroring the server's resolveTip.
export function deriveThread<M extends TreeMessage>(
  messages: M[],
  activeLeafId: string | null | undefined,
): ThreadView<M> {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const parents = parentsOf(messages);
  // children/roots in list order, which is insertion order (the server
  // returns rowid order and optimistic messages append).
  const children = new Map<string | null, M[]>();
  for (const m of messages) {
    const parent = parents.get(m.id) ?? null;
    const list = children.get(parent) ?? [];
    list.push(m);
    children.set(parent, list);
  }

  const leaf = (activeLeafId ? byId.get(activeLeafId) : undefined) ?? messages[messages.length - 1];
  if (!leaf) return { path: [], versions: new Map(), tipId: null };

  // Ancestors (leaf included), guarding against parent cycles in bad data.
  const path: M[] = [];
  const seen = new Set<string>();
  for (let cur: M | undefined = leaf; cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    path.unshift(cur);
    const parentId: string | null = parents.get(cur.id) ?? null;
    cur = parentId ? byId.get(parentId) : undefined;
  }
  // Descend from the leaf to its branch tip by newest child.
  for (let cur = leaf; ; ) {
    const kids = children.get(cur.id);
    const next = kids?.[kids.length - 1];
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    path.push(next);
    cur = next;
  }

  const versions = new Map<string, VersionInfo>();
  for (const m of path) {
    const group = (children.get(parents.get(m.id) ?? null) ?? []).filter((s) => s.role === m.role);
    if (group.length < 2) continue;
    versions.set(m.id, {
      index: group.findIndex((s) => s.id === m.id) + 1,
      count: group.length,
      siblingIds: group.map((s) => s.id),
    });
  }

  return { path, versions, tipId: path[path.length - 1]?.id ?? null };
}

// The leaf to activate when switching to version `siblingId` of a message:
// its subtree's tip (newest child chain), so the switch lands on that
// branch's latest state. Mirrors the server's descendToTip.
export function tipForSibling<M extends TreeMessage>(messages: M[], siblingId: string): string {
  const parents = parentsOf(messages);
  const children = new Map<string, M[]>();
  for (const m of messages) {
    const parent = parents.get(m.id);
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(m);
    children.set(parent, list);
  }
  let currentId = siblingId;
  const seen = new Set<string>([siblingId]);
  for (;;) {
    const kids = children.get(currentId);
    const next = kids?.[kids.length - 1];
    if (!next || seen.has(next.id)) return currentId;
    seen.add(next.id);
    currentId = next.id;
  }
}
