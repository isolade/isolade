import { describe, expect, it } from "bun:test";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS } from "../src/chat/claude-backend";

// What the Claude CLI actually puts on the wire under isolade's flags, captured
// from a loopback stub standing in for the Anthropic API.
//
// This exists because the tool schemas, not the system prompt, are the bulk of
// every request — ~59KB against ~1KB — and none of it is visible from the flags
// alone. Two claims in particular are asserted rather than assumed:
//
//   `--disallowedTools` removes a tool from the request body, rather than merely
//   refusing the call. `--allowedTools` does NOT: it gates permission and leaves
//   every schema on the wire, so it is not a substitute.
//
//   The surviving set is exactly ALLOWED_TOOLS. Being a deny list, DISALLOWED_TOOLS
//   fails open, so a tool introduced by a future CLI version would otherwise slip
//   in unnoticed. Here it fails the build instead.
//
// Needs the `claude` binary but no VM: the CLI runs on the host with
// ANTHROPIC_BASE_URL pointed at the stub. Skipped where claude is absent, in the
// spirit of the hasCodex gate in codex-stub-api.test.ts.
const hasClaude = Bun.which("claude") !== null;

type Captured = {
  system?: { text?: string }[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
};

/**
 * A minimal streaming response. The CLI needs a well-formed message envelope to
 * exit cleanly rather than retry, and one turn is all we need to see the request.
 */
function stubStream(): Response {
  const event = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }) +
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }) +
      event("content_block_stop", { type: "content_block_stop", index: 0 }) +
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }) +
      event("message_stop", { type: "message_stop" }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Run one headless turn against a stub and return the request body it sent. */
async function capture(extraArgs: string[]): Promise<Captured> {
  let body: Captured | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/messages")) {
        return Response.json({});
      }
      // First request only: the CLI may make more, and the first is the one whose
      // flags we set.
      body ??= (await request.json()) as Captured;
      return stubStream();
    },
  });
  try {
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        "say ok",
        "--model",
        "claude-opus-5",
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        ...extraArgs,
      ],
      {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          // Beats any ambient subscription login, so the run cannot escape to the
          // real API and cannot depend on this machine being signed in.
          ANTHROPIC_API_KEY: "sk-stub",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await proc.exited;
  } finally {
    server.stop(true);
  }
  if (!body) throw new Error("claude made no request to the stub");
  return body;
}

const names = (c: Captured) => (c.tools ?? []).map((t) => t.name).toSorted();
const toolBytes = (c: Captured) => JSON.stringify(c.tools ?? []).length;

describe.skipIf(!hasClaude)("claude against a stub API", () => {
  const ISOLADE_ARGS = [
    "--system-prompt",
    "STUB",
    "--settings",
    JSON.stringify({ attribution: { commit: "", pr: "" } }),
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
  ];

  it("sends exactly the allowed tools, and nothing else", async () => {
    expect(names(await capture(ISOLADE_ARGS))).toEqual([...ALLOWED_TOOLS].toSorted());
  }, 60_000);

  it("drops the disallowed schemas from the body rather than just refusing calls", async () => {
    // The whole premise. If denying a tool only blocked the call, the request
    // would be the same size and this change would buy nothing.
    const [bare, denied] = await Promise.all([
      capture(["--system-prompt", "STUB"]),
      capture(ISOLADE_ARGS),
    ]);
    expect(toolBytes(bare)).toBeGreaterThan(40_000);
    // A ratio rather than a byte count, since the schemas are the CLI's to reword
    // and the point is that denial is subtractive at all.
    expect(toolBytes(denied) * 2).toBeLessThan(toolBytes(bare));
  }, 120_000);

  it("cannot get the same result from --allowedTools", async () => {
    // Documents why the deny list has to enumerate everything: the allow list
    // leaves every schema on the wire, so it is not the shorter way to write this.
    const allowed = await capture(["--system-prompt", "STUB", "--allowedTools", ...ALLOWED_TOOLS]);
    expect(names(allowed).length).toBeGreaterThan(ALLOWED_TOOLS.length);
  }, 60_000);

  it("replaces the CLI's prompt, leaving only the SDK identity line beside ours", async () => {
    // Establishes that nothing else — no environment section, no cwd, no
    // permission-mode text — survives the replacement, which is why
    // system-prompt.ts states the workspace root and the sandbox posture itself.
    const captured = await capture(ISOLADE_ARGS);
    const texts = (captured.system ?? []).map((block) => block.text ?? "");
    expect(texts).toContain("STUB");
    expect(texts.some((t) => t.includes("Claude Agent SDK"))).toBe(true);
    expect(texts.join("\n")).not.toContain("Working directory");
    expect(texts.reduce((sum, t) => sum + t.length, 0)).toBeLessThan(500);
  }, 60_000);

  it("blanks the attribution the Bash tool would otherwise advertise", async () => {
    // Our prompt asks for an `Assisted-by: Isolade:<model>` trailer, and the Bash
    // description is not covered by --system-prompt, so at its defaults the tool
    // would name a competing Co-Authored-By line.
    const bash = (c: Captured) => c.tools?.find((t) => t.name === "Bash")?.description ?? "";
    expect(bash(await capture(["--system-prompt", "STUB"]))).toContain("Co-Authored-By");
    const blanked = bash(await capture(ISOLADE_ARGS));
    expect(blanked).not.toContain("Co-Authored-By");
    expect(blanked).not.toContain("Generated with");
  }, 120_000);
});
