import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileError, WorkspaceFiles } from "../src/files";
import type { SandboxApi } from "../src/sandbox-client";

// Drive WorkspaceFiles against the real host filesystem: the fake sandbox runs
// each generated shell snippet locally and writes uploads to disk, so this
// exercises the actual scripts + path-confinement logic, just rooted at a temp
// dir instead of the guest's /workspace.
function hostSandbox(): SandboxApi {
  return {
    async exec(_vm: string, command: string) {
      const r = spawnSync("/bin/sh", ["-c", command]);
      return {
        stdout: r.stdout ? r.stdout.toString("utf8") : "",
        stderr: r.stderr ? r.stderr.toString("utf8") : "",
        exitCode: r.status ?? 1,
      };
    },
    async writeFile(_vm: string, path: string, content: Buffer) {
      writeFileSync(path, content);
    },
  } as unknown as SandboxApi;
}

const VM = "vm-test";

describe("WorkspaceFiles", () => {
  let root: string;
  let files: WorkspaceFiles;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gc-files-"));
    files = new WorkspaceFiles(hostSandbox(), root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists immediate children, dirs first, with sizes and hidden files", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "a.txt"), "hello"); // 5 bytes
    writeFileSync(join(root, "b.txt"), "");
    writeFileSync(join(root, ".env"), "x=1");

    const { path, entries } = await files.list(VM, root);
    expect(path).toBe(root);
    expect(entries.map((e) => e.name)).toEqual(["src", ".env", "a.txt", "b.txt"]);
    expect(entries[0]).toMatchObject({ name: "src", type: "dir", size: null });
    const a = entries.find((e) => e.name === "a.txt");
    expect(a).toMatchObject({
      type: "file",
      size: 5,
      path: join(root, "a.txt"),
    });
  });

  it("lists a nested directory by absolute path", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export {}");
    const { entries } = await files.list(VM, join(root, "src"));
    expect(entries.map((e) => e.name)).toEqual(["index.ts"]);
  });

  it("returns 404 FileError for a non-directory path", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    await expect(files.list(VM, join(root, "a.txt"))).rejects.toMatchObject({
      status: 404,
    });
    await expect(files.list(VM, join(root, "missing"))).rejects.toBeInstanceOf(FileError);
  });

  it("rejects paths that escape the root", async () => {
    await expect(files.list(VM, "/etc")).rejects.toMatchObject({ status: 400 });
    await expect(files.remove(VM, `${root}/../secrets`)).rejects.toMatchObject({
      status: 400,
    });
  });

  describe("readLines", () => {
    beforeEach(() => {
      // Ten numbered lines, with a trailing newline.
      writeFileSync(
        join(root, "f.txt"),
        Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
      );
    });

    it("reads an inclusive range and flags more-to-come", async () => {
      const res = await files.readLines(VM, join(root, "f.txt"), 3, 5);
      expect(res).toEqual({
        lines: ["line 3", "line 4", "line 5"],
        eof: false,
      });
    });

    it("flags eof when the range reaches the last line", async () => {
      const res = await files.readLines(VM, join(root, "f.txt"), 8, 20);
      expect(res).toEqual({
        lines: ["line 8", "line 9", "line 10"],
        eof: true,
      });
    });

    it("returns no lines (and eof) for a range past the end", async () => {
      expect(await files.readLines(VM, join(root, "f.txt"), 50, 60)).toEqual({
        lines: [],
        eof: true,
      });
    });

    it("preserves blank lines inside the range", async () => {
      writeFileSync(join(root, "g.txt"), "a\n\nb\n");
      expect(await files.readLines(VM, join(root, "g.txt"), 1, 3)).toEqual({
        lines: ["a", "", "b"],
        eof: true,
      });
    });

    it("404s for a missing file or a directory", async () => {
      await expect(files.readLines(VM, join(root, "nope.txt"), 1, 5)).rejects.toMatchObject({
        status: 404,
      });
      mkdirSync(join(root, "adir"));
      await expect(files.readLines(VM, join(root, "adir"), 1, 5)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  it("creates directories and refuses to clobber", async () => {
    await files.mkdir(VM, join(root, "a", "b", "c"));
    expect((await files.list(VM, join(root, "a", "b"))).entries.map((e) => e.name)).toEqual(["c"]);
    await expect(files.mkdir(VM, join(root, "a"))).rejects.toMatchObject({
      status: 409,
    });
  });

  it("creates empty files and refuses to overwrite", async () => {
    await files.createFile(VM, join(root, "notes", "todo.md"));
    expect(readFileSync(join(root, "notes", "todo.md"), "utf8")).toBe("");
    await expect(files.createFile(VM, join(root, "notes", "todo.md"))).rejects.toMatchObject({
      status: 409,
    });
  });

  it("renames/moves and refuses to clobber an existing target", async () => {
    writeFileSync(join(root, "old.txt"), "data");
    await files.rename(VM, join(root, "old.txt"), join(root, "new.txt"));
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("data");

    // Moving into a not-yet-existing subdir creates it.
    await files.rename(VM, join(root, "new.txt"), join(root, "sub", "moved.txt"));
    expect(readFileSync(join(root, "sub", "moved.txt"), "utf8")).toBe("data");

    writeFileSync(join(root, "keep.txt"), "keep");
    writeFileSync(join(root, "other.txt"), "other");
    await expect(
      files.rename(VM, join(root, "other.txt"), join(root, "keep.txt")),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("keep");
  });

  it("deletes files and directories recursively, but never the root", async () => {
    mkdirSync(join(root, "dir", "nested"), { recursive: true });
    writeFileSync(join(root, "dir", "nested", "f.txt"), "x");
    await files.remove(VM, join(root, "dir"));
    expect((await files.list(VM, root)).entries).toEqual([]);

    await expect(files.remove(VM, root)).rejects.toMatchObject({ status: 400 });
  });

  it("uploads bytes, creating parent dirs and overwriting", async () => {
    await files.upload(VM, join(root, "assets", "logo.bin"), Buffer.from([1, 2, 3, 4]));
    expect(Array.from(readFileSync(join(root, "assets", "logo.bin")))).toEqual([1, 2, 3, 4]);
    // Re-upload overwrites.
    await files.upload(VM, join(root, "assets", "logo.bin"), Buffer.from([9]));
    expect(Array.from(readFileSync(join(root, "assets", "logo.bin")))).toEqual([9]);
  });
});
