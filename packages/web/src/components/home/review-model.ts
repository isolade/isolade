// Pure, dependency-free model for the Review tab: turn a parsed diff hunk into
// the rows the renderer draws, recomputing the old/new gutter line numbers from
// the hunk header. Kept out of the component so it imports no React/DOM and can
// be unit-tested directly.
import type { DiffFile, DiffHunk } from "../../lib/contracts";

// A single rendered diff line.
//   context: unchanged, shown in both columns
//   add:     present only in the new file
//   del:     present only in the old file
//   meta:    the "\ No newline at end of file" note, with no line number, no count
export type DiffRowType = "context" | "add" | "del" | "meta";

export interface DiffRow {
  type: DiffRowType;
  // Gutter numbers, null where the line doesn't exist on that side.
  oldNo: number | null;
  newNo: number | null;
  // The line content with its leading +/-/space marker stripped.
  text: string;
}

// Just the start line numbers of a hunk, for the row-numbering walk. A thin
// projection of parseHunkRange so the header format is parsed in exactly one
// place. Returns null if the header doesn't match, so the caller can fall back.
export function parseHunkHeader(header: string): { oldStart: number; newStart: number } | null {
  const range = parseHunkRange(header);
  return range && { oldStart: range.oldStart, newStart: range.newStart };
}

// The full line span of a hunk on both sides, parsed from its header. Counts
// default to 1 when the format omits them. `oldEnd`/`newEnd` are inclusive (a
// zero-count side, like the new side of a pure deletion, yields end = start-1).
export interface HunkRange {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export function parseHunkRange(header: string): HunkRange | null {
  const m = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  const oldStart = Number(m[1]);
  const oldCount = m[2] === undefined ? 1 : Number(m[2]);
  const newStart = Number(m[3]);
  const newCount = m[4] === undefined ? 1 : Number(m[4]);
  return {
    oldStart,
    oldEnd: oldStart + oldCount - 1,
    newStart,
    newEnd: newStart + newCount - 1,
  };
}

// An expandable run of unchanged lines around the hunks of a file. Identified by
// its new-file line span [nStart, nEnd]. `nEnd` is null for the trailing region
// (its end, the file's EOF, isn't known until we read it). `delta` is the
// constant offset from new to old line numbers within the region, since the
// lines are unchanged: oldNo = newNo + delta.
export interface GapRegion {
  id: number;
  kind: "leading" | "between" | "trailing";
  nStart: number;
  nEnd: number | null;
  delta: number;
}

export type DiffSegment = { kind: "hunk"; hunk: DiffHunk } | { kind: "gap"; region: GapRegion };

// Interleave a file's hunks with the expandable gaps around them (before the
// first hunk, between consecutive hunks, and after the last). Only modified and
// renamed files get gaps: added/deleted files are already shown whole, and a
// deleted file has no worktree to read context from. Pure so it can be tested
// without a VM.
export function fileSegments(file: DiffFile): DiffSegment[] {
  if (file.status !== "modified" && file.status !== "renamed") {
    return file.hunks.map((hunk) => ({ kind: "hunk", hunk }));
  }
  const ranges = file.hunks.map((hunk) => ({
    hunk,
    range: parseHunkRange(hunk.header),
  }));
  const segments: DiffSegment[] = [];
  let id = 0;
  for (const [i, entry] of ranges.entries()) {
    const { hunk, range } = entry;
    if (range) {
      if (i === 0) {
        if (range.newStart > 1) {
          segments.push({
            kind: "gap",
            region: {
              id: id++,
              kind: "leading",
              nStart: 1,
              nEnd: range.newStart - 1,
              delta: range.oldStart - range.newStart,
            },
          });
        }
      } else {
        const prev = ranges[i - 1]?.range;
        if (prev && range.newStart > prev.newEnd + 1) {
          segments.push({
            kind: "gap",
            region: {
              id: id++,
              kind: "between",
              nStart: prev.newEnd + 1,
              nEnd: range.newStart - 1,
              delta: prev.oldEnd - prev.newEnd,
            },
          });
        }
      }
    }
    segments.push({ kind: "hunk", hunk });
  }
  const last = ranges[ranges.length - 1]?.range;
  if (last) {
    segments.push({
      kind: "gap",
      region: {
        id: id++,
        kind: "trailing",
        nStart: last.newEnd + 1,
        nEnd: null,
        delta: last.oldEnd - last.newEnd,
      },
    });
  }
  return segments;
}

// The next chunk of new-file line numbers to fetch when expanding a gap from a
// side. "top" grows the block just below the upper boundary; "bottom" grows the
// block just above the lower boundary. The trailing region only grows from the
// top (its lower end is the file's EOF, discovered as we read). Returns null
// when a bounded region is already fully revealed. Pure, so the arithmetic is
// unit-tested rather than buried in the component.
export function nextContextRange(
  region: GapRegion,
  topCount: number,
  bottomCount: number,
  side: "top" | "bottom",
  chunk: number,
): { from: number; to: number } | null {
  if (region.kind === "trailing" || region.nEnd === null) {
    const from = region.nStart + topCount;
    return { from, to: from + chunk - 1 };
  }
  const remaining = region.nEnd - region.nStart + 1 - topCount - bottomCount;
  if (remaining <= 0) return null;
  const take = Math.min(chunk, remaining);
  if (side === "top") {
    const from = region.nStart + topCount;
    return { from, to: from + take - 1 };
  }
  const to = region.nEnd - bottomCount;
  return { from: to - take + 1, to };
}

// Expand a hunk into numbered rows. Walks the lines tracking the running old and
// new line numbers: a context line advances both, an addition only the new
// side, a deletion only the old side.
export function hunkRows(hunk: DiffHunk): DiffRow[] {
  const start = parseHunkHeader(hunk.header);
  let oldNo = start?.oldStart ?? 0;
  let newNo = start?.newStart ?? 0;
  const rows: DiffRow[] = [];
  for (const line of hunk.lines) {
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      rows.push({ type: "add", oldNo: null, newNo, text });
      newNo++;
    } else if (marker === "-") {
      rows.push({ type: "del", oldNo, newNo: null, text });
      oldNo++;
    } else if (marker === "\\") {
      // "\ No newline at end of file", which annotates the preceding line.
      rows.push({
        type: "meta",
        oldNo: null,
        newNo: null,
        text: line.slice(2),
      });
    } else {
      // Context (leading space). An empty string defends against a stray line.
      rows.push({ type: "context", oldNo, newNo, text });
      oldNo++;
      newNo++;
    }
  }
  return rows;
}

// Map a file path to a highlight.js language id for syntax highlighting, or
// null when we don't recognise it (the renderer then shows plain text). Pure
// and dependency-free so it can be unit-tested. The syntax module still guards
// every id against lowlight's registry, so an id missing from the bundled
// language set degrades to plain text rather than throwing.
//
// Ids resolve against lowlight's `common` set, e.g. TOML rides on `ini`, and
// there's no dedicated tsx/jsx grammar, so those map to their base language.
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  m: "objectivec",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  md: "markdown",
  markdown: "markdown",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
};

// Filenames with no useful extension that still have a known grammar.
const FILENAME_LANGUAGE: Record<string, string> = {
  makefile: "makefile",
  gnumakefile: "makefile",
};

export function languageForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const byName = FILENAME_LANGUAGE[base];
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like ".gitignore"
  return EXTENSION_LANGUAGE[base.slice(dot + 1)] ?? null;
}

// Short status label for a file's pill (GitHub-style).
export function statusLabel(file: DiffFile): string {
  switch (file.status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    default:
      return "Modified";
  }
}
