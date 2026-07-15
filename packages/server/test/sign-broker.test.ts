import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signWithAgent } from "../src/git-config";
import { buildRequestBrokerScript, FrameReader, frameResponse } from "../src/request-broker";
import { buildSignShimScript } from "../src/sign-shim";

// ---------------------------------------------------------------------------
// Broker ↔ shim round-trip over a real unix socket. A stub "host" stands in
// for the exec stream: it reads the broker's stdout frames, signs via the
// agent, and frames the signature back to the broker's stdin, exactly what
// runSignerStream does, minus microsandbox. Needs ssh-agent + ssh-keygen.
// (The broker script and framing helpers themselves are covered in
// request-broker.test.ts, which has no ssh dependency.)
// ---------------------------------------------------------------------------

// `spawnSync().status` is `null` in Node but `undefined` in Bun when the
// binary can't be spawned, so compare loosely. `!== null` would wrongly
// report the tool present under Bun and run the suite into failures.
const haveSsh =
  spawnSync("ssh-keygen", ["-?"]).status != null &&
  spawnSync("ssh-agent", ["-?"]).status != null &&
  spawnSync("node", ["-e", ""]).status === 0;

describe.if(haveSsh)("broker ↔ shim round-trip", () => {
  let dir: string;
  let socketPath: string;
  let agentPid: string;
  let pubkey: string;
  let brokerFile: string;
  let shimFile: string;
  const sock = join(tmpdir(), `gc-broker-${process.pid}.sock`);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gc-broker-"));
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-f",
      join(dir, "k"),
      "-N",
      "",
      "-C",
      "agent@isolade",
    ]);
    pubkey = readFileSync(join(dir, "k.pub"), "utf-8").trim();
    const out = execFileSync("ssh-agent", ["-s"], { encoding: "utf-8" });
    socketPath = out.match(/SSH_AUTH_SOCK=([^;]+);/)?.[1] ?? "";
    agentPid = out.match(/SSH_AGENT_PID=(\d+);/)?.[1] ?? "";
    execFileSync("ssh-add", [join(dir, "k")], {
      env: { ...process.env, SSH_AUTH_SOCK: socketPath },
      stdio: ["ignore", "ignore", "ignore"],
    });
    rmSync(join(dir, "k")); // prove signing goes through the agent

    brokerFile = join(dir, "broker.cjs");
    shimFile = join(dir, "shim.cjs");
    writeFileSync(brokerFile, buildRequestBrokerScript(sock));
    writeFileSync(shimFile, buildSignShimScript({ socketPath: sock }));
  });

  afterAll(() => {
    if (agentPid) {
      try {
        execFileSync("ssh-agent", ["-k"], {
          env: { ...process.env, SSH_AGENT_PID: agentPid },
        });
      } catch {}
    }
    try {
      rmSync(sock);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("signs a commit payload end-to-end and the signature verifies", async () => {
    try {
      rmSync(sock);
    } catch {}
    // Broker in the VM (here: a local node child). We play the host.
    const broker = Bun.spawn(["node", brokerFile], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = new FrameReader((payload) => {
      const sig = signWithAgent(payload, { signingKey: pubkey, socketPath });
      broker.stdin.write(frameResponse(0, sig));
      broker.stdin.flush();
    });
    const pump = (async () => {
      for await (const chunk of broker.stdout as ReadableStream<Uint8Array>) {
        reader.push(Buffer.from(chunk));
      }
    })().catch(() => {});

    try {
      // Wait for the broker to bind its socket.
      for (let i = 0; i < 100 && !existsSync(sock); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(existsSync(sock)).toBe(true);

      const bufferFile = join(dir, "commit-buf");
      const payload = Buffer.from("tree deadbeef\nauthor someone\n\nthe commit message");
      writeFileSync(bufferFile, payload);

      // git invokes the shim like ssh-keygen, and it should drop <buffer>.sig.
      const shim = Bun.spawn(
        ["node", shimFile, "-Y", "sign", "-n", "git", "-f", join(dir, "k.pub"), bufferFile],
        { stderr: "pipe" },
      );
      const code = await shim.exited;
      if (code !== 0) console.error("shim stderr:", await new Response(shim.stderr).text());
      expect(code).toBe(0);
      expect(existsSync(`${bufferFile}.sig`)).toBe(true);

      // The signature the shim wrote verifies as a good git signature.
      const res = spawnSync(
        "ssh-keygen",
        ["-Y", "check-novalidate", "-n", "git", "-s", `${bufferFile}.sig`],
        { input: payload, encoding: "utf-8" },
      );
      expect(res.status === 0 && /Good "git" signature/.test(res.stdout + res.stderr)).toBe(true);
    } finally {
      broker.kill();
      await pump;
    }
  });
});
