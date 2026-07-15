import { describe, expect, it } from "bun:test";
import {
  type DirState,
  flattenRows,
  type VisibleRow,
} from "../src/components/home/file-tree-model";
import type { FileEntry } from "../src/lib/contracts";

// The file tree renders by flattening the expanded directory map into a linear
// list of rows. These tests pin down that walk: every row must report its OWN
// entry at its OWN depth (the bug that froze the app was a child row inheriting
// its parent's identity and recursing forever), and the walk must terminate.

const ROOT = "/workspace";
const dir = (name: string, parent = ROOT): FileEntry => ({
  name,
  path: `${parent}/${name}`,
  type: "dir",
  size: null,
});
const file = (name: string, size = 0, parent = ROOT): FileEntry => ({
  name,
  path: `${parent}/${name}`,
  type: "file",
  size,
});
const loaded = (entries: FileEntry[]): DirState => ({
  entries,
  loading: false,
  error: null,
});
const entries = (rows: VisibleRow[]) =>
  rows.filter((r): r is Extract<VisibleRow, { kind: "entry" }> => r.kind === "entry");

describe("flattenRows", () => {
  it("lists the root's children at depth 0", () => {
    const dirs = { [ROOT]: loaded([dir("src"), file("readme.md", 12)]) };
    const rows = flattenRows(dirs, new Set());
    expect(entries(rows).map((r) => [r.entry.name, r.depth])).toEqual([
      ["src", 0],
      ["readme.md", 0],
    ]);
  });

  it("descends only into expanded directories, with increasing depth", () => {
    const dirs = {
      [ROOT]: loaded([dir("src"), dir("docs")]),
      "/workspace/src": loaded([file("index.ts"), dir("lib", "/workspace/src")]),
      "/workspace/src/lib": loaded([file("util.ts", 0, "/workspace/src/lib")]),
      // docs is loaded but NOT expanded, so its children must not appear.
      "/workspace/docs": loaded([file("guide.md", 0, "/workspace/docs")]),
    };
    const expanded = new Set(["/workspace/src", "/workspace/src/lib"]);
    const rows = entries(flattenRows(dirs, expanded));
    expect(rows.map((r) => [r.entry.name, r.depth])).toEqual([
      ["src", 0],
      ["index.ts", 1],
      ["lib", 1],
      ["util.ts", 2],
      ["docs", 0],
    ]);
    // Every row carries its own path, never a parent's (the freeze bug).
    expect(rows.find((r) => r.entry.name === "util.ts")!.entry.path).toBe(
      "/workspace/src/lib/util.ts",
    );
  });

  it("emits a loading placeholder for an expanded-but-unloaded directory", () => {
    const dirs: Record<string, DirState> = {
      [ROOT]: loaded([dir("src")]),
      "/workspace/src": { entries: null, loading: true, error: null },
    };
    const rows = flattenRows(dirs, new Set(["/workspace/src"]));
    expect(rows.map((r) => r.kind)).toEqual(["entry", "loading"]);
    expect(rows[1]).toMatchObject({ kind: "loading", depth: 1 });
  });

  it("emits an error placeholder when a directory failed to load", () => {
    const dirs: Record<string, DirState> = {
      [ROOT]: loaded([dir("src")]),
      "/workspace/src": { entries: null, loading: false, error: "boom" },
    };
    const rows = flattenRows(dirs, new Set(["/workspace/src"]));
    expect(rows[1]).toMatchObject({ kind: "error", depth: 1, message: "boom" });
  });

  it("terminates and ignores expanded dirs whose data isn't present", () => {
    // 'ghost' is expanded but absent from the map, so it must not loop or throw.
    const dirs = { [ROOT]: loaded([dir("ghost")]) };
    const rows = flattenRows(dirs, new Set(["/workspace/ghost"]));
    expect(entries(rows).map((r) => r.entry.name)).toEqual(["ghost"]);
  });

  it("returns nothing when the root itself hasn't loaded", () => {
    expect(flattenRows({}, new Set())).toEqual([]);
  });
});
