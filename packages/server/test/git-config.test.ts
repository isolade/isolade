import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitConfigManager,
  parseAgentKeys,
  rankAgentSockets,
  SECRETIVE_SOCKET,
  signWithAgent,
  sshFingerprint,
} from "../src/git-config";
import { GitConfigStore } from "../src/git-config-store";

describe("rankAgentSockets", () => {
  const gpg = "/Users/x/.gnupg/S.gpg-agent.ssh";
  it("prefers Secretive, then the session SSH_AUTH_SOCK with an inferred label", () => {
    expect(rankAgentSockets({ sshAuthSock: gpg, secretiveExists: true })).toEqual([
      { path: SECRETIVE_SOCKET, label: "Secretive" },
      { path: gpg, label: "gpg-agent" },
    ]);
  });
  it("falls back to just SSH_AUTH_SOCK when Secretive is absent", () => {
    expect(rankAgentSockets({ sshAuthSock: gpg, secretiveExists: false })).toEqual([
      { path: gpg, label: "gpg-agent" },
    ]);
  });
  it("dedupes when SSH_AUTH_SOCK already points at Secretive, and handles none", () => {
    expect(
      rankAgentSockets({
        sshAuthSock: SECRETIVE_SOCKET,
        secretiveExists: true,
      }),
    ).toEqual([{ path: SECRETIVE_SOCKET, label: "Secretive" }]);
    expect(rankAgentSockets({ sshAuthSock: null, secretiveExists: false })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers, always run.
// ---------------------------------------------------------------------------

describe("parseAgentKeys", () => {
  it("parses key lines and skips status / blank lines", () => {
    const out = [
      "The agent has no identities.",
      "",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID comment here",
      "ssh-rsa AAAAB3NzaC1yc2E",
      "garbage",
    ].join("\n");
    const keys = parseAgentKeys(out);
    expect(keys.map((k) => k.type)).toEqual(["ssh-ed25519", "ssh-rsa"]);
    expect(keys[0]!.comment).toBe("comment here");
    expect(keys[1]!.comment).toBe("");
    expect(keys[0]!.fingerprint).toMatch(/^SHA256:/);
  });
});

// Tool-availability guard for suites that exercise real ssh binaries.
// `spawnSync().status` is `null` in Node but `undefined` in Bun when the
// binary can't be spawned, so compare loosely. `!== null` would wrongly
// report the tool present under Bun and run the suite into failures.
const haveSshKeygen = spawnSync("ssh-keygen", ["-?"]).status != null;

describe("sshFingerprint", () => {
  it.if(haveSshKeygen)("matches `ssh-keygen -lf` for a generated key", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-fp-"));
    try {
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-f",
        join(dir, "k"),
        "-N",
        "",
        "-C",
        "x",
      ]);
      const pub = readFileSync(join(dir, "k.pub"), "utf-8").trim();
      const expected = execFileSync("ssh-keygen", ["-lf", join(dir, "k.pub")], {
        encoding: "utf-8",
      }).match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
      expect(sshFingerprint(pub)).toBe(expected!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for malformed input", () => {
    expect(sshFingerprint("")).toBeNull();
    expect(sshFingerprint("ssh-ed25519")).toBeNull();
  });
});

describe("GitConfigManager identity", () => {
  it("effectiveIdentity prefers the configured identity over the host", () => {
    const store = new GitConfigStore(join(mkdtempSync(join(tmpdir(), "gc-id-")), "config.toml"));
    const mgr = new GitConfigManager(store);
    // No configured identity → falls back to host (may be null on a bare host).
    const beforeConfig = mgr.effectiveIdentity();
    store.setIdentity({ name: "Agent", email: "a@b.c" });
    expect(mgr.effectiveIdentity()).toEqual({ name: "Agent", email: "a@b.c" });
    // status surfaces both the configured identity and the host default.
    const status = mgr.status();
    expect(status.identity).toEqual({ name: "Agent", email: "a@b.c" });
    expect(status.signing.configured).toBe(false);
    void beforeConfig;
  });
});

// ---------------------------------------------------------------------------
// Agent round-trip, needs ssh-agent + ssh-keygen. Skipped if unavailable.
// ---------------------------------------------------------------------------

const haveSsh = haveSshKeygen && spawnSync("ssh-agent", ["-?"]).status != null;

describe.if(haveSsh)("agent-backed signing", () => {
  let keyDir: string;
  let socketPath: string;
  let agentPid: string;
  let pubkey: string;

  beforeAll(() => {
    keyDir = mkdtempSync(join(tmpdir(), "gc-signagent-"));
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-f",
      join(keyDir, "k"),
      "-N",
      "",
      "-C",
      "agent@isolade",
    ]);
    pubkey = readFileSync(join(keyDir, "k.pub"), "utf-8").trim();
    const out = execFileSync("ssh-agent", ["-s"], { encoding: "utf-8" });
    socketPath = out.match(/SSH_AUTH_SOCK=([^;]+);/)?.[1] ?? "";
    agentPid = out.match(/SSH_AGENT_PID=(\d+);/)?.[1] ?? "";
    execFileSync("ssh-add", [join(keyDir, "k")], {
      env: { ...process.env, SSH_AUTH_SOCK: socketPath },
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Delete the private half so a passing test PROVES the agent did the signing.
    rmSync(join(keyDir, "k"));
  });

  afterAll(() => {
    if (agentPid) {
      try {
        execFileSync("ssh-agent", ["-k"], {
          env: { ...process.env, SSH_AGENT_PID: agentPid },
        });
      } catch {}
    }
    rmSync(keyDir, { recursive: true, force: true });
  });

  const verifies = (payload: Buffer, sig: Buffer): boolean => {
    const d = mkdtempSync(join(tmpdir(), "gc-verify-"));
    try {
      writeFileSync(join(d, "data"), payload);
      writeFileSync(join(d, "data.sig"), sig);
      const res = spawnSync(
        "ssh-keygen",
        ["-Y", "check-novalidate", "-n", "git", "-s", join(d, "data.sig")],
        {
          input: payload,
          encoding: "utf-8",
        },
      );
      return res.status === 0 && /Good "git" signature/.test(res.stdout + res.stderr);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  it("signWithAgent produces a valid git-namespace SSHSIG (no private key on disk)", () => {
    const payload = Buffer.from("tree abc\nauthor x\n\nmessage");
    const sig = signWithAgent(payload, { signingKey: pubkey, socketPath });
    expect(sig.toString()).toContain("BEGIN SSH SIGNATURE");
    expect(verifies(payload, sig)).toBe(true);
  });

  it("signPayload (the oracle the broker calls) signs and the result verifies", () => {
    const store = new GitConfigStore(join(keyDir, "config.toml"));
    store.setSigning({ enabled: true, socketPath, signingKey: pubkey });
    const mgr = new GitConfigManager(store);

    const payload = Buffer.from("payload through the oracle");
    expect(verifies(payload, mgr.signPayload(payload))).toBe(true);

    const status = mgr.status();
    expect(status.signing).toMatchObject({
      enabled: true,
      configured: true,
      agentReachable: true,
    });
    expect(status.signing.key?.fingerprint).toBe(sshFingerprint(pubkey));

    const listed = mgr.listKeys(socketPath);
    expect(listed.reachable).toBe(true);
    expect(listed.keys.some((k) => k.fingerprint === sshFingerprint(pubkey))).toBe(true);

    expect(mgr.resolveActiveSigning()).toMatchObject({
      enabled: true,
      signingKey: pubkey,
    });
  });

  it("signPayload throws and resolveActiveSigning is null when disabled", () => {
    const store = new GitConfigStore(join(keyDir, "git-off.json"));
    store.setSigning({ enabled: false, socketPath, signingKey: pubkey });
    const mgr = new GitConfigManager(store);
    expect(() => mgr.signPayload(Buffer.from("x"))).toThrow();
    expect(mgr.resolveActiveSigning()).toBeNull();
  });
});
