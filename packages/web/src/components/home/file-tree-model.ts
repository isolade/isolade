// Pure, dependency-free model for the workspace file tree: path math and the
// flatten that turns the lazily-loaded directory map into a linear list of
// rows. Kept out of the component file so it imports no React/DOM/API code and
// can be unit-tested directly (and so rendering stays linear, see flattenRows).
import { type FileEntry, WORKSPACE_ROOT } from "../../lib/contracts";

// Per-directory load state, keyed by absolute path in the tree's `dirs` map.
export type DirState = {
  entries: FileEntry[] | null;
  loading: boolean;
  error: string | null;
};
export const EMPTY_DIR: DirState = {
  entries: null,
  loading: false,
  error: null,
};

// ---- path helpers (the VM filesystem is always POSIX) ----
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}
export function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? WORKSPACE_ROOT : p.slice(0, i);
}
export function relativeToRoot(p: string): string {
  if (p === WORKSPACE_ROOT) return "";
  return p.startsWith(`${WORKSPACE_ROOT}/`) ? p.slice(WORKSPACE_ROOT.length + 1) : p;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// A flattened, render-ready view of the currently-expanded tree. Walking the
// directory map into a flat list (rather than nesting components recursively)
// keeps rendering linear and structurally immune to the recursion loop a
// mis-threaded prop could otherwise cause.
export type VisibleRow =
  | { kind: "entry"; entry: FileEntry; depth: number }
  | { kind: "loading"; depth: number; key: string }
  | { kind: "error"; depth: number; key: string; message: string };

export function flattenRows(
  dirs: Record<string, DirState>,
  expanded: Set<string>,
  dir: string = WORKSPACE_ROOT,
  depth = 0,
  out: VisibleRow[] = [],
): VisibleRow[] {
  const state = dirs[dir] ?? EMPTY_DIR;
  if (state.entries) {
    for (const entry of state.entries) {
      out.push({ kind: "entry", entry, depth });
      // Recurse only into expanded directories. Children always have strictly
      // longer paths than their parent, so this terminates.
      if (entry.type === "dir" && expanded.has(entry.path)) {
        flattenRows(dirs, expanded, entry.path, depth + 1, out);
      }
    }
  } else if (state.loading) {
    out.push({ kind: "loading", depth, key: `loading:${dir}` });
  } else if (state.error) {
    out.push({
      kind: "error",
      depth,
      key: `error:${dir}`,
      message: state.error,
    });
  }
  return out;
}
