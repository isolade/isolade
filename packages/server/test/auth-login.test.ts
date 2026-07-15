import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthLoginManager,
  extractAuthorizeUrl,
  type HostProxy,
  parseRedirectPort,
  startCallbackBridge,
  stripAnsi,
} from "../src/auth-login";
import { AuthStore } from "../src/auth-store";
import type { GuestForwarder } from "../src/port-forwarder";

// Real claude loopback URL captured from `claude auth login` (random port).
const CLAUDE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A43749%2Fcallback&scope=user%3Aprofile&code_challenge=Na4q&code_challenge_method=S256&state=OT_p";
// Codex loopback URL shape (fixed port 1455, /auth/callback).
const CODEX_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile&code_challenge=abc&state=xyz";

const CLAUDE_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-x",
    refreshToken: "r",
    expiresAt: 9e12,
  },
});

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[94mhi\x1b[0m")).toBe("hi");
  });
});

describe("extractAuthorizeUrl", () => {
  it("pulls the loopback authorize URL for both providers", () => {
    expect(extractAuthorizeUrl(`Opening browser…\n${CLAUDE_URL}\nPaste...`)).toBe(CLAUDE_URL);
    expect(extractAuthorizeUrl(`go to \x1b[94m${CODEX_URL}\x1b[0m now`)).toBe(CODEX_URL);
  });
  it("returns null before any URL is printed", () => {
    expect(extractAuthorizeUrl("Opening browser to sign in…")).toBeNull();
    expect(extractAuthorizeUrl("")).toBeNull();
  });
});

describe("parseRedirectPort", () => {
  it("reads the loopback port from redirect_uri", () => {
    expect(parseRedirectPort(CLAUDE_URL)).toBe(43749);
    expect(parseRedirectPort(CODEX_URL)).toBe(1455);
  });
  it("returns null when there's no parseable redirect_uri", () => {
    expect(parseRedirectPort("https://example.com/authorize?foo=bar")).toBeNull();
    expect(parseRedirectPort("not a url")).toBeNull();
  });
});

describe("startCallbackBridge", () => {
  it("forwards the callback request to the CLI and serves the browser a success page", async () => {
    let received = "";
    const upstream = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      // The CLI's loopback server: receives the callback, does a slow exchange,
      // then closes. Its response is deliberately NOT relayed to the browser.
      socket: {
        data(s, d) {
          received += Buffer.from(d).toString();
          setTimeout(() => {
            try {
              s.end();
            } catch {}
          }, 200);
        },
      },
    });
    const tmp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = tmp.port;
    tmp.stop(true);
    const bridge = startCallbackBridge(port, "127.0.0.1", upstream.port);
    const browserResp = await new Promise<string>((resolve, reject) => {
      let buf = "";
      void Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(s) {
            s.write("GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n");
          },
          data(_s, d) {
            buf += Buffer.from(d).toString();
          },
          close() {
            resolve(buf);
          },
          error() {
            reject(new Error("connect error"));
          },
        },
      }).catch(reject);
      setTimeout(() => reject(new Error("forward timeout")), 3000);
    });
    await new Promise((r) => setTimeout(r, 150)); // let the forward reach upstream
    bridge.stop();
    upstream.stop(true);
    // Browser gets a clean synthetic success page...
    expect(browserResp).toContain("200 OK");
    expect(browserResp).toContain("Signed in");
    // ...and the auth code still reached the CLI.
    expect(received).toContain("GET /callback?code=abc");
  });

  it("errors clearly when the host port is already taken", () => {
    const blocker = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    expect(() => startCallbackBridge(blocker.port, "127.0.0.1", 9)).toThrow(
      /in use|couldn't open/i,
    );
    blocker.stop(true);
  });
});

// Fake SandboxClient that walks the login choreography deterministically.
function fakeSandbox(opts: { url: string; credBlob: string }) {
  const calls = { destroyed: [] as string[] };
  let credReady = false;
  const client = {
    async createVm() {
      return { vmId: "vm1", ports: [] };
    },
    async destroyVm(id: string) {
      calls.destroyed.push(id);
    },
    async writeFile() {},
    async exec(_vm: string, command: string) {
      if (command.includes("/gc-login-url")) return { stdout: opts.url, stderr: "", exitCode: 0 };
      if (command.includes("credentials.json") || command.includes("auth.json")) {
        // Simulate the user finishing auth shortly after the URL is shown.
        if (!credReady) {
          credReady = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: opts.credBlob, stderr: "", exitCode: 0 };
      }
      return { stdout: "started", stderr: "", exitCode: 0 };
    },
  };
  return { client, calls };
}

const tempStore = () => new AuthStore(mkdtempSync(join(tmpdir(), "gc-login-")));
const fakeProxy = (): HostProxy => ({ stop() {} });
// Fake forwarder: returns a binding without opening a real host listener, so
// the choreography tests don't bind ports (the real one is exercised end-to-end
// in port-forwarder.test.ts).
const fakeForwarder = (): GuestForwarder => ({
  open: async (_vmId, remotePort) => ({
    address: "127.0.0.1",
    localPort: 51000,
    remotePort,
  }),
  close: () => {},
  list: () => [],
  closeAll: () => {},
});
async function waitFor(fn: () => boolean, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

describe("AuthLoginManager (callback orchestration)", () => {
  it("claude: captures URL, bridges the random port, harvests on callback", async () => {
    const { client, calls } = fakeSandbox({
      url: CLAUDE_URL,
      credBlob: CLAUDE_BLOB,
    });
    const store = tempStore();
    const mgr = new AuthLoginManager(client as never, () => "img", fakeProxy, fakeForwarder());

    const s = await mgr.start("claude", store);
    expect(s.state).toBe("awaiting_user");
    expect(s.url).toBe(CLAUDE_URL);

    await waitFor(() => mgr.status(s.sessionId).state === "completed");
    expect(store.read("claude")).toBe(CLAUDE_BLOB);
    expect(calls.destroyed).toContain("vm1");
  });

  it("codex: bridges its fixed loopback port and harvests on callback", async () => {
    const { client } = fakeSandbox({
      url: CODEX_URL,
      credBlob: JSON.stringify({ tokens: { access_token: "h.p.s" } }),
    });
    const store = tempStore();
    const mgr = new AuthLoginManager(client as never, () => "img", fakeProxy, fakeForwarder());
    const s = await mgr.start("codex", store);
    expect(s.state).toBe("awaiting_user");
    await waitFor(() => mgr.status(s.sessionId).state === "completed");
    expect(store.has("codex")).toBe(true);
  });

  it("errors cleanly when no login image is available", async () => {
    const { client } = fakeSandbox({ url: CLAUDE_URL, credBlob: CLAUDE_BLOB });
    const mgr = new AuthLoginManager(client as never, () => null, fakeProxy, fakeForwarder());
    await expect(mgr.start("claude", tempStore())).rejects.toThrow(/no built profile image/i);
  });
});
