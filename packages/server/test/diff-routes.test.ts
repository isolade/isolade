import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SandboxApi } from "../src/sandbox-client";
import { createTestServer } from "./helpers";

// Wiring + error mapping for the review-diff route, using a canned sandbox whose
// exec returns whatever the test wants (the probe shell + parser are covered by
// workspace-diff.test.ts). Confirms the route resolves the instance, surfaces
// the parsed diff, and turns an exec failure into a 500.
type ExecResult = { stdout: string; stderr: string; exitCode: number };
let execHandler: () => ExecResult = () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});

function cannedSandbox(): SandboxApi {
  return {
    async exec() {
      return execHandler();
    },
    async destroyVm() {},
  } as unknown as SandboxApi;
}

const RS = "\x1e";

describe("workspace review-diff route", () => {
  let baseUrl: string;
  let cleanup: () => Promise<void>;
  let instanceId: string;

  beforeEach(() => {
    execHandler = () => ({ stdout: "", stderr: "", exitCode: 0 });
    const server = createTestServer({ sandbox: cannedSandbox() });
    baseUrl = server.baseUrl;
    cleanup = server.cleanup;
    instanceId = server.seedInstance();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("404s for an unknown instance", async () => {
    const res = await fetch(`${baseUrl}/api/instances/does-not-exist/diff`);
    expect(res.status).toBe(404);
  });

  it("returns the parsed diff for the instance", async () => {
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    execHandler = () => ({
      stdout: `${RS}.\n${patch}`,
      stderr: "",
      exitCode: 0,
    });

    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(false);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      path: "foo.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
    });
  });

  it("returns an empty file list when there are no changes", async () => {
    execHandler = () => ({ stdout: `${RS}.\n`, stderr: "", exitCode: 0 });
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/diff`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], truncated: false });
  });

  it("500s when the probe exec fails", async () => {
    execHandler = () => ({ stdout: "", stderr: "vm gone", exitCode: 1 });
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/diff`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("vm gone");
  });
});
