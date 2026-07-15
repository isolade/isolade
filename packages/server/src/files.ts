import path from "node:path";
import { type FileEntry, type FileLines, type FileListing, WORKSPACE_ROOT } from "./contracts";
import type { SandboxApi } from "./sandbox-client";

// Bound every file operation so a single huge directory or a wedged guest can't
// hang a request indefinitely.
const FILE_OP_TIMEOUT_MS = 15_000;

// Most a single context-expansion request may pull, so a crafted range can't
// stream a whole giant file back over JSON. The Review tab reveals context in
// chunks well under this.
export const MAX_CONTEXT_LINES = 1000;

// Record separator the readLines probe appends after the line range to carry an
// end-of-file marker. It never appears in source, so it can't collide with file
// contents.
const LINE_RANGE_SEP = "\x1e";

// Uploads are read fully into memory (base64 over JSON), so cap them. A dev
// workspace browser is for source/config, not shipping disk images around.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Exit-code sentinels emitted by the shell snippets below, mapped to HTTP
// statuses by the route layer via FileError.status.
const EXIT_NOT_FOUND = 2;
const EXIT_EXISTS = 17;

// A file operation that failed in a way worth reporting to the client with a
// specific status (e.g. "not a directory" → 404, "already exists" → 409).
export class FileError extends Error {
  constructor(
    message: string,
    readonly status: number = 500,
  ) {
    super(message);
    this.name = "FileError";
  }
}

// POSIX single-quote: wrap in '…' and escape embedded quotes. Safe for any
// byte except NUL (which can't appear in a path anyway).
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Browses and mutates a VM's workspace filesystem on behalf of the file tree.
// Stateless beyond the sandbox handle + root: every method takes the vmId so a
// single instance can serve every running VM. All paths are normalized and
// confined to `root` (default /workspace) before any shell ever sees them, so a
// crafted `../../etc/passwd` is rejected at the door rather than relying on the
// guest to be careful.
export class WorkspaceFiles {
  constructor(
    private readonly sandbox: SandboxApi,
    private readonly root: string = WORKSPACE_ROOT,
  ) {}

  // Resolve a client-supplied path against the root and confirm it stays
  // inside it. Accepts absolute paths (what the tree sends back) and relative
  // ones alike. `..` segments are collapsed by resolve(), and anything that
  // climbs out of root is rejected. Symlinks inside the VM could still point
  // outward, but the VM is the sandbox boundary, not this check.
  private confine(input: string): string {
    const abs = path.posix.resolve(this.root, input || ".");
    if (abs !== this.root && !abs.startsWith(`${this.root}/`)) {
      throw new FileError(`path escapes the workspace root: ${input}`, 400);
    }
    return abs;
  }

  private async run(
    vmId: string,
    script: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.sandbox.exec(vmId, script, { timeoutMs: FILE_OP_TIMEOUT_MS });
  }

  // Immediate children of a directory, directories first then case-insensitive
  // by name. Records are NUL-separated and fields tab-separated so newlines in
  // names survive (tabs in names are pathological and degrade gracefully).
  async list(vmId: string, dir: string): Promise<FileListing> {
    const abs = this.confine(dir);
    const script = [
      `d=${shq(abs)}`,
      `[ -d "$d" ] || exit ${EXIT_NOT_FOUND}`,
      `cd "$d" 2>/dev/null || exit ${EXIT_NOT_FOUND}`,
      `for f in * .*; do`,
      `  case "$f" in .|..) continue;; esac`,
      `  if [ -d "$f" ]; then printf 'd\\t0\\t%s\\0' "$f";`,
      // GNU/busybox stat takes -c. BSD stat (e.g. a macOS dev host) takes -f.
      // Try both, falling back to 0 so an odd file never breaks the listing.
      `  elif [ -e "$f" ] || [ -L "$f" ]; then printf 'f\\t%s\\t%s\\0' "$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)" "$f";`,
      `  fi`,
      `done`,
    ].join("\n");

    const { stdout, stderr, exitCode } = await this.run(vmId, script);
    if (exitCode === EXIT_NOT_FOUND) throw new FileError(`not a directory: ${abs}`, 404);
    if (exitCode !== 0)
      throw new FileError(stderr.trim() || `listing failed (exit ${exitCode})`, 500);

    const entries: FileEntry[] = [];
    for (const record of stdout.split("\0")) {
      if (!record) continue;
      const parts = record.split("\t");
      if (parts.length < 3) continue;
      const [type, size, ...nameParts] = parts;
      const name = nameParts.join("\t");
      if (!name) continue;
      entries.push({
        name,
        path: path.posix.join(abs, name),
        type: type === "d" ? "dir" : "file",
        size: type === "d" ? null : Number(size) || 0,
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "accent" });
    });
    return { path: abs, entries };
  }

  // Read an inclusive 1-based line range [start, end] from a workspace file.
  // Backs the Review tab's "expand context" controls: the lines outside a diff
  // hunk are unchanged, so the worktree file (addressed by new-file line number)
  // is the right source. `eof` reports whether the file has any lines past
  // `end`. The awk bails the moment it sees line end+1, so this stays cheap even
  // on large files. Callers must validate/bound the range (see MAX_CONTEXT_LINES).
  async readLines(vmId: string, target: string, start: number, end: number): Promise<FileLines> {
    const abs = this.confine(target);
    const script = [
      `d=${shq(abs)}`,
      `[ -f "$d" ] || exit ${EXIT_NOT_FOUND}`,
      // Print the requested range, bailing the moment line end+1 shows up so big
      // files aren't scanned to the end. END runs even on `exit`, so the marker
      // is emitted once there, keyed on whether we saw a line past `end`.
      `awk 'NR>=${start} && NR<=${end}{print} NR==${end + 1}{found=1; exit} END{printf "${LINE_RANGE_SEP}%s", (found?"more":"eof")}' "$d"`,
    ].join("\n");
    const { stdout, stderr, exitCode } = await this.run(vmId, script);
    if (exitCode === EXIT_NOT_FOUND) throw new FileError(`not a file: ${abs}`, 404);
    if (exitCode !== 0) throw new FileError(stderr.trim() || `read failed (exit ${exitCode})`, 500);

    const sep = stdout.lastIndexOf(LINE_RANGE_SEP);
    const marker = sep === -1 ? "eof" : stdout.slice(sep + 1);
    const body = sep === -1 ? stdout : stdout.slice(0, sep);
    // awk terminates every printed line with a newline, so drop the trailing one
    // so we don't synthesize a phantom empty final line.
    const lines = body.length === 0 ? [] : body.replace(/\n$/, "").split("\n");
    return { lines, eof: marker !== "more" };
  }

  // Recursively remove a file or directory. Idempotent (rm -f), but never the
  // root itself.
  async remove(vmId: string, target: string): Promise<void> {
    const abs = this.confine(target);
    if (abs === this.root) throw new FileError("cannot delete the workspace root", 400);
    const { stderr, exitCode } = await this.run(vmId, `rm -rf -- ${shq(abs)}`);
    if (exitCode !== 0)
      throw new FileError(stderr.trim() || `delete failed (exit ${exitCode})`, 500);
  }

  // Move/rename. Refuses to clobber an existing target so a rename can't
  // silently swallow another file. Creates intermediate dirs so moving into a
  // not-yet-existing folder works.
  async rename(vmId: string, from: string, to: string): Promise<void> {
    const src = this.confine(from);
    const dst = this.confine(to);
    if (src === this.root) throw new FileError("cannot rename the workspace root", 400);
    if (dst === this.root) throw new FileError("invalid rename target", 400);
    if (src === dst) return;
    const script = [
      `! [ -e ${shq(dst)} ] || exit ${EXIT_EXISTS}`,
      `mkdir -p -- "$(dirname -- ${shq(dst)})" || exit 1`,
      `mv -- ${shq(src)} ${shq(dst)}`,
    ].join("\n");
    const { stderr, exitCode } = await this.run(vmId, script);
    if (exitCode === EXIT_EXISTS) throw new FileError(`already exists: ${dst}`, 409);
    if (exitCode !== 0)
      throw new FileError(stderr.trim() || `rename failed (exit ${exitCode})`, 500);
  }

  // Create a directory (and any missing parents). Refuses if anything already
  // occupies the path.
  async mkdir(vmId: string, target: string): Promise<void> {
    const abs = this.confine(target);
    if (abs === this.root) throw new FileError("already exists: workspace root", 409);
    const script = [`! [ -e ${shq(abs)} ] || exit ${EXIT_EXISTS}`, `mkdir -p -- ${shq(abs)}`].join(
      "\n",
    );
    const { stderr, exitCode } = await this.run(vmId, script);
    if (exitCode === EXIT_EXISTS) throw new FileError(`already exists: ${abs}`, 409);
    if (exitCode !== 0)
      throw new FileError(stderr.trim() || `mkdir failed (exit ${exitCode})`, 500);
  }

  // Create an empty file. Refuses to overwrite (use upload() to replace
  // contents). Creates intermediate dirs.
  async createFile(vmId: string, target: string): Promise<void> {
    const abs = this.confine(target);
    const script = [
      `! [ -e ${shq(abs)} ] || exit ${EXIT_EXISTS}`,
      `mkdir -p -- "$(dirname -- ${shq(abs)})" || exit 1`,
      `: > ${shq(abs)}`,
    ].join("\n");
    const { stderr, exitCode } = await this.run(vmId, script);
    if (exitCode === EXIT_EXISTS) throw new FileError(`already exists: ${abs}`, 409);
    if (exitCode !== 0)
      throw new FileError(stderr.trim() || `create failed (exit ${exitCode})`, 500);
  }

  // Write bytes to a path, creating parent dirs and overwriting any existing
  // file (this backs drag-and-drop, where re-dropping should replace).
  async upload(vmId: string, target: string, content: Buffer): Promise<void> {
    const abs = this.confine(target);
    if (abs === this.root) throw new FileError("invalid upload target", 400);
    const parent = path.posix.dirname(abs);
    const { stderr, exitCode } = await this.run(vmId, `mkdir -p -- ${shq(parent)}`);
    if (exitCode !== 0)
      throw new FileError(stderr.trim() || `upload failed (exit ${exitCode})`, 500);
    await this.sandbox.writeFile(vmId, abs, content);
  }
}
