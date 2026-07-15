import { describe, expect, it } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleDockerfile, buildContextTar, ensureLastStageNamed } from "../src/build-context";
import {
  ASSEMBLED_LAYER_STAGE,
  ASSEMBLED_USER_STAGE,
  type ResolvedRepo,
} from "../src/profile-config";

function withTempDir(setup: (root: string) => void): {
  path: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "isolade-bcx-"));
  setup(root);
  return {
    path: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function collectTar(stream: ReadableStream<Uint8Array>): Promise<{
  entries: Set<string>;
  raw: string;
}> {
  // Pipe to `tar -t` to enumerate entries.
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const tarBuf = Buffer.concat(chunks);
  const proc = Bun.spawn(["tar", "-tf", "-"], {
    stdin: new Response(tarBuf).body!,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`tar -t exited ${exit}: ${await new Response(proc.stderr).text()}`);
  }
  const entries = new Set(
    text
      .split("\n")
      .map((p) => p.replace(/\/$/, ""))
      .filter((p) => p && p !== "."),
  );
  return { entries, raw: text };
}

async function extractAndCollect(stream: ReadableStream<Uint8Array>): Promise<{
  dest: string;
  cleanup: () => void;
}> {
  const dest = mkdtempSync(join(tmpdir(), "isolade-bcx-extract-"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const tarBuf = Buffer.concat(chunks);
  const proc = Bun.spawn(["tar", "-xf", "-", "-C", dest], {
    stdin: new Response(tarBuf).body!,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`tar -x exited ${exit}: ${err}`);
  }
  return {
    dest,
    cleanup: () => rmSync(dest, { recursive: true, force: true }),
  };
}

function makeManagedRepo(
  parent: string,
  name: string,
  files: Record<string, string>,
): ResolvedRepo {
  const dir = join(parent, name);
  mkdirSync(dir);
  Bun.spawnSync(["git", "init", "-q", dir]);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(dir, path.split("/").slice(0, -1).join("/")), {
      recursive: true,
    });
    writeFileSync(full, content);
  }
  Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
  Bun.spawnSync([
    "git",
    "-C",
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  return {
    name,
    source: {
      kind: "git",
      url: `file://${dir}`,
      branch: undefined,
      checkoutPath: dir,
    },
    sourcePath: dir,
  };
}

describe("ensureLastStageNamed", () => {
  it("appends AS to a bare FROM and returns the new name", () => {
    const { dockerfile, stageName } = ensureLastStageNamed(
      "FROM alpine:3.19\nRUN echo hi\n",
      ASSEMBLED_USER_STAGE,
    );
    expect(stageName).toBe(ASSEMBLED_USER_STAGE);
    expect(dockerfile).toBe(`FROM alpine:3.19 AS ${ASSEMBLED_USER_STAGE}\nRUN echo hi\n`);
  });

  it("preserves an existing alias and returns it", () => {
    const src = "FROM debian:bookworm AS final\nUSER agent\n";
    const { dockerfile, stageName } = ensureLastStageNamed(src, ASSEMBLED_USER_STAGE);
    expect(stageName).toBe("final");
    expect(dockerfile).toBe(src);
  });

  it("only rewrites the LAST FROM in a multi-stage Dockerfile", () => {
    const src =
      "FROM debian:bookworm AS builder\n" +
      "RUN make\n" +
      "FROM debian:bookworm\n" +
      "COPY --from=builder /app /app\n";
    const { dockerfile, stageName } = ensureLastStageNamed(src, ASSEMBLED_USER_STAGE);
    expect(stageName).toBe(ASSEMBLED_USER_STAGE);
    expect(dockerfile).toBe(
      "FROM debian:bookworm AS builder\n" +
        "RUN make\n" +
        `FROM debian:bookworm AS ${ASSEMBLED_USER_STAGE}\n` +
        "COPY --from=builder /app /app\n",
    );
  });

  it("throws when no FROM instruction is present", () => {
    expect(() => ensureLastStageNamed("# just a comment\nRUN true\n", "x")).toThrow(/no FROM/i);
  });
});

describe("assembleDockerfile", () => {
  it("renames the user's last stage and appends the agent layer, no per-repo COPY", () => {
    const bytes = assembleDockerfile(
      "FROM debian:bookworm\nRUN apt-get update\n",
      "RUN echo layer\n",
    );
    const text = bytes.toString("utf8");

    expect(text).toContain(`FROM debian:bookworm AS ${ASSEMBLED_USER_STAGE}`);
    expect(text).toContain(`FROM ${ASSEMBLED_USER_STAGE} AS ${ASSEMBLED_LAYER_STAGE}`);
    expect(text).toContain("RUN echo layer");

    // Repo placement is the user Dockerfile's job now, with nothing spliced in.
    expect(text).not.toContain("COPY --from=");
    expect(text).not.toContain("checkout -f HEAD");
  });
});

describe("buildContextTar", () => {
  it("ships only the Dockerfile when there are no repos", async () => {
    const dockerfileBytes = Buffer.from("FROM scratch\n", "utf8");
    const { entries } = await collectTar(buildContextTar({ dockerfileBytes, repos: [] }));
    expect(entries.has("Dockerfile")).toBe(true);
    expect([...entries].some((p) => p.startsWith("repos"))).toBe(false);
  });

  it("ships the profile dir under ./context/ when contextDir is given", async () => {
    const { path, cleanup } = withTempDir(() => {});
    try {
      // A profile dir: config.toml + a sidecar file + a nested dir.
      writeFileSync(join(path, "config.toml"), "repos = []\n");
      writeFileSync(join(path, "entrypoint.sh"), "#!/bin/sh\necho hi\n");
      mkdirSync(join(path, "etc"));
      writeFileSync(join(path, "etc", "app.conf"), "k=v\n");

      const dockerfileBytes = Buffer.from("FROM scratch\n", "utf8");
      const { entries } = await collectTar(
        buildContextTar({ dockerfileBytes, contextDir: path, repos: [] }),
      );

      // Sidecar files are COPYable from buildkit's main context with plain
      // relative paths (the builder maps ./context/ to --local context=).
      expect(entries.has("context/entrypoint.sh")).toBe(true);
      expect(entries.has("context/etc/app.conf")).toBe(true);
      // Managed metadata rides along (only baked in if the Dockerfile COPYs it).
      expect(entries.has("context/config.toml")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("omits ./context/ when no contextDir is given", async () => {
    const dockerfileBytes = Buffer.from("FROM scratch\n", "utf8");
    const { entries } = await collectTar(buildContextTar({ dockerfileBytes, repos: [] }));
    expect([...entries].some((p) => p.startsWith("context"))).toBe(false);
  });

  it("ships each managed repo's working tree and .git under ./repos/<name>/", async () => {
    const { path, cleanup } = withTempDir(() => {});
    try {
      const a = makeManagedRepo(path, "alpha", { "README.md": "a\n" });
      const b = makeManagedRepo(path, "beta", { "README.md": "b\n" });

      const dockerfileBytes = Buffer.from("FROM scratch\n", "utf8");
      const { entries } = await collectTar(buildContextTar({ dockerfileBytes, repos: [a, b] }));

      // Working-tree files are COPYable from the named context.
      expect(entries.has("repos/alpha/README.md")).toBe(true);
      expect(entries.has("repos/beta/README.md")).toBe(true);
      // And `.git` rides along so the agent gets a real git repo.
      expect(entries.has("repos/alpha/.git/HEAD")).toBe(true);
      expect(entries.has("repos/beta/.git/HEAD")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("filters a local repo's tree by .gitignore but still ships .git", async () => {
    const { path, cleanup } = withTempDir(() => {});
    try {
      const repoDir = join(path, "local");
      mkdirSync(repoDir);
      writeFileSync(join(repoDir, "Dockerfile"), "FROM scratch\n");
      writeFileSync(join(repoDir, "keep.txt"), "yes\n");
      writeFileSync(join(repoDir, "build.log"), "skip\n");
      writeFileSync(join(repoDir, ".gitignore"), "*.log\n");
      Bun.spawnSync(["git", "init", "-q", repoDir]);
      Bun.spawnSync(["git", "-C", repoDir, "add", "-A"]);
      Bun.spawnSync([
        "git",
        "-C",
        repoDir,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "init",
      ]);

      const repo: ResolvedRepo = {
        name: "local",
        source: { kind: "local", path: repoDir },
        sourcePath: repoDir,
      };

      const { entries } = await collectTar(
        buildContextTar({
          dockerfileBytes: Buffer.from("FROM scratch\n"),
          repos: [repo],
        }),
      );

      expect(entries.has("repos/local/Dockerfile")).toBe(true);
      expect(entries.has("repos/local/keep.txt")).toBe(true);
      // .gitignore'd file is filtered out of the tree.
      expect(entries.has("repos/local/build.log")).toBe(false);
      // Tracked .gitignore survives the filter.
      expect(entries.has("repos/local/.gitignore")).toBe(true);
      // .git is shipped as a second section.
      expect(entries.has("repos/local/.git/HEAD")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("preserves symlinks inside a repo (incl. `..` targets)", async () => {
    const { path, cleanup } = withTempDir(() => {});
    try {
      const repoDir = join(path, "sym");
      mkdirSync(repoDir);
      writeFileSync(join(repoDir, "Dockerfile"), "FROM scratch\n");
      writeFileSync(join(repoDir, "AGENTS.md"), "agents\n");
      mkdirSync(join(repoDir, ".claude"));
      symlinkSync("../AGENTS.md", join(repoDir, ".claude", "CLAUDE.md"));
      // Hardlink targets are the inverse case: they name an earlier archive
      // member, so the prefix transform MUST rewrite them (unlike symlinks).
      linkSync(join(repoDir, "AGENTS.md"), join(repoDir, "HARDLINK.md"));
      Bun.spawnSync(["git", "init", "-q", repoDir]);
      Bun.spawnSync(["git", "-C", repoDir, "add", "-A"]);
      Bun.spawnSync([
        "git",
        "-C",
        repoDir,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "init",
      ]);

      const repo: ResolvedRepo = {
        name: "sym",
        source: { kind: "local", path: repoDir },
        sourcePath: repoDir,
      };

      const { dest, cleanup: cleanExtract } = await extractAndCollect(
        buildContextTar({
          dockerfileBytes: Buffer.from("FROM scratch\n"),
          repos: [repo],
        }),
      );
      try {
        const linkPath = join(dest, "repos", "sym", ".claude", "CLAUDE.md");
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
        const text = await Bun.file(linkPath).text();
        expect(text).toBe("agents\n");

        const hardPath = join(dest, "repos", "sym", "HARDLINK.md");
        expect(await Bun.file(hardPath).text()).toBe("agents\n");
        expect(statSync(hardPath).ino).toBe(statSync(join(dest, "repos", "sym", "AGENTS.md")).ino);
      } finally {
        cleanExtract();
      }
    } finally {
      cleanup();
    }
  });

  it("ships a managed checkout's submodule worktree and top-level .git", async () => {
    const { path, cleanup } = withTempDir(() => {});
    try {
      const subRemote = makeManagedRepo(path, "subrem", {
        "submod.txt": "from submodule\n",
      });
      const parent = join(path, "parent");
      mkdirSync(parent);
      Bun.spawnSync(["git", "init", "-q", parent]);
      writeFileSync(join(parent, "Dockerfile"), "FROM scratch\n");
      Bun.spawnSync([
        "git",
        "-C",
        parent,
        "-c",
        "protocol.file.allow=always",
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        "submodule",
        "add",
        `file://${subRemote.sourcePath}`,
        "sub",
      ]);
      Bun.spawnSync([
        "git",
        "-C",
        parent,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "init",
      ]);

      const repo: ResolvedRepo = {
        name: "parent",
        source: {
          kind: "git",
          url: `file://${parent}`,
          branch: undefined,
          checkoutPath: parent,
        },
        sourcePath: parent,
      };

      const { entries } = await collectTar(
        buildContextTar({
          dockerfileBytes: Buffer.from("FROM scratch\n"),
          repos: [repo],
        }),
      );

      // Submodule worktree contents and pointer file land under the repo.
      expect(entries.has("repos/parent/sub/submod.txt")).toBe(true);
      expect(entries.has("repos/parent/sub/.git")).toBe(true);
      // Top-level .git is shipped (managed checkouts include it wholesale).
      expect(entries.has("repos/parent/.git/HEAD")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("drops a managed repo's root .dockerignore (so buildkit can't filter the context)", async () => {
    const { path, cleanup } = withTempDir(() => {});
    try {
      const repo = makeManagedRepo(path, "app", {
        ".dockerignore": "nix/\n*.md\n",
        "nix/overlay.nix": "{}\n",
        "README.md": "readme\n",
      });

      const { entries } = await collectTar(
        buildContextTar({
          dockerfileBytes: Buffer.from("FROM scratch\n"),
          repos: [repo],
        }),
      );

      // Root .dockerignore is stripped from the context...
      expect(entries.has("repos/app/.dockerignore")).toBe(false);
      // ...so files it would have excluded ship normally...
      expect(entries.has("repos/app/nix/overlay.nix")).toBe(true);
      expect(entries.has("repos/app/README.md")).toBe(true);
      // ...and `.git` (which still tracks .dockerignore) rides along.
      expect(entries.has("repos/app/.git/HEAD")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("drops a local repo's root .dockerignore", async () => {
    const { path, cleanup } = withTempDir(() => {});
    try {
      const repoDir = join(path, "local");
      mkdirSync(repoDir);
      writeFileSync(join(repoDir, ".dockerignore"), "secret.txt\n");
      writeFileSync(join(repoDir, "secret.txt"), "shh\n");
      writeFileSync(join(repoDir, "keep.txt"), "yes\n");
      Bun.spawnSync(["git", "init", "-q", repoDir]);
      Bun.spawnSync(["git", "-C", repoDir, "add", "-A"]);
      Bun.spawnSync([
        "git",
        "-C",
        repoDir,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "init",
      ]);

      const repo: ResolvedRepo = {
        name: "local",
        source: { kind: "local", path: repoDir },
        sourcePath: repoDir,
      };

      const { entries } = await collectTar(
        buildContextTar({
          dockerfileBytes: Buffer.from("FROM scratch\n"),
          repos: [repo],
        }),
      );

      expect(entries.has("repos/local/.dockerignore")).toBe(false);
      // The file .dockerignore would have excluded ships anyway.
      expect(entries.has("repos/local/secret.txt")).toBe(true);
      expect(entries.has("repos/local/keep.txt")).toBe(true);
      expect(entries.has("repos/local/.git/HEAD")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("throws if a repo's .git is missing", async () => {
    const { path, cleanup } = withTempDir(() => {});
    try {
      mkdirSync(join(path, "naked"));
      const repo: ResolvedRepo = {
        name: "naked",
        source: { kind: "local", path: join(path, "naked") },
        sourcePath: join(path, "naked"),
      };
      const stream = buildContextTar({
        dockerfileBytes: Buffer.from("FROM scratch\n"),
        repos: [repo],
      });
      await expect(collectTar(stream)).rejects.toThrow(/\.git not found/);
    } finally {
      cleanup();
    }
  });
});
