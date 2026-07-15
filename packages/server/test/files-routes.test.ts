import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SandboxApi } from "../src/sandbox-client";
import { createTestServer } from "./helpers";

// Wiring + error-mapping for the file routes, using a canned sandbox whose exec
// returns whatever the current test wants (the real shell scripts are covered
// by files.test.ts). Confirms the routes resolve the instance, parse the body,
// and translate FileError statuses (404/409) onto HTTP responses.
type ExecResult = { stdout: string; stderr: string; exitCode: number };
let execHandler: (command: string) => ExecResult = () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});
let lastWrite: { path: string; content: Buffer } | null = null;

function cannedSandbox(): SandboxApi {
  return {
    async exec(_vm: string, command: string) {
      return execHandler(command);
    },
    async writeFile(_vm: string, path: string, content: Buffer) {
      lastWrite = { path, content };
    },
    async destroyVm() {},
  } as unknown as SandboxApi;
}

describe("workspace file routes", () => {
  let baseUrl: string;
  let cleanup: () => Promise<void>;
  let instanceId: string;

  beforeEach(() => {
    execHandler = () => ({ stdout: "", stderr: "", exitCode: 0 });
    lastWrite = null;
    const server = createTestServer({ sandbox: cannedSandbox() });
    baseUrl = server.baseUrl;
    cleanup = server.cleanup;
    instanceId = server.seedInstance();
  });

  afterEach(async () => {
    await cleanup();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("404s for an unknown instance", async () => {
    const res = await fetch(`${baseUrl}/api/instances/does-not-exist/files`);
    expect(res.status).toBe(404);
  });

  it("lists and parses NUL/tab-delimited entries", async () => {
    execHandler = () => ({
      stdout: "d\t0\tsrc\0f\t12\treadme.md\0",
      stderr: "",
      exitCode: 0,
    });
    const res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/files?path=${encodeURIComponent("/workspace")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("/workspace");
    expect(body.entries).toEqual([
      { name: "src", path: "/workspace/src", type: "dir", size: null },
      {
        name: "readme.md",
        path: "/workspace/readme.md",
        type: "file",
        size: 12,
      },
    ]);
  });

  it("maps a not-a-directory probe (exit 2) to 404", async () => {
    execHandler = () => ({ stdout: "", stderr: "", exitCode: 2 });
    const res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/files?path=${encodeURIComponent("/workspace/x")}`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an escaping path with 400 before touching the sandbox", async () => {
    let called = false;
    execHandler = () => {
      called = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const res = await post(`/api/instances/${instanceId}/files/delete`, {
      path: "/etc/passwd",
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("deletes and returns ok", async () => {
    const res = await post(`/api/instances/${instanceId}/files/delete`, {
      path: "/workspace/old.txt",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("maps a clobbering rename (exit 17) to 409", async () => {
    execHandler = () => ({ stdout: "", stderr: "", exitCode: 17 });
    const res = await post(`/api/instances/${instanceId}/files/rename`, {
      from: "/workspace/a.txt",
      to: "/workspace/b.txt",
    });
    expect(res.status).toBe(409);
  });

  it("maps an existing mkdir target (exit 17) to 409", async () => {
    execHandler = () => ({ stdout: "", stderr: "", exitCode: 17 });
    const res = await post(`/api/instances/${instanceId}/files/mkdir`, {
      path: "/workspace/dir",
    });
    expect(res.status).toBe(409);
  });

  it("uploads base64 content to the resolved path", async () => {
    const res = await post(`/api/instances/${instanceId}/files/upload`, {
      path: "/workspace/hi.txt",
      content: Buffer.from("hi").toString("base64"),
    });
    expect(res.status).toBe(200);
    expect(lastWrite?.path).toBe("/workspace/hi.txt");
    expect(lastWrite?.content.toString("utf8")).toBe("hi");
  });

  // ---- file-lines (Review tab context expansion) ----
  const RS = "\x1e";

  it("reads a line range and reports more-to-come via the eof flag", async () => {
    // awk-style probe output: the range lines, then a trailing separator+marker.
    execHandler = () => ({
      stdout: `const a = 1;\nconst b = 2;\n${RS}more`,
      stderr: "",
      exitCode: 0,
    });
    const res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/file-lines?path=src/x.ts&start=3&end=4`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lines: ["const a = 1;", "const b = 2;"],
      eof: false,
    });
  });

  it("flags eof when the file ends within the range", async () => {
    execHandler = () => ({
      stdout: `last line\n${RS}eof`,
      stderr: "",
      exitCode: 0,
    });
    const res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/file-lines?path=src/x.ts&start=10&end=30`,
    );
    expect(await res.json()).toEqual({ lines: ["last line"], eof: true });
  });

  it("maps a missing file (exit 2) to 404", async () => {
    execHandler = () => ({ stdout: "", stderr: "", exitCode: 2 });
    const res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/file-lines?path=nope.ts&start=1&end=5`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid or oversized range with 400 before touching the sandbox", async () => {
    let called = false;
    execHandler = () => {
      called = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    expect(
      (await fetch(`${baseUrl}/api/instances/${instanceId}/file-lines?path=x&start=5&end=2`))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/instances/${instanceId}/file-lines?path=x&start=0&end=2`))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/instances/${instanceId}/file-lines?path=x&start=1&end=99999`))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/instances/${instanceId}/file-lines?start=1&end=2`)).status,
    ).toBe(400);
    expect(called).toBe(false);
  });
});
