import { describe, expect, it } from "bun:test";
import {
  fileSegments,
  type GapRegion,
  hunkRows,
  languageForPath,
  nextContextRange,
  parseHunkHeader,
  parseHunkRange,
} from "../src/components/home/review-model";
import type { DiffFile, DiffHunk } from "../src/lib/contracts";

// A modified-file fixture whose hunks have the given new-line spans (each hunk's
// content is irrelevant to fileSegments, which works off the headers).
function fileWithHunks(headers: string[], status: DiffFile["status"] = "modified"): DiffFile {
  return {
    path: "src/x.ts",
    oldPath: null,
    status,
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: headers.map((header) => ({ header, lines: [] })),
  };
}

describe("parseHunkHeader", () => {
  it("reads the old/new start lines", () => {
    expect(parseHunkHeader("@@ -12,3 +15,4 @@ fn foo()")).toEqual({
      oldStart: 12,
      newStart: 15,
    });
  });

  it("defaults missing counts (single-line hunks)", () => {
    expect(parseHunkHeader("@@ -0,0 +1 @@")).toEqual({
      oldStart: 0,
      newStart: 1,
    });
  });

  it("returns null for a non-hunk line", () => {
    expect(parseHunkHeader("not a hunk")).toBeNull();
  });
});

describe("hunkRows", () => {
  it("numbers context, additions, and deletions independently", () => {
    const hunk: DiffHunk = {
      header: "@@ -10,3 +10,3 @@",
      lines: [" const a = 1;", "-  return a;", "+  return a + 1;", " }"],
    };
    expect(hunkRows(hunk)).toEqual([
      { type: "context", oldNo: 10, newNo: 10, text: "const a = 1;" },
      { type: "del", oldNo: 11, newNo: null, text: "  return a;" },
      { type: "add", oldNo: null, newNo: 11, text: "  return a + 1;" },
      { type: "context", oldNo: 12, newNo: 12, text: "}" },
    ]);
  });

  it("numbers a pure addition from line 1", () => {
    const hunk: DiffHunk = {
      header: "@@ -0,0 +1,2 @@",
      lines: ["+hello", "+world"],
    };
    expect(hunkRows(hunk)).toEqual([
      { type: "add", oldNo: null, newNo: 1, text: "hello" },
      { type: "add", oldNo: null, newNo: 2, text: "world" },
    ]);
  });

  it("treats the no-newline note as an uncounted meta row", () => {
    const hunk: DiffHunk = {
      header: "@@ -1 +1 @@",
      lines: ["-old", "+new", "\\ No newline at end of file"],
    };
    const rows = hunkRows(hunk);
    expect(rows[2]).toEqual({
      type: "meta",
      oldNo: null,
      newNo: null,
      text: "No newline at end of file",
    });
    // The meta row didn't advance either gutter.
    expect(rows[0].oldNo).toBe(1);
    expect(rows[1].newNo).toBe(1);
  });
});

describe("parseHunkRange", () => {
  it("computes inclusive end lines from start + count", () => {
    expect(parseHunkRange("@@ -10,3 +20,4 @@")).toEqual({
      oldStart: 10,
      oldEnd: 12,
      newStart: 20,
      newEnd: 23,
    });
  });
  it("defaults omitted counts to 1", () => {
    expect(parseHunkRange("@@ -5 +7 @@")).toEqual({
      oldStart: 5,
      oldEnd: 5,
      newStart: 7,
      newEnd: 7,
    });
  });
});

describe("fileSegments", () => {
  it("emits leading, between, and trailing gaps around the hunks", () => {
    // Hunk A covers new lines 10–12, hunk B covers 30–31.
    const segments = fileSegments(fileWithHunks(["@@ -10,3 +10,3 @@", "@@ -30,2 +30,2 @@"]));
    const kinds = segments.map((s) => (s.kind === "gap" ? `gap:${s.region.kind}` : "hunk"));
    expect(kinds).toEqual(["gap:leading", "hunk", "gap:between", "hunk", "gap:trailing"]);

    const gaps = segments
      .filter((s) => s.kind === "gap")
      .map((s) => (s as { region: unknown }).region);
    expect(gaps[0]).toMatchObject({
      kind: "leading",
      nStart: 1,
      nEnd: 9,
      delta: 0,
    });
    expect(gaps[1]).toMatchObject({
      kind: "between",
      nStart: 13,
      nEnd: 29,
      delta: 0,
    });
    expect(gaps[2]).toMatchObject({
      kind: "trailing",
      nStart: 32,
      nEnd: null,
      delta: 0,
    });
  });

  it("omits the leading gap when the first hunk starts at line 1, and adjacent hunks have no between gap", () => {
    const segments = fileSegments(fileWithHunks(["@@ -1,3 +1,3 @@", "@@ -4,2 +4,2 @@"]));
    expect(segments.map((s) => (s.kind === "gap" ? `gap:${s.region.kind}` : "hunk"))).toEqual([
      "hunk",
      "hunk",
      "gap:trailing",
    ]);
  });

  it("tracks the new→old delta when earlier hunks changed the line count", () => {
    // First hunk adds 2 lines (old 5 lines → new 7), so after it new is 2 ahead
    // of old: a between/trailing gap's delta should be -2 (old = new - 2).
    const segments = fileSegments(fileWithHunks(["@@ -1,5 +1,7 @@", "@@ -20,2 +22,2 @@"]));
    const gaps = segments
      .filter((s) => s.kind === "gap")
      .map((s) => (s as { region: { kind: string; delta: number } }).region);
    expect(gaps.find((g) => g.kind === "between")?.delta).toBe(-2);
    expect(gaps.find((g) => g.kind === "trailing")?.delta).toBe(-2);
  });

  it("produces no gaps for added or deleted files", () => {
    expect(
      fileSegments(fileWithHunks(["@@ -0,0 +1,3 @@"], "added")).every((s) => s.kind === "hunk"),
    ).toBe(true);
    expect(
      fileSegments(fileWithHunks(["@@ -1,3 +0,0 @@"], "deleted")).every((s) => s.kind === "hunk"),
    ).toBe(true);
  });
});

describe("nextContextRange", () => {
  // A between gap spanning new lines 13..40 (28 hidden lines).
  const between: GapRegion = {
    id: 0,
    kind: "between",
    nStart: 13,
    nEnd: 40,
    delta: 0,
  };

  it("reveals the top chunk just below the upper boundary", () => {
    expect(nextContextRange(between, 0, 0, "top", 20)).toEqual({
      from: 13,
      to: 32,
    });
    // After 20 revealed at the top, the next top chunk starts at 33.
    expect(nextContextRange(between, 20, 0, "top", 20)).toEqual({
      from: 33,
      to: 40,
    });
  });

  it("reveals the bottom chunk just above the lower boundary, growing upward", () => {
    expect(nextContextRange(between, 0, 0, "bottom", 20)).toEqual({
      from: 21,
      to: 40,
    });
    expect(nextContextRange(between, 0, 20, "bottom", 20)).toEqual({
      from: 13,
      to: 20,
    });
  });

  it("clamps the final chunk to the lines that remain and then returns null", () => {
    // 28 total, 20 from top already → 8 remain.
    expect(nextContextRange(between, 20, 0, "bottom", 20)).toEqual({
      from: 33,
      to: 40,
    });
    expect(nextContextRange(between, 20, 8, "top", 20)).toBeNull();
  });

  it("grows the trailing region from the top without an end bound", () => {
    const trailing: GapRegion = {
      id: 1,
      kind: "trailing",
      nStart: 50,
      nEnd: null,
      delta: -3,
    };
    expect(nextContextRange(trailing, 0, 0, "top", 20)).toEqual({
      from: 50,
      to: 69,
    });
    expect(nextContextRange(trailing, 20, 0, "top", 20)).toEqual({
      from: 70,
      to: 89,
    });
  });
});

describe("languageForPath", () => {
  it("maps common extensions to highlight.js languages", () => {
    expect(languageForPath("src/app.ts")).toBe("typescript");
    expect(languageForPath("a/b/Component.tsx")).toBe("typescript");
    expect(languageForPath("main.py")).toBe("python");
    expect(languageForPath("lib.rs")).toBe("rust");
    expect(languageForPath("style.scss")).toBe("scss");
  });

  it("normalises case and folds related formats onto a base grammar", () => {
    expect(languageForPath("Config.TOML")).toBe("ini"); // toml rides on ini
    expect(languageForPath("page.HTML")).toBe("xml");
  });

  it("recognises extensionless filenames with a known grammar", () => {
    expect(languageForPath("Makefile")).toBe("makefile");
    expect(languageForPath("repo/GNUmakefile")).toBe("makefile");
  });

  it("returns null for unknown extensions and dotfiles", () => {
    expect(languageForPath("data.bin")).toBeNull();
    expect(languageForPath(".gitignore")).toBeNull();
    expect(languageForPath("LICENSE")).toBeNull();
  });
});
