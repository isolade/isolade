import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What codex actually puts on the wire, driven through the same JSON-RPC calls
// CodexManager/CodexBackend make, against a stub that captures the request body.
//
// This exists because the two facts our prompt design rests on are not visible in
// codex's source without a long trace, and reading it wrong is easy: an earlier
// pass concluded `baseInstructions` would strip the apply_patch contract and left
// the design layering instead. It also catches the reverse mistake — a config key
// that silently does nothing. `-c base_instructions=...` is not a real key (the
// TOML name is `instructions`), and a run using it looks perfectly healthy while
// changing nothing at all. Every assertion below therefore checks that a sentinel
// LANDED, not merely that the call succeeded.
//
// Needs the `codex` binary but no VM: codex runs on the host, pointed at a
// loopback stub. Skipped where codex is absent, in the spirit of the
// hasV6Loopback gate in port-forwarder.test.ts.
const hasCodex = Bun.which("codex") !== null;

type Captured = { instructions?: string; input?: unknown[]; tools?: unknown[] };

let stub: ReturnType<typeof Bun.serve> | null = null;
let codexHome = "";
let workdir = "";
// Resolved by the stub's fetch handler. A turn is only observable once codex
// actually calls out, which happens AFTER turn/start returns its id, so waiting on
// the JSON-RPC reply would race and waiting on a sleep would be flaky.
let onCapture: ((request: Captured) => void) | null = null;

beforeAll(() => {
  if (!hasCodex) return;
  // 400 on every call: we only want the request body, and failing fast means the
  // turn ends immediately instead of waiting on a model that will never answer.
  stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      onCapture?.((await request.json()) as Captured);
      return Response.json(
        { error: { message: "captured", type: "invalid_request_error" } },
        { status: 400 },
      );
    },
  });
  codexHome = mkdtempSync(join(tmpdir(), "isolade-codex-home-"));
  workdir = mkdtempSync(join(tmpdir(), "isolade-codex-work-"));
});

afterAll(() => {
  stub?.stop(true);
  for (const dir of [codexHome, workdir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run one turn through `codex app-server` and return the request it made.
 *
 * `threadStart` is merged into the thread/start params, which is the only place
 * codex accepts either instruction field (thread/resume and turn/start accept
 * neither), so it is also the only thing this can vary.
 */
async function captureTurn(threadStart: Record<string, unknown>): Promise<Captured> {
  let settle: (request: Captured) => void = () => {};
  const firstRequest = new Promise<Captured>((resolve) => {
    settle = resolve;
  });
  onCapture = (request) => {
    onCapture = null; // first request only; retries would overwrite it
    settle(request);
  };

  const proc = Bun.spawn(
    [
      "codex",
      "app-server",
      "--listen",
      "stdio://",
      "--disable",
      "apps",
      // The same posture CodexManager launches with, so the tool set under test
      // matches the tool set in production.
      "-c",
      "features.memories=false",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=danger-full-access",
      "-c",
      "agents.enabled=false",
      "-c",
      "model_provider=stub",
      "-c",
      'model_providers.stub.name="stub"',
      "-c",
      `model_providers.stub.base_url="http://127.0.0.1:${stub?.port}/v1"`,
      "-c",
      'model_providers.stub.wire_api="responses"',
      "-c",
      'model_providers.stub.env_key="OPENAI_API_KEY"',
    ],
    {
      cwd: workdir,
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "sk-stub" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const send = (id: number, method: string, params: unknown) =>
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

  // Read newline-delimited JSON-RPC until the response with `id` arrives.
  const awaitId = async (id: number): Promise<Record<string, unknown> | null> => {
    for (;;) {
      const newlineAt = buffered.indexOf("\n");
      if (newlineAt === -1) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffered += decoder.decode(value, { stream: true });
        continue;
      }
      const line = buffered.slice(0, newlineAt);
      buffered = buffered.slice(newlineAt + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === id && ("result" in msg || "error" in msg)) return msg;
    }
  };

  try {
    send(1, "initialize", {
      clientInfo: { name: "isolade", version: "1.0" },
      capabilities: { experimentalApi: true },
    });
    expect(await awaitId(1)).not.toBeNull();

    send(2, "thread/start", { ephemeral: false, personality: "none", ...threadStart });
    const started = await awaitId(2);
    const threadId = (started?.result as { thread?: { id?: string } } | undefined)?.thread?.id;
    expect(threadId).toBeTruthy();

    send(3, "turn/start", {
      threadId,
      model: "gpt-5-codex",
      input: [{ type: "text", text: "hi" }],
    });
    return await Promise.race([
      firstRequest,
      Bun.sleep(30_000).then(() => {
        throw new Error("codex made no request to the stub within 30s");
      }),
    ]);
  } finally {
    onCapture = null;
    proc.kill();
    await proc.exited;
  }
}

const textOf = (item: unknown): string => {
  const content = (item as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
};

describe.skipIf(!hasCodex)("codex against a stub API", () => {
  const SENTINEL = "ISOLADE_SENTINEL_TEXT";
  // A line unique to codex's own prompt, used to tell "replaced" from "layered".
  const CODEX_OWN = "You are Codex";

  it("baseInstructions replaces codex's own prompt in the instructions slot", async () => {
    const request = await captureTurn({ baseInstructions: SENTINEL });

    expect(request.instructions).toBe(SENTINEL);
    expect(JSON.stringify(request)).not.toContain(CODEX_OWN);
  }, 60_000);

  it("developerInstructions layers on top, leaving codex's prompt in place", async () => {
    const request = await captureTurn({ developerInstructions: SENTINEL });

    // Codex's own prompt keeps the instructions slot...
    expect(request.instructions).toContain(CODEX_OWN);
    // ...and ours arrives as a developer-role message in the conversation input.
    const developerText = (request.input ?? [])
      .filter((item) => (item as { role?: string }).role === "developer")
      .map(textOf);
    expect(developerText.some((text) => text.includes(SENTINEL))).toBe(true);
  }, 60_000);

  it("sends its tool specs either way, so replacing the prompt costs guidance only", async () => {
    // The premise of replacing codex's prompt at all: capability travels with the
    // tools, not the prose. If this ever fails, buildSystemPrompt has to carry
    // tool descriptions too, not just CODEX_PATCH_RULES.
    const replaced = await captureTurn({ baseInstructions: SENTINEL });
    const layered = await captureTurn({ developerInstructions: SENTINEL });

    const names = (request: Captured) =>
      (request.tools ?? [])
        .map(
          (tool) =>
            (tool as { name?: string; type?: string }).name ?? (tool as { type?: string }).type,
        )
        .sort();

    expect(names(replaced).length).toBeGreaterThan(0);
    expect(names(replaced)).toEqual(names(layered));
  }, 90_000);

  it("does not expose a patch tool for this model, which is why our guidance is conditional", async () => {
    // `apply_patch` is gated on model_info.apply_patch_tool_type, a field from the
    // server-supplied models manifest, so its presence is not ours to decide. This
    // pins the reason CODEX_PATCH_RULES says "if you edit files by writing a patch"
    // rather than naming a tool. A stub cannot fetch the manifest, so this asserts
    // the fallback behaviour; treat a failure here as the manifest having changed
    // rather than as a regression.
    const request = await captureTurn({ baseInstructions: SENTINEL });
    const names = (request.tools ?? []).map((tool) => (tool as { name?: string }).name);

    expect(names).not.toContain("apply_patch");
    expect(names).toContain("exec_command");
  }, 60_000);
});
