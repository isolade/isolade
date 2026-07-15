import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDb, schema } from "../src/db";
import { DiffStatsPoller, diffStatsProbeScript, parseDiffStatsProbe } from "../src/diff-stats";
import type { SandboxClient } from "../src/sandbox-client";

describe("DiffStatsPoller", () => {
  function setup() {
    const db = createDb(":memory:");
    db.insert(schema.instances).values({ id: "i1", vmId: "vm-1", title: "t", image: "img" }).run();
    const execs: string[] = [];
    const sandbox = {
      exec: async (vmId: string) => {
        execs.push(vmId);
        return { stdout: "5 2 1", stderr: "", exitCode: 0 };
      },
    } as unknown as SandboxClient;
    // Slow loop pushed out of the test window, so only the start() tick and
    // explicit nudges drive probes.
    const poller = new DiffStatsPoller(db, sandbox, {
      refreshMs: 60_000,
      nudgeDebounceMs: 25,
    });
    return { db, execs, poller };
  }

  it("coalesces a burst of nudges into one debounced probe and persists it", async () => {
    const { db, execs, poller } = setup();
    poller.start();
    await Bun.sleep(10);
    expect(execs.length).toBe(1); // start() probes immediately

    for (let i = 0; i < 5; i++) poller.nudge("i1");
    await Bun.sleep(60);
    expect(execs.length).toBe(2); // burst → a single debounced probe

    const row = db.select().from(schema.instances).where(eq(schema.instances.id, "i1")).get();
    expect(row?.diffAdded).toBe(5);
    expect(row?.diffDeleted).toBe(2);
    poller.stop();
  });

  it("ignores nudges until started, so fake-backend tests stay quiet", async () => {
    const { execs, poller } = setup();
    poller.nudge("i1");
    await Bun.sleep(60);
    expect(execs.length).toBe(0);
  });
});

describe("parseDiffStatsProbe", () => {
  it("parses an added/deleted/lines triple", () => {
    expect(parseDiffStatsProbe("4314 321 7\n")).toEqual({
      added: 4314,
      deleted: 321,
    });
  });

  it("maps zero probed lines to null stats (no repos in the VM)", () => {
    expect(parseDiffStatsProbe("0 0 0")).toEqual({
      added: null,
      deleted: null,
    });
  });

  it("rejects unparseable output so the caller keeps the previous values", () => {
    expect(parseDiffStatsProbe("")).toBeNull();
    expect(parseDiffStatsProbe("sh: git: not found")).toBeNull();
  });
});

// End-to-end over the real shell script: the probe runs under the sandbox's
// `/bin/sh -c`, so quoting or awk/xargs portability mistakes only surface by
// actually executing it against real repos.
describe("diffStatsProbeScript", () => {
  function sh(script: string): string {
    const proc = Bun.spawnSync(["/bin/sh", "-c", script]);
    expect(proc.exitCode).toBe(0);
    return proc.stdout.toString();
  }

  function git(repo: string, ...args: string[]): void {
    const proc = Bun.spawnSync(
      [
        "git",
        "-C",
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        // Stay hermetic: never inherit the developer's global commit-signing
        // config, which would route these throwaway commits through an SSH
        // signing agent (Secretive) that can refuse and flake the test.
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
    }
  }

  function withRoot(fn: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "isolade-diff-stats-"));
    try {
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("reports zero lines when the root holds no git repos", () => {
    withRoot((root) => {
      expect(parseDiffStatsProbe(sh(diffStatsProbeScript(root)))).toEqual({
        added: null,
        deleted: null,
      });
    });
  });

  it("sums working-tree edits and untracked lines across repos vs HEAD", () => {
    withRoot((root) => {
      // Repo A: a tracked file rewritten (3 lines -> 1 kept + 2 new) plus a
      // 4-line untracked file. No remote, so the base falls back to HEAD.
      const a = join(root, "a");
      mkdirSync(a);
      git(a, "init", "-b", "main");
      writeFileSync(join(a, "f.txt"), "one\ntwo\nthree\n");
      git(a, "add", ".");
      git(a, "commit", "-m", "init");
      writeFileSync(join(a, "f.txt"), "one\nNEW\nNEW\n");
      writeFileSync(join(a, "new.txt"), "u1\nu2\nu3\nu4\n");

      // Repo B: one tracked line deleted.
      const b = join(root, "b");
      mkdirSync(b);
      git(b, "init", "-b", "main");
      writeFileSync(join(b, "g.txt"), "keep\ndrop\n");
      git(b, "add", ".");
      git(b, "commit", "-m", "init");
      writeFileSync(join(b, "g.txt"), "keep\n");

      // a: 2 modified + 4 untracked = 6 added, 2 deleted. b: 0 added, 1 deleted.
      expect(parseDiffStatsProbe(sh(diffStatsProbeScript(root)))).toEqual({
        added: 6,
        deleted: 3,
      });
    });
  });

  it("treats a fetched PR head as pushed even without a tracking ref", () => {
    withRoot((root) => {
      const origin = join(root, "origin.git");
      mkdirSync(origin);
      git(origin, "init", "--bare", "-b", "main");

      const seed = mkdtempSync(join(tmpdir(), "isolade-diff-stats-seed-"));
      try {
        git(seed, "init", "-b", "main");
        writeFileSync(join(seed, "f.txt"), "one\n");
        git(seed, "add", ".");
        git(seed, "commit", "-m", "init");
        git(seed, "remote", "add", "origin", origin);
        git(seed, "push", "origin", "main");

        const clone = join(root, "repo");
        git(root, "clone", origin, clone);

        // Fork-style PR: its commits reach the remote only under
        // refs/pull/1/head, never under refs/heads/*.
        writeFileSync(join(seed, "pr.txt"), "a\nb\nc\n");
        git(seed, "add", ".");
        git(seed, "commit", "-m", "pr");
        git(seed, "push", "origin", "HEAD:refs/pull/1/head");

        // The checkout flow that used to over-count: fetch the PR ref
        // straight into a local branch. No remote-tracking ref, no
        // upstream, since the PR tip is recorded only in FETCH_HEAD.
        git(clone, "fetch", "origin", "pull/1/head:pr-1");
        git(clone, "checkout", "pr-1");
        expect(parseDiffStatsProbe(sh(diffStatsProbeScript(root)))).toEqual({
          added: 0,
          deleted: 0,
        });

        // Local work on top of the PR still counts.
        writeFileSync(join(clone, "new.txt"), "x\ny\n");
        expect(parseDiffStatsProbe(sh(diffStatsProbeScript(root)))).toEqual({
          added: 2,
          deleted: 0,
        });
      } finally {
        rmSync(seed, { recursive: true, force: true });
      }
    });
  });

  it("counts unpushed commits against the remote-tracking ref", () => {
    withRoot((root) => {
      const origin = join(root, "origin.git");
      mkdirSync(origin);
      git(origin, "init", "--bare", "-b", "main");

      const seed = mkdtempSync(join(tmpdir(), "isolade-diff-stats-seed-"));
      try {
        git(seed, "init", "-b", "main");
        writeFileSync(join(seed, "f.txt"), "one\ntwo\n");
        git(seed, "add", ".");
        git(seed, "commit", "-m", "init");
        git(seed, "remote", "add", "origin", origin);
        git(seed, "push", "-u", "origin", "main");

        const clone = join(root, "repo");
        git(root, "clone", origin, clone);

        // A committed-but-unpushed line must still count: the VM is
        // ephemeral, so anything short of a push is at-risk work.
        writeFileSync(join(clone, "f.txt"), "one\ntwo\nthree\n");
        git(clone, "add", ".");
        git(clone, "commit", "-m", "local only");
        // Plus an uncommitted edit on top.
        writeFileSync(join(clone, "f.txt"), "one\ntwo\nthree\nfour\n");

        expect(parseDiffStatsProbe(sh(diffStatsProbeScript(root)))).toEqual({
          added: 2,
          deleted: 0,
        });

        // After a push the work is durable and the stat collapses to zero
        // with no fetch, since the local remote-tracking ref advanced.
        git(clone, "add", ".");
        git(clone, "commit", "-m", "rest");
        git(clone, "push");
        expect(parseDiffStatsProbe(sh(diffStatsProbeScript(root)))).toEqual({
          added: 0,
          deleted: 0,
        });
      } finally {
        rmSync(seed, { recursive: true, force: true });
      }
    });
  });
});
