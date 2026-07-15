import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachedPr } from "../src/contracts";
import { buildControlCli } from "../src/port-control";
import type { PrRef } from "../src/pr-attachments";
import { handlePrCommand, type PrControlOps } from "../src/pr-control";

const samplePr = (over: Partial<AttachedPr> = {}): AttachedPr => ({
  host: "github.com",
  owner: "acme",
  repo: "isolade",
  number: 123,
  title: "A change",
  state: "open",
  isDraft: false,
  url: "https://github.com/acme/isolade/pull/123",
  ...over,
});

function fakeOps(
  over: Partial<PrControlOps> = {},
): PrControlOps & { added: PrRef[]; removed: PrRef[] } {
  const added: PrRef[] = [];
  const removed: PrRef[] = [];
  return {
    added,
    removed,
    add: async (ref) => {
      added.push(ref);
      return samplePr({ ...ref });
    },
    list: () => [samplePr()],
    remove: (ref) => {
      removed.push(ref);
    },
    ...over,
  };
}

async function call(cmd: object, ops: PrControlOps): Promise<any> {
  const out = await handlePrCommand(Buffer.from(JSON.stringify(cmd)), ops);
  return JSON.parse(out.toString("utf8"));
}

describe("handlePrCommand", () => {
  it("adds a PR resolved from a number + remote URL", async () => {
    const ops = fakeOps();
    const res = await call(
      { cmd: "pr-add", number: 7, remoteUrl: "git@github.com:acme/isolade.git" },
      ops,
    );
    expect(res.ok).toBe(true);
    expect(res.pr.number).toBe(7);
    expect(ops.added).toEqual([{ host: "github.com", owner: "acme", repo: "isolade", number: 7 }]);
  });

  it("adds a PR from a full URL", async () => {
    const ops = fakeOps();
    const res = await call({ cmd: "pr-add", prUrl: "https://github.com/a/b/pull/9" }, ops);
    expect(res.ok).toBe(true);
    expect(ops.added).toEqual([{ host: "github.com", owner: "a", repo: "b", number: 9 }]);
  });

  it("rejects an unresolvable ref before touching ops", async () => {
    const ops = fakeOps();
    const res = await call({ cmd: "pr-add", number: 1 }, ops);
    expect(res.ok).toBe(false);
    expect(ops.added).toEqual([]);
  });

  it("lists attached PRs", async () => {
    const res = await call({ cmd: "pr-list" }, fakeOps());
    expect(res.ok).toBe(true);
    expect(res.prs).toHaveLength(1);
    expect(res.prs[0].number).toBe(123);
  });

  it("removes a PR and echoes the ref", async () => {
    const ops = fakeOps();
    const res = await call(
      { cmd: "pr-remove", number: 5, remoteUrl: "git@github.com:a/b.git" },
      ops,
    );
    expect(res.ok).toBe(true);
    expect(res.removed).toEqual({ host: "github.com", owner: "a", repo: "b", number: 5 });
    expect(ops.removed).toHaveLength(1);
  });

  it("surfaces a handler throw as { ok: false }", async () => {
    const ops = fakeOps({
      add: async () => {
        throw new Error("db is down");
      },
    });
    const res = await call({ cmd: "pr-add", number: 1, remoteUrl: "git@github.com:a/b.git" }, ops);
    expect(res).toEqual({ ok: false, error: "db is down" });
  });

  it("rejects malformed and unknown commands", async () => {
    expect(JSON.parse((await handlePrCommand(Buffer.from("nope"), fakeOps())).toString()).ok).toBe(
      false,
    );
    expect((await call({ cmd: "pr-bogus" }, fakeOps())).ok).toBe(false);
  });
});

// A minimal unix-socket server that records the request the CLI sent and replies
// with a canned success shaped for the command, so we can drive the REAL guest
// CLI end-to-end (including its git-remote resolution) without a broker.
class CaptureServer {
  server: net.Server;
  requests: any[] = [];
  constructor(public sockPath: string) {
    this.server = net.createServer({ allowHalfOpen: true }, (conn) => {
      const chunks: Buffer[] = [];
      conn.on("data", (d) => chunks.push(Buffer.from(d)));
      conn.on("end", () => {
        const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        this.requests.push(req);
        const pr = {
          owner: "acme",
          repo: "isolade",
          number: req.number ?? 123,
          state: "open",
          isDraft: false,
          title: "T",
        };
        const reply =
          req.cmd === "pr-list"
            ? { ok: true, prs: [pr] }
            : req.cmd === "pr-remove"
              ? {
                  ok: true,
                  removed: { owner: "acme", repo: "isolade", number: req.number ?? 123 },
                }
              : { ok: true, pr };
        conn.end(JSON.stringify(reply));
      });
    });
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.sockPath, () => resolve()));
  }
  close(): void {
    this.server.close();
  }
}

// Neutralize the developer's global/system git config (notably `url.*.insteadOf`
// rewrites) so the origin URL git reports back is exactly the one we set, no
// matter whose machine runs the test.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function runCli(
  cliPath: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["node", cliPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("isolade pr CLI round-trip", () => {
  const dirs: string[] = [];
  const servers: CaptureServer[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "pr-cli-"));
    dirs.push(dir);
    const sock = join(dir, "ctl.sock");
    const cliPath = join(dir, "isolade");
    writeFileSync(cliPath, buildControlCli(sock));
    const server = new CaptureServer(sock);
    servers.push(server);
    await server.listen();
    // A repo with an origin remote so `pr add <number>` can resolve owner/repo.
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", repo], { env: GIT_ENV });
    execFileSync(
      "git",
      ["-C", repo, "remote", "add", "origin", "git@github.com:acme/isolade.git"],
      {
        env: GIT_ENV,
      },
    );
    return { cliPath, repo, server };
  }

  it("resolves `pr add <number>` from the cwd's origin remote", async () => {
    const { cliPath, repo, server } = await setup();
    const res = await runCli(cliPath, ["pr", "add", "123"], repo);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Attached");
    expect(server.requests[0]).toEqual({
      cmd: "pr-add",
      number: 123,
      remoteUrl: "git@github.com:acme/isolade.git",
    });
  });

  it("passes a full PR URL through untouched", async () => {
    const { cliPath, repo, server } = await setup();
    const res = await runCli(cliPath, ["pr", "add", "https://github.com/a/b/pull/5"], repo);
    expect(res.code).toBe(0);
    expect(server.requests[0]).toEqual({ cmd: "pr-add", prUrl: "https://github.com/a/b/pull/5" });
  });

  it("lists and removes", async () => {
    const { cliPath, repo, server } = await setup();
    const list = await runCli(cliPath, ["pr", "list"], repo);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("acme/isolade#123");
    expect(server.requests[0]).toEqual({ cmd: "pr-list" });

    const rm = await runCli(cliPath, ["pr", "rm", "123"], repo);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain("Detached");
    expect(server.requests[1].cmd).toBe("pr-remove");
  });
});
