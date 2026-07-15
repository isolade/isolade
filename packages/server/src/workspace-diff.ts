import {
  type DiffFile,
  type DiffFileStatus,
  type DiffHunk,
  WORKSPACE_ROOT,
  type WorkspaceDiff,
} from "./contracts";
import type { SandboxApi } from "./sandbox-client";

// Bound the probe so a wedged guest or a pathologically large repo can't hang
// the request forever. Diffing the whole branch is heavier than a single
// directory listing, so this is more generous than the file-tree timeout.
const DIFF_TIMEOUT_MS = 30_000;

// Cap per-file rendering. A 50k-line vendored lockfile shouldn't ship every
// line over JSON and freeze the panel. Beyond this the file is clipped and the
// whole response is flagged `truncated`.
const MAX_DIFF_LINES_PER_FILE = 2000;

// Record separator emitted by the probe before each repo's chunk. It never
// appears in normal source or diff output, so the parser can split on it
// without colliding with file contents.
const REPO_SEP = "\x1e";

// Shell probe run inside the VM via the sandbox's `/bin/sh -c` exec. Visits
// every git repo at /workspace or one level below (matching the file-tree and
// diff-stats probes), and for each emits a record-separator + the repo's path
// relative to /workspace, then its PR-style diff.
//
// "PR-style" means: what this branch would introduce in a pull request against
// its base branch, so the base is the merge-base of HEAD with the remote's
// default branch (origin/HEAD, falling back to origin/main, origin/master, and
// finally the local equivalents). This is deliberately NOT the "unpushed work"
// base used by diff-stats: a reviewer wants the whole branch, pushed or not.
//
// The diff covers committed work plus the working tree (`git diff <base>`
// already folds in staged and unstaged edits), and untracked files are appended
// as additions via `--no-index` against /dev/null so freshly-created files
// (the common case for an agent that hasn't committed) still show up.
// `--exclude-standard` keeps gitignored bulk (node_modules, build output) out.
//
// Trailing `true` so the loop's last command (often `git diff`, which exits 1
// when there are differences) doesn't make the whole exec look like a failure.
export function diffProbeScript(root = WORKSPACE_ROOT): string {
  return `
for g in ${root}/.git ${root}/*/.git; do
  [ -e "$g" ] || continue
  r="\${g%/.git}"
  rel="\${r#${root}}"; rel="\${rel#/}"; [ -n "$rel" ] || rel="."
  ref=$(git -C "$r" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -z "$ref" ]; then
    for b in origin/main origin/master main master; do
      if git -C "$r" rev-parse --verify --quiet "$b" >/dev/null 2>&1; then ref="$b"; break; fi
    done
  fi
  [ -n "$ref" ] || ref=HEAD
  base=$(git -C "$r" merge-base "$ref" HEAD 2>/dev/null)
  [ -n "$base" ] || base="$ref"
  printf '${REPO_SEP}%s\\n' "$rel"
  git -C "$r" -c core.quotepath=false diff --find-renames --no-color "$base" 2>/dev/null
  git -C "$r" -c core.quotepath=false ls-files --others --exclude-standard 2>/dev/null |
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      git -C "$r" -c core.quotepath=false diff --no-color --no-index -- /dev/null "$f" 2>/dev/null
    done
done
true
`.trim();
}

// Strip a leading `a/` or `b/` path prefix that `git diff` adds in its `---` /
// `+++` and `diff --git` lines.
function stripPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

// A `---` / `+++` path: trim a trailing tab+timestamp (some git configs add
// one), surface /dev/null as null (the file didn't exist on that side), and
// drop the a//b/ prefix otherwise.
function headerPath(raw: string): { path: string | null; devNull: boolean } {
  const p = raw.replace(/\t.*$/, "").trimEnd();
  if (p === "/dev/null") return { path: null, devNull: true };
  return { path: stripPrefix(p), devNull: false };
}

// Best-effort fallback when neither rename headers nor `---`/`+++` gave us a
// path (e.g. a mode-only change): pull both sides out of the `diff --git` line.
// Paths with spaces are ambiguous here, so this is only a last resort.
function pathsFromGitLine(line: string): {
  old: string | null;
  next: string | null;
} {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!m) return { old: null, next: null };
  return { old: m[1] ?? null, next: m[2] ?? null };
}

// Parse one repo's `git diff` output into structured files, prefixing every
// path with `prefix` (the repo's location relative to /workspace, "" for the
// root repo). Pure and synchronous so it can be unit-tested without a VM.
function parseRepoDiff(
  patch: string,
  prefix: string,
  maxLinesPerFile: number,
): { files: DiffFile[]; truncated: boolean } {
  const lines = patch.split("\n");
  const files: DiffFile[] = [];
  let truncated = false;

  let i = 0;
  while (i < lines.length) {
    const gitLine = lines[i];
    if (gitLine === undefined || !gitLine.startsWith("diff --git ")) {
      i++;
      continue;
    }
    i++;

    let status: DiffFileStatus = "modified";
    let binary = false;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let oldDevNull = false;
    let newDevNull = false;

    // Header block: everything up to the first hunk or the next file.
    while (i < lines.length) {
      const l = lines[i];
      if (l === undefined || l.startsWith("@@") || l.startsWith("diff --git ")) break;
      if (l.startsWith("new file mode")) status = "added";
      else if (l.startsWith("deleted file mode")) status = "deleted";
      else if (l.startsWith("rename from ")) {
        renameFrom = l.slice("rename from ".length);
        status = "renamed";
      } else if (l.startsWith("rename to ")) {
        renameTo = l.slice("rename to ".length);
        status = "renamed";
      } else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) {
        binary = true;
      } else if (l.startsWith("--- ")) {
        const h = headerPath(l.slice(4));
        oldPath = h.path;
        oldDevNull = h.devNull;
      } else if (l.startsWith("+++ ")) {
        const h = headerPath(l.slice(4));
        newPath = h.path;
        newDevNull = h.devNull;
      }
      i++;
    }

    // `--no-index` added files (untracked) carry no "new file mode" line, so infer
    // add/delete from the /dev/null side instead.
    if (status === "modified") {
      if (oldDevNull && !newDevNull) status = "added";
      else if (newDevNull && !oldDevNull) status = "deleted";
    }

    // Hunks.
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    let renderedLines = 0;
    while (i < lines.length) {
      const header = lines[i];
      if (header === undefined || !header.startsWith("@@")) break;
      i++;
      const hunkLines: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l === undefined || l.startsWith("@@") || l.startsWith("diff --git ")) break;
        const c = l[0];
        // Hunk body lines begin with a space, +, -, or \ (the no-newline note).
        // Anything else (including the trailing empty string from the final
        // newline) ends the hunk.
        if (c !== " " && c !== "+" && c !== "-" && c !== "\\") break;
        if (renderedLines < maxLinesPerFile) {
          hunkLines.push(l);
          if (c === "+") additions++;
          else if (c === "-") deletions++;
        } else {
          truncated = true;
        }
        renderedLines++;
        i++;
      }
      if (hunkLines.length > 0) hunks.push({ header, lines: hunkLines });
    }

    // Resolve the display paths from the strongest signal available.
    const fallback = pathsFromGitLine(gitLine);
    const resolvedOld = renameFrom ?? oldPath ?? (fallback.old ? stripPrefix(fallback.old) : null);
    const resolvedNew = renameTo ?? newPath ?? (fallback.next ? stripPrefix(fallback.next) : null);
    const apply = (p: string | null) => (p == null ? null : prefix + p);

    let path: string;
    let displayOld: string | null = null;
    if (status === "renamed") {
      path = apply(resolvedNew) ?? "";
      displayOld = apply(resolvedOld);
    } else if (status === "deleted") {
      path = apply(resolvedOld ?? resolvedNew) ?? "";
    } else {
      path = apply(resolvedNew ?? resolvedOld) ?? "";
    }

    files.push({
      path,
      oldPath: displayOld,
      status,
      binary,
      additions,
      deletions,
      hunks,
    });
  }

  return { files, truncated };
}

// Parse the full probe output (every repo's chunk, record-separated) into a
// single flat file list. Exported for unit tests.
export function parseWorkspaceDiff(
  stdout: string,
  maxLinesPerFile = MAX_DIFF_LINES_PER_FILE,
): WorkspaceDiff {
  const files: DiffFile[] = [];
  let truncated = false;
  for (const chunk of stdout.split(REPO_SEP)) {
    if (chunk.length === 0) continue;
    const nl = chunk.indexOf("\n");
    const rel = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    const patch = nl === -1 ? "" : chunk.slice(nl + 1);
    const prefix = rel && rel !== "." ? `${rel}/` : "";
    const res = parseRepoDiff(patch, prefix, maxLinesPerFile);
    files.push(...res.files);
    truncated = truncated || res.truncated;
  }
  return { files, truncated };
}

// Produces the PR-style review diff for a VM's workspace. Stateless beyond the
// sandbox handle + root, mirroring WorkspaceFiles: every call takes the vmId so
// one instance serves every running VM.
export class WorkspaceDiffReader {
  private readonly probe: string;

  constructor(
    private readonly sandbox: SandboxApi,
    root: string = WORKSPACE_ROOT,
  ) {
    this.probe = diffProbeScript(root);
  }

  async get(vmId: string): Promise<WorkspaceDiff> {
    const { stdout, stderr, exitCode } = await this.sandbox.exec(vmId, this.probe, {
      timeoutMs: DIFF_TIMEOUT_MS,
    });
    // The script ends in `true`, so a non-zero exit is a real exec failure
    // (e.g. the VM is gone), not just "git diff found differences".
    if (exitCode !== 0) throw new Error(stderr.trim() || `diff probe exited ${exitCode}`);
    return parseWorkspaceDiff(stdout);
  }
}
