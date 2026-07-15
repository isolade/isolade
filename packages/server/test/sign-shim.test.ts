import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSignShimScript, classifySignShimArgs } from "../src/sign-shim";

describe("classifySignShimArgs", () => {
  it("treats `-Y sign … <file>` as a sign request with the last arg as the buffer", () => {
    expect(
      classifySignShimArgs(["-Y", "sign", "-n", "git", "-f", "/k.pub", "-U", "/tmp/buf"]),
    ).toEqual({
      mode: "sign",
      bufferFile: "/tmp/buf",
    });
    // …and the -U-less form git uses for on-disk keys.
    expect(classifySignShimArgs(["-Y", "sign", "-n", "git", "-f", "/k.pub", "/tmp/buf"])).toEqual({
      mode: "sign",
      bufferFile: "/tmp/buf",
    });
  });

  it("passes verification subcommands through to the real ssh-keygen", () => {
    expect(
      classifySignShimArgs(["-Y", "verify", "-f", "/signers", "-n", "git", "-s", "/s"]).mode,
    ).toBe("passthrough");
    expect(classifySignShimArgs(["-Y", "find-principals", "-f", "/signers", "-s", "/s"]).mode).toBe(
      "passthrough",
    );
    expect(classifySignShimArgs(["-l", "-f", "/k.pub"]).mode).toBe("passthrough");
    expect(classifySignShimArgs([]).mode).toBe("passthrough");
  });
});

describe("buildSignShimScript", () => {
  it("embeds the broker socket path and is valid JS", () => {
    const script = buildSignShimScript({
      socketPath: "/tmp/isolade-sign.sock",
    });
    expect(script.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(script).toContain('"/tmp/isolade-sign.sock"');
    // No network: the shim talks to a local unix socket, not http/host alias.
    expect(script).not.toContain("http");

    // `node --check` parses the generated source without executing it.
    const dir = mkdtempSync(join(tmpdir(), "gc-shim-"));
    try {
      const file = join(dir, "shim.cjs");
      writeFileSync(file, script);
      const res = spawnSync("node", ["--check", file], { encoding: "utf-8" });
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
