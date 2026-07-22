import { describe, expect, it } from "bun:test";
import type { Layout, PanelNode, SplitNode } from "../src/lib/contracts";
import {
  addTab,
  closeTab,
  collectTabs,
  defaultLayout,
  findTopLeftPanelId,
  leftEdgePanelIds,
  makeChatTab,
  makeTab,
  moveTab,
  moveTabToIndex,
  reconcile,
  setActiveTab,
  setSplitSizes,
  topEdgePanelIds,
} from "../src/lib/panel-layout";

// Narrowing helpers: the tests build known shapes, so a failed cast is a real
// assertion failure, surfaced by the follow-up expects.
function asPanel(node: Layout): PanelNode {
  if (node.type !== "panel") throw new Error("expected a panel");
  return node;
}
function asSplit(node: Layout): SplitNode {
  if (node.type !== "split") throw new Error("expected a split");
  return node;
}

// The chat resource ids for every chat tab in the tree, in traversal order.
function chatIdsOf(layout: Layout): (string | null | undefined)[] {
  return collectTabs(layout)
    .filter((t) => t.kind === "chat")
    .map((t) => t.resourceId);
}

describe("defaultLayout", () => {
  it("makes one panel with a tab per chat, first active", () => {
    const panel = asPanel(defaultLayout(["c1", "c2"]));
    expect(panel.tabs).toHaveLength(2);
    expect(chatIdsOf(panel)).toEqual(["c1", "c2"]);
    expect(panel.activeTabId).toBe(panel.tabs[0]!.id);
  });

  it("makes an empty panel when there are no chats", () => {
    const panel = asPanel(defaultLayout([]));
    expect(panel.tabs).toHaveLength(0);
    expect(panel.activeTabId).toBeNull();
  });
});

describe("addTab / setActiveTab", () => {
  it("appends a tab to the panel and focuses it", () => {
    const start = asPanel(defaultLayout(["c1"]));
    const tab = makeChatTab("c2");
    const next = asPanel(addTab(start, start.id, tab));
    expect(chatIdsOf(next)).toEqual(["c1", "c2"]);
    expect(next.activeTabId).toBe(tab.id);
  });

  it("switches the active tab", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const next = asPanel(setActiveTab(start, start.id, start.tabs[1]!.id));
    expect(next.activeTabId).toBe(start.tabs[1]!.id);
  });
});

describe("moveTab", () => {
  it("splits a panel to the right, keeping the target in the first slot", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const moved = start.tabs[1]!;
    const split = asSplit(moveTab(start, moved.id, start.id, "right"));
    expect(split.direction).toBe("row");
    // Original panel (now just c1) on the left, the moved tab in a new panel.
    expect(chatIdsOf(split.children[0])).toEqual(["c1"]);
    expect(chatIdsOf(split.children[1])).toEqual(["c2"]);
    expect(split.sizes).toEqual([0.5, 0.5]);
  });

  it("splits above for a top drop (column, new panel first)", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const split = asSplit(moveTab(start, start.tabs[1]!.id, start.id, "top"));
    expect(split.direction).toBe("column");
    expect(chatIdsOf(split.children[0])).toEqual(["c2"]);
    expect(chatIdsOf(split.children[1])).toEqual(["c1"]);
  });

  it("moves a tab into another panel on a center drop", () => {
    // Split first, then drop the right tab back onto the left panel's centre.
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const rightTab = start.tabs[1]!;
    const split = asSplit(moveTab(start, rightTab.id, start.id, "right"));
    const leftPanel = asPanel(split.children[0]);
    const rightPanel = asPanel(split.children[1]);
    // Dropping the right panel's only tab into the left panel empties the right
    // panel, which then collapses, leaving a single panel with both tabs.
    const merged = asPanel(moveTab(split, rightPanel.tabs[0]!.id, leftPanel.id, "center"));
    expect(chatIdsOf(merged)).toEqual(["c1", "c2"]);
  });

  it("is a no-op when a panel's only tab is dropped back onto itself", () => {
    const start = asPanel(defaultLayout(["c1"]));
    const same = moveTab(start, start.tabs[0]!.id, start.id, "right");
    expect(same).toBe(start);
  });
});

describe("moveTabToIndex", () => {
  it("reorders tabs within a panel", () => {
    const start = asPanel(defaultLayout(["c1", "c2", "c3"]));
    // Move the third tab to the front.
    const next = asPanel(moveTabToIndex(start, start.tabs[2]!.id, start.id, 0));
    expect(chatIdsOf(next)).toEqual(["c3", "c1", "c2"]);
  });

  it("keeps a panel's only tab when it is dropped on either side of itself", () => {
    const start = asPanel(defaultLayout(["c1"]));
    const tabId = start.tabs[0]!.id;

    expect(moveTabToIndex(start, tabId, start.id, 0)).toBe(start);
    expect(moveTabToIndex(start, tabId, start.id, 1)).toBe(start);
  });
});

describe("closeTab", () => {
  it("removes a tab and re-picks the active one", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const next = asPanel(closeTab(start, start.tabs[0]!.id));
    expect(chatIdsOf(next)).toEqual(["c2"]);
    expect(next.activeTabId).toBe(next.tabs[0]!.id);
  });

  it("collapses a split when its last tab closes, promoting the sibling", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const split = asSplit(moveTab(start, start.tabs[1]!.id, start.id, "right"));
    const rightPanel = asPanel(split.children[1]);
    const collapsed = asPanel(closeTab(split, rightPanel.tabs[0]!.id));
    expect(chatIdsOf(collapsed)).toEqual(["c1"]);
  });

  it("keeps an empty root panel when the very last tab closes", () => {
    const start = asPanel(defaultLayout(["c1"]));
    const empty = asPanel(closeTab(start, start.tabs[0]!.id));
    expect(empty.tabs).toHaveLength(0);
    expect(empty.activeTabId).toBeNull();
  });
});

describe("setSplitSizes", () => {
  it("updates only the targeted split's sizes", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const split = asSplit(moveTab(start, start.tabs[1]!.id, start.id, "right"));
    const resized = asSplit(setSplitSizes(split, split.id, [0.7, 0.3]));
    expect(resized.sizes).toEqual([0.7, 0.3]);
  });
});

describe("workspace edge panels", () => {
  it("follows the first child of every split for the top-left panel", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const split = asSplit(moveTab(start, start.tabs[1]!.id, start.id, "right"));
    expect(findTopLeftPanelId(split)).toBe(asPanel(split.children[0]).id);
  });

  it("counts both children of a row split but only the top of a column split", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const rowSplit = asSplit(moveTab(start, start.tabs[1]!.id, start.id, "right"));
    // Both sides of a row split reach the top edge.
    expect(topEdgePanelIds(rowSplit).size).toBe(2);

    const colStart = asPanel(defaultLayout(["c1", "c2"]));
    const colSplit = asSplit(moveTab(colStart, colStart.tabs[1]!.id, colStart.id, "bottom"));
    // Only the top panel of a column split does.
    const topEdge = topEdgePanelIds(colSplit);
    expect(topEdge.size).toBe(1);
    expect(topEdge.has(asPanel(colSplit.children[0]).id)).toBe(true);
  });

  it("counts both children of a column split but only the left of a row split", () => {
    const start = asPanel(defaultLayout(["c1", "c2"]));
    const rowSplit = asSplit(moveTab(start, start.tabs[1]!.id, start.id, "right"));
    const leftEdge = leftEdgePanelIds(rowSplit);
    expect(leftEdge.size).toBe(1);
    expect(leftEdge.has(asPanel(rowSplit.children[0]).id)).toBe(true);

    const colStart = asPanel(defaultLayout(["c1", "c2"]));
    const colSplit = asSplit(moveTab(colStart, colStart.tabs[1]!.id, colStart.id, "bottom"));
    expect(leftEdgePanelIds(colSplit).size).toBe(2);
  });
});

describe("reconcile", () => {
  it("drops chat tabs whose backing chat is gone", () => {
    const start = defaultLayout(["c1", "c2"]);
    const next = reconcile(start, ["c1"], []);
    expect(chatIdsOf(next)).toEqual(["c1"]);
  });

  it("appends live chats that aren't represented yet, into the top-left panel", () => {
    const start = defaultLayout(["c1"]);
    const next = reconcile(start, ["c1", "c2"], []);
    expect(chatIdsOf(next)).toEqual(["c1", "c2"]);
  });

  it("keeps utility tabs regardless of the live resource sets", () => {
    const start = asPanel(defaultLayout(["c1"]));
    const withBrowser = asPanel(addTab(start, start.id, makeTab("browser")));
    const next = reconcile(withBrowser, ["c1"], []);
    expect(collectTabs(next).some((t) => t.kind === "browser")).toBe(true);
  });

  it("drops terminal tabs whose terminal is gone but keeps live ones", () => {
    const start = asPanel(defaultLayout([]));
    const withTerms = asPanel(
      addTab(
        addTab(start, start.id, makeTab("terminal", "t1")),
        start.id,
        makeTab("terminal", "t2"),
      ),
    );
    const next = reconcile(withTerms, [], ["t2"]);
    const termIds = collectTabs(next)
      .filter((t) => t.kind === "terminal")
      .map((t) => t.resourceId);
    expect(termIds).toEqual(["t2"]);
  });
});
