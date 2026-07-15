import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { diffProbeScript, parseWorkspaceDiff } from "../src/workspace-diff";

const RS = "\x1e";

// Build a probe-output string: one record-separated chunk per repo.
function probe(repos: Array<{ rel: string; patch: string }>): string {
  return repos.map(({ rel, patch }) => `${RS}${rel}\n${patch}`).join("");
}

describe("parseWorkspaceDiff", () => {
  it("parses a modified file into hunks with add/delete counts", () => {
    const patch = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@ export function foo() {",
      " const a = 1;",
      "-  return a;",
      "+  return a + 1;",
      " }",
      "",
    ].join("\n");

    const { files, truncated } = parseWorkspaceDiff(probe([{ rel: ".", patch }]));
    expect(truncated).toBe(false);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe("src/foo.ts");
    expect(f.oldPath).toBeNull();
    expect(f.status).toBe("modified");
    expect(f.binary).toBe(false);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]!.header).toBe("@@ -1,3 +1,3 @@ export function foo() {");
    expect(f.hunks[0]!.lines).toEqual([" const a = 1;", "-  return a;", "+  return a + 1;", " }"]);
  });

  it("flags added and deleted files via their file-mode headers", () => {
    const added = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..89b24ec",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
    ].join("\n");
    const deleted = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 89b24ec..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
    ].join("\n");

    const { files } = parseWorkspaceDiff(probe([{ rel: ".", patch: `${added}\n${deleted}\n` }]));
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["new.txt", "added", 2, 0],
      ["gone.txt", "deleted", 0, 1],
    ]);
  });

  it("treats an untracked --no-index file (no mode line) as added", () => {
    // `git diff --no-index /dev/null <file>` omits the "new file mode" line, so
    // the /dev/null old side is the only add signal.
    const patch = [
      "diff --git a/untracked.md b/untracked.md",
      "new file mode 100644",
      "index 0000000..0cfbf08",
      "--- /dev/null",
      "+++ b/untracked.md",
      "@@ -0,0 +1 @@",
      "+fresh",
      "\\ No newline at end of file",
    ].join("\n");
    const { files } = parseWorkspaceDiff(probe([{ rel: ".", patch }]));
    expect(files).toHaveLength(1);
    expect(files[0]!.status).toBe("added");
    expect(files[0]!.additions).toBe(1);
    // The "\ No newline" note is kept as a line but not counted as an addition.
    expect(files[0]!.hunks[0]!.lines).toContain("\\ No newline at end of file");
  });

  it("captures renames with the previous path", () => {
    const patch = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 92%",
      "rename from old/name.ts",
      "rename to new/name.ts",
      "index 1111111..2222222 100644",
      "--- a/old/name.ts",
      "+++ b/new/name.ts",
      "@@ -1,1 +1,1 @@",
      "-const x = 1;",
      "+const x = 2;",
    ].join("\n");
    const { files } = parseWorkspaceDiff(probe([{ rel: ".", patch }]));
    expect(files[0]!.status).toBe("renamed");
    expect(files[0]!.path).toBe("new/name.ts");
    expect(files[0]!.oldPath).toBe("old/name.ts");
  });

  it("marks binary files and gives them no hunks", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const { files } = parseWorkspaceDiff(probe([{ rel: ".", patch }]));
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.hunks).toHaveLength(0);
    expect(files[0]!.additions).toBe(0);
  });

  it("prefixes paths with the repo location for non-root repos", () => {
    const patch = [
      "diff --git a/index.js b/index.js",
      "--- a/index.js",
      "+++ b/index.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const { files } = parseWorkspaceDiff(probe([{ rel: "service", patch }]));
    expect(files[0]!.path).toBe("service/index.js");
  });

  it("flattens files across multiple repos into one list", () => {
    const rootPatch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-a",
      "+A",
    ].join("\n");
    const subPatch = [
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-b",
      "+B",
    ].join("\n");
    const { files } = parseWorkspaceDiff(
      probe([
        { rel: ".", patch: rootPatch },
        { rel: "sub", patch: subPatch },
      ]),
    );
    expect(files.map((f) => f.path)).toEqual(["a.txt", "sub/b.txt"]);
  });

  it("clips files past the per-file line cap and flags truncation", () => {
    const body = Array.from({ length: 10 }, (_, n) => `+line ${n}`).join("\n");
    const patch = [
      "diff --git a/big.txt b/big.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/big.txt",
      "@@ -0,0 +1,10 @@",
      body,
    ].join("\n");
    const { files, truncated } = parseWorkspaceDiff(probe([{ rel: ".", patch }]), 4);
    expect(truncated).toBe(true);
    expect(files[0]!.hunks[0]!.lines).toHaveLength(4);
    // Only the rendered (kept) lines are counted.
    expect(files[0]!.additions).toBe(4);
  });

  it("returns an empty list when there are no changes", () => {
    expect(parseWorkspaceDiff(`${RS}.\n`)).toEqual({
      files: [],
      truncated: false,
    });
    expect(parseWorkspaceDiff("")).toEqual({ files: [], truncated: false });
  });
});

// End-to-end check of the shell probe itself (the riskiest part, and the place
// a bashism slipped in once): run it under the real /bin/sh against a temp repo.
// Skipped where git isn't on PATH.
const hasGit = Bun.spawnSync(["git", "--version"]).exitCode === 0;

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function runProbe(root: string): WorkspaceDiffFile[] {
  const { stdout, exitCode } = Bun.spawnSync(["sh", "-c", diffProbeScript(root)]);
  expect(exitCode).toBe(0);
  return parseWorkspaceDiff(stdout.toString()).files;
}

type WorkspaceDiffFile = ReturnType<typeof parseWorkspaceDiff>["files"][number];

describe.if(hasGit)("diffProbeScript (shell)", () => {
  // PR-style: the base is the merge-base with the remote's default branch, so a
  // branch's committed work plus its uncommitted edits and untracked files all
  // show, even after work is committed (unlike the "unpushed" diff).
  it("diffs a feature branch against the remote default branch", () => {
    const root = mkdtempSync(join(tmpdir(), "wd-pr-"));
    try {
      git(root, "init", "-q", "-b", "main");
      writeFileSync(join(root, "a.txt"), "line1\nline2\n");
      git(root, "add", "a.txt");
      git(root, "commit", "-qm", "init");
      // Stand in for a remote default branch without needing a real one.
      git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      git(root, "checkout", "-q", "-b", "feature");
      writeFileSync(join(root, "a.txt"), "line1\nCHANGED\n"); // uncommitted edit
      writeFileSync(join(root, "b.txt"), "brand new\n"); // committed addition
      git(root, "add", "b.txt");
      git(root, "commit", "-qm", "add b");

      const files = runProbe(root);
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
      expect(byPath["a.txt"]?.status).toBe("modified");
      expect(byPath["b.txt"]?.status).toBe("added");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes untracked files as additions (POSIX sh, no bashisms)", () => {
    const root = mkdtempSync(join(tmpdir(), "wd-untracked-"));
    try {
      git(root, "init", "-q", "-b", "main");
      writeFileSync(join(root, "f.txt"), "x\n");
      git(root, "add", "f.txt");
      git(root, "commit", "-qm", "init");
      writeFileSync(join(root, "new.txt"), "fresh\n"); // never added

      const files = runProbe(root);
      expect(files.find((f) => f.path === "new.txt")?.status).toBe("added");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to HEAD when the repo has no remote", () => {
    const root = mkdtempSync(join(tmpdir(), "wd-noremote-"));
    try {
      git(root, "init", "-q", "-b", "main");
      writeFileSync(join(root, "f.txt"), "x\n");
      git(root, "add", "f.txt");
      git(root, "commit", "-qm", "init");
      writeFileSync(join(root, "f.txt"), "x\ny\n"); // uncommitted only

      const files = runProbe(root);
      expect(files.find((f) => f.path === "f.txt")?.status).toBe("modified");
      expect(files[0]!.additions).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
