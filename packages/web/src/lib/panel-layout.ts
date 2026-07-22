import type { Layout, LayoutNode, PanelNode, PanelTab, SplitNode, TabKind } from "./contracts";

// Pure operations over the per-instance panel-layout tree. Everything here is
// immutable: each function returns a fresh tree, so React state updates and
// undo/persist stay straightforward. See shared/src/domain.ts for the shape.
//
// Vocabulary:
//   - a PanelNode is a leaf holding an ordered list of tabs with one active,
//   - a SplitNode divides its box between exactly two children, as a "row"
//     (children laid left | right) or a "column" (children laid top / bottom),
//     with fractional `sizes` that sum to 1.

export type DropZone = "center" | "left" | "right" | "top" | "bottom";

let idCounter = 0;
// Monotonic-with-random ids. crypto.randomUUID keeps them globally unique
// across windows; the counter guarantees uniqueness even if two ids are minted
// within the same tick before entropy differs.
function uid(prefix: string): string {
  idCounter += 1;
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${idCounter}-${rand}`;
}

export function makeTab(kind: TabKind, resourceId: string | null = null): PanelTab {
  return { id: uid("tab"), kind, resourceId };
}

export function makeChatTab(chatId: string): PanelTab {
  return makeTab("chat", chatId);
}

export function makeTerminalTab(terminalId: string): PanelTab {
  return makeTab("terminal", terminalId);
}

export function makePanel(tabs: PanelTab[]): PanelNode {
  return {
    type: "panel",
    id: uid("panel"),
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
}

// The default workspace for an instance: a single panel with one tab per chat
// (first active). An instance with no chats gets an empty panel, which still
// renders its "+" so the user can add one.
export function defaultLayout(chatIds: string[]): Layout {
  return makePanel(chatIds.map(makeChatTab));
}

// ---- traversal ----

export function collectTabs(node: LayoutNode, into: PanelTab[] = []): PanelTab[] {
  if (node.type === "panel") {
    into.push(...node.tabs);
  } else {
    collectTabs(node.children[0], into);
    collectTabs(node.children[1], into);
  }
  return into;
}

export function findPanelContainingTab(node: LayoutNode, tabId: string): PanelNode | null {
  if (node.type === "panel") {
    return node.tabs.some((t) => t.id === tabId) ? node : null;
  }
  return (
    findPanelContainingTab(node.children[0], tabId) ??
    findPanelContainingTab(node.children[1], tabId)
  );
}

// The leftmost-topmost leaf panel: always follow the first child of every
// split. This is the panel that sits under the window chrome (traffic lights,
// sidebar toggle, settings gear) and therefore needs the leading inset.
export function findTopLeftPanelId(node: LayoutNode): string {
  return node.type === "panel" ? node.id : findTopLeftPanelId(node.children[0]);
}

// Panels whose tab strip touches the top edge of the window. A row split spans
// the full height so BOTH children reach the top; a column split stacks, so
// only its first (top) child does. These strips double as the window title bar,
// so their empty regions are the OS drag surface.
export function topEdgePanelIds(node: LayoutNode, into: Set<string> = new Set()): Set<string> {
  if (node.type === "panel") {
    into.add(node.id);
    return into;
  }
  topEdgePanelIds(node.children[0], into);
  if (node.direction === "row") topEdgePanelIds(node.children[1], into);
  return into;
}

// Panels whose tab strip touches the left edge of the workspace. A column
// split spans the full width so both children reach the left edge; a row split
// places its second child to the right, so only the first child does.
export function leftEdgePanelIds(node: LayoutNode, into: Set<string> = new Set()): Set<string> {
  if (node.type === "panel") {
    into.add(node.id);
    return into;
  }
  leftEdgePanelIds(node.children[0], into);
  if (node.direction === "column") leftEdgePanelIds(node.children[1], into);
  return into;
}

// ---- structural edits ----

// Replace the node with the given id (panel or split) by the result of `fn`.
function replaceNode(node: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (node.id === id) return fn(node);
  if (node.type === "split") {
    return {
      ...node,
      children: [replaceNode(node.children[0], id, fn), replaceNode(node.children[1], id, fn)],
    };
  }
  return node;
}

// Remove a tab wherever it lives, returning the tab (or null if not found) and
// the tree with it gone. A panel that loses its active tab re-activates the
// neighbour at the same index, then the previous one, mirroring editor tab
// behaviour. Emptied panels are left in place here; call `prune` to collapse
// them.
function extractTab(node: LayoutNode, tabId: string): { node: LayoutNode; tab: PanelTab | null } {
  if (node.type === "panel") {
    const idx = node.tabs.findIndex((t) => t.id === tabId);
    const tab = idx === -1 ? null : node.tabs[idx];
    if (!tab) return { node, tab: null };
    const tabs = node.tabs.filter((t) => t.id !== tabId);
    let activeTabId = node.activeTabId;
    if (activeTabId === tabId) {
      activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0])?.id ?? null;
    }
    return { node: { ...node, tabs, activeTabId }, tab };
  }
  const left = extractTab(node.children[0], tabId);
  if (left.tab) {
    return { node: { ...node, children: [left.node, node.children[1]] }, tab: left.tab };
  }
  const right = extractTab(node.children[1], tabId);
  if (right.tab) {
    return { node: { ...node, children: [node.children[0], right.node] }, tab: right.tab };
  }
  return { node, tab: null };
}

// Collapse splits whose children are empty panels: a split with one empty side
// becomes its non-empty side (which inherits the split's slot), and a split
// with two empty sides disappears entirely. Returns null when the whole subtree
// is empty, which only the top-level `prune` turns back into a bare panel.
function stripEmpty(node: LayoutNode): LayoutNode | null {
  if (node.type === "panel") return node.tabs.length > 0 ? node : null;
  const a = stripEmpty(node.children[0]);
  const b = stripEmpty(node.children[1]);
  if (a && b) return { ...node, children: [a, b] };
  return a ?? b ?? null;
}

// Collapse emptied panels, keeping a single empty panel at the root so the
// workspace always has somewhere to add a tab.
export function prune(node: LayoutNode): Layout {
  return stripEmpty(node) ?? makePanel([]);
}

export function setActiveTab(layout: Layout, panelId: string, tabId: string): Layout {
  return replaceNode(layout, panelId, (n) =>
    n.type === "panel" ? { ...n, activeTabId: tabId } : n,
  );
}

// Append a new tab to a panel and focus it.
export function addTab(layout: Layout, panelId: string, tab: PanelTab): Layout {
  return replaceNode(layout, panelId, (n) =>
    n.type === "panel" ? { ...n, tabs: [...n.tabs, tab], activeTabId: tab.id } : n,
  );
}

export function closeTab(layout: Layout, tabId: string): Layout {
  return prune(extractTab(layout, tabId).node);
}

export function setSplitSizes(layout: Layout, splitId: string, sizes: [number, number]): Layout {
  return replaceNode(layout, splitId, (n) => (n.type === "split" ? { ...n, sizes } : n));
}

function splitFor(
  zone: Exclude<DropZone, "center">,
  target: LayoutNode,
  fresh: PanelNode,
): SplitNode {
  const direction = zone === "left" || zone === "right" ? "row" : "column";
  const children: [LayoutNode, LayoutNode] =
    zone === "left" || zone === "top" ? [fresh, target] : [target, fresh];
  return { type: "split", id: uid("split"), direction, children, sizes: [0.5, 0.5] };
}

// Move a tab onto a panel. "center" drops it into that panel; an edge splits the
// panel in half and puts the tab in a new panel on that side. Dropping a
// panel's only tab back onto itself is a no-op (the split would just reproduce
// the same single panel).
export function moveTab(
  layout: Layout,
  tabId: string,
  targetPanelId: string,
  zone: DropZone,
): Layout {
  const source = findPanelContainingTab(layout, tabId);
  if (!source) return layout;
  if (source.id === targetPanelId && source.tabs.length === 1) return layout;

  const { node: without, tab } = extractTab(layout, tabId);
  if (!tab) return layout;
  const pruned = prune(without);

  if (zone === "center") {
    return replaceNode(pruned, targetPanelId, (n) =>
      n.type === "panel" ? { ...n, tabs: [...n.tabs, tab], activeTabId: tab.id } : n,
    );
  }
  return replaceNode(pruned, targetPanelId, (target) => splitFor(zone, target, makePanel([tab])));
}

// Move a tab into a panel at a specific index (drag within / across a tab
// strip, i.e. reordering). Same-panel moves account for the index shift caused
// by first removing the tab.
export function moveTabToIndex(
  layout: Layout,
  tabId: string,
  targetPanelId: string,
  index: number,
): Layout {
  const source = findPanelContainingTab(layout, tabId);
  if (!source) return layout;
  // Extracting the only tab would prune its panel before the insertion can
  // resolve `targetPanelId`, turning a self-drop into an empty workspace.
  if (source.id === targetPanelId && source.tabs.length === 1) return layout;
  const { node: without, tab } = extractTab(layout, tabId);
  if (!tab) return layout;
  const pruned = prune(without);
  return replaceNode(pruned, targetPanelId, (n) => {
    if (n.type !== "panel") return n;
    const tabs = [...n.tabs];
    tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
    return { ...n, tabs, activeTabId: tab.id };
  });
}

// Drop tabs from panels for which `keep` returns false, fixing each panel's
// active tab, without collapsing emptied panels (the caller prunes).
function filterTabs(node: LayoutNode, keep: (tab: PanelTab) => boolean): LayoutNode {
  if (node.type === "panel") {
    const tabs = node.tabs.filter(keep);
    const activeTabId =
      node.activeTabId && tabs.some((t) => t.id === node.activeTabId)
        ? node.activeTabId
        : (tabs[0]?.id ?? null);
    return { ...node, tabs, activeTabId };
  }
  return {
    ...node,
    children: [filterTabs(node.children[0], keep), filterTabs(node.children[1], keep)],
  };
}

// Bring a persisted/edited layout back in line with the live resources:
//   - drop chat/terminal tabs whose backing row is gone,
//   - append any live chat not represented anywhere (created in another window,
//     or by a race) to the top-left panel, so it's never hidden,
//   - collapse any panel emptied along the way.
// Utility tabs (browser/files/review/ports) have no backing row and are always
// kept.
export function reconcile(layout: Layout, chatIds: string[], terminalIds: string[]): Layout {
  const liveChats = new Set(chatIds);
  const liveTerminals = new Set(terminalIds);
  const filtered = filterTabs(layout, (tab) => {
    if (tab.kind === "chat") return tab.resourceId != null && liveChats.has(tab.resourceId);
    if (tab.kind === "terminal") return tab.resourceId != null && liveTerminals.has(tab.resourceId);
    return true;
  });
  let next = prune(filtered);

  const present = new Set(
    collectTabs(next)
      .filter((t) => t.kind === "chat" && t.resourceId != null)
      .map((t) => t.resourceId as string),
  );
  const missing = chatIds.filter((id) => !present.has(id));
  if (missing.length > 0) {
    const topLeftId = findTopLeftPanelId(next);
    for (const chatId of missing) {
      next = addTab(next, topLeftId, makeChatTab(chatId));
    }
  }
  return next;
}
