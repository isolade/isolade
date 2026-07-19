import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "bun";
import { type AuthStore, type Provider, parseExpiresAt } from "./auth-store";
import { CLIENT_ID_ENV } from "./mount-map";
import { CTL_SOCK } from "./port-control";
import { ExecRelayForwarder, type GuestForwarder } from "./port-forwarder";
import type { SandboxApi } from "./sandbox-client";

// In-app login for Claude / Codex using each CLI's loopback OAuth (callback)
// flow, run inside a throwaway VM so isolade needs neither CLI authenticated
// on the host:
//
//   claude auth login --claudeai   : with BROWSER pointed at a capture script
//     (so openBrowser succeeds → loopback branch), claude binds a RANDOM
//     127.0.0.1:K and uses redirect_uri=http://localhost:K/callback.
//   codex login                    : binds a FIXED 127.0.0.1:1455 and uses
//     redirect_uri=http://localhost:1455/auth/callback.
//
// The user authorizes in their host browser, which redirects to localhost:<K>.
// We bridge that back to the CLI's in-VM loopback server K with the dynamic
// loopback forwarder (the same one that backs the Ports panel):
//
//   host browser → host:K  ──(host callback bridge)──▶  host:P
//                                                        │ per-connection exec relay
//                                                        ▼
//                                              guest 127.0.0.1:K → CLI
//
// The forwarder dials guest loopback directly, so, unlike the old
// published-port path, no guest-side proxy is needed to reach a CLI bound to
// 127.0.0.1, and nothing is published at VM-create. redirect_uri stays
// byte-identical end to end (no rewriting), so PKCE accepts the exchange. On
// success the CLI writes its credential file, which we harvest into the store.

// ---------------------------------------------------------------------------
// Pure parsing helpers (unit-tested against real CLI output).
// ---------------------------------------------------------------------------

// The ESC (\x1b) control char is exactly what an ANSI SGR sequence starts with.
// matching it here is intentional, so the control-regex rule doesn't apply.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** The authorize URL the CLI hands the browser, identified by its loopback
 * redirect_uri param. Works for both providers. */
export function extractAuthorizeUrl(out: string): string | null {
  const m = stripAnsi(out).match(/https:\/\/[^\s'"]*[?&]redirect_uri=[^\s'"]*/);
  return m ? m[0] : null;
}

/** The loopback port the CLI bound, read from the authorize URL's redirect_uri
 * (e.g. http://localhost:43749/callback → 43749). */
export function parseRedirectPort(authorizeUrl: string): number | null {
  try {
    const redirect = new URL(authorizeUrl).searchParams.get("redirect_uri");
    if (!redirect) return null;
    const r = new URL(redirect);
    const port = r.port ? Number(r.port) : r.protocol === "https:" ? 443 : 80;
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Host-side callback bridge (Bun).
//
// The browser hits host:listenPort with the OAuth callback. We FORWARD the
// request to the CLI's in-VM loopback server (targetHost:targetPort, a
// microsandbox-published port), and that carries the auth code, which is all the
// CLI needs to complete the exchange and write its credential file. We then
// serve the browser our OWN success page rather than relaying the CLI's
// response: the guest→host return hop through microsandbox is unreliable for a
// single-shot connection that the guest closes immediately, which surfaced as
// an empty browser response. The browser never needs the CLI's page (it's just
// "you can close this tab"), so we synthesize a clean one and let isolade's
// completion poll confirm the actual sign-in.
// ---------------------------------------------------------------------------

export interface HostProxy {
  stop(): void;
}

interface BridgeClient {
  upstream: Socket<undefined> | null;
  pending: Uint8Array[];
  responded: boolean;
}

const SUCCESS_BODY =
  "<!doctype html><meta charset=utf-8><title>Signed in</title>" +
  // Auto-close the tab (only works when it was opened by script, see the
  // window.open without `noopener` in ProvidersTab). Falls back to the message
  // below if the browser blocks programmatic close.
  "<script>setTimeout(function(){try{window.close()}catch(e){}},300)</script>" +
  '<body style="font:15px/1.5 system-ui;text-align:center;padding:3rem;color:#1a1a1a">' +
  "<h2>✓ Signed in</h2><p>You can close this tab and return to isolade.</p></body>";

function httpSuccess(): string {
  return (
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/html; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(SUCCESS_BODY)}\r\n` +
    "Connection: close\r\n\r\n" +
    SUCCESS_BODY
  );
}

export function startCallbackBridge(
  listenPort: number,
  targetHost: string,
  targetPort: number,
): HostProxy {
  let server;
  try {
    server = Bun.listen<BridgeClient>({
      hostname: "127.0.0.1",
      port: listenPort,
      socket: {
        open(client) {
          client.data = { upstream: null, pending: [], responded: false };
          void Bun.connect<undefined>({
            hostname: targetHost,
            port: targetPort,
            socket: {
              open(up) {
                client.data.upstream = up;
                for (const b of client.data.pending) up.write(b);
                client.data.pending = [];
              },
              // Drain (and discard) the CLI's response. The browser gets ours.
              data() {},
              close() {},
              error() {},
            },
          }).catch(() => {});
        },
        data(client, d) {
          // Forward the callback request (carrying the auth code) to the CLI.
          if (client.data.upstream) client.data.upstream.write(d);
          else client.data.pending.push(d);
          // Answer the browser ourselves, exactly once, then close its side.
          if (!client.data.responded) {
            client.data.responded = true;
            client.write(httpSuccess());
            client.end();
          }
        },
        close() {},
        error() {},
      },
    });
  } catch (err) {
    throw new Error(
      `couldn't open host port ${listenPort} for the login callback (already in use?): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  return {
    stop() {
      try {
        server.stop(true);
      } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Per-provider login config.
// ---------------------------------------------------------------------------

interface ProviderLogin {
  /** Login command (run with BROWSER pointed at the capture script). */
  command: string;
  /** $HOME-relative path of the credential file written on success. */
  credRelPath: string;
  /** Validate the harvested blob carries tokens before storing it. */
  validate: (raw: string) => boolean;
}

const LOGIN: Record<Provider, ProviderLogin> = {
  claude: {
    command: "claude auth login --claudeai",
    credRelPath: ".claude/.credentials.json",
    validate: (raw) => {
      try {
        return typeof JSON.parse(raw)?.claudeAiOauth?.accessToken === "string";
      } catch {
        return false;
      }
    },
  },
  codex: {
    command: "codex login",
    credRelPath: ".codex/auth.json",
    validate: (raw) => {
      try {
        return typeof JSON.parse(raw)?.tokens?.access_token === "string";
      } catch {
        return false;
      }
    },
  },
};

// Guest paths used by the login choreography.
const CAP_PATH = "/tmp/gc-login-cap.sh";
const URL_PATH = "/tmp/gc-login-url";
const LOG_PATH = "/tmp/gc-login.log";

export type LoginState = "starting" | "awaiting_user" | "completed" | "error";

export interface LoginStatus {
  sessionId: string;
  provider: Provider;
  state: LoginState;
  /** URL the user opens to authorize. */
  url: string | null;
  error: string | null;
}

export interface ProviderAuthStatus {
  loggedIn: boolean;
  expiresAt: number | null;
}

interface LoginSession {
  id: string;
  provider: Provider;
  vmId: string;
  state: LoginState;
  url: string | null;
  error: string | null;
  hostProxy: HostProxy | null;
  poll: ReturnType<typeof setInterval> | null;
  createdAt: number;
  /** The profile's credential store to harvest the login into. */
  store: AuthStore;
  /** Nested only: the pinned host:K→devVM:K forward requested from the OUTER
   * isolade for this login's callback (released on teardown). */
  outerForwardPort: number | null;
}

// One request → one reply against the in-VM control socket the OUTER isolade's
// broker serves (the same protocol the `isolade` guest CLI speaks, see
// port-control.ts). Only used when this server runs nested.
function ctlRequest(payload: unknown, timeoutMs = 5000): Promise<{ ok?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const conn = connect(CTL_SOCK);
    const timer = setTimeout(() => {
      conn.destroy(new Error("control-socket request timed out"));
    }, timeoutMs);
    conn.on("connect", () => conn.end(JSON.stringify(payload)));
    conn.on("data", (d) => chunks.push(Buffer.from(d)));
    conn.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("malformed control-socket response"));
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const URL_TIMEOUT_MS = 60_000;
const COMPLETION_POLL_MS = 2000;
const SESSION_TTL_MS = 15 * 60_000;

export class AuthLoginManager {
  private sessions = new Map<string, LoginSession>();

  constructor(
    private sandbox: SandboxApi,
    private getLoginImage: () => string | null,
    /** Injectable for tests so they don't bind real host ports. */
    private startProxy: (
      listenPort: number,
      targetHost: string,
      targetPort: number,
    ) => HostProxy = startCallbackBridge,
    /** Loopback forwarder used to reach the CLI's in-VM callback port. Defaults
     * to the exec-relay forwarder over the same sandbox, injectable for tests. */
    private forwarder: GuestForwarder = new ExecRelayForwarder(sandbox),
  ) {}

  // `store` is the target profile's credential store (ProfileManager.auth): the
  // client names the profile per request, so there is no server-side "active
  // profile" and the login always harvests into that specific profile.
  async start(provider: Provider, store: AuthStore): Promise<LoginStatus> {
    const image = this.getLoginImage();
    if (!image) {
      throw new Error(
        "No built profile image available to host the login VM. Build a profile first.",
      );
    }
    const cfg = LOGIN[provider];

    // Free any prior in-flight login for this provider: its host bridge still
    // holds a host port (codex's is always 1455) and a VM, which would make a
    // retry fail with "host port already in use".
    for (const [id, s] of this.sessions) {
      if (s.provider === provider && s.state !== "completed") {
        this.teardown(s);
        this.sessions.delete(id);
      }
    }

    // No `network` policy: the login VM intentionally runs with open internet.
    // OAuth needs broad reach (provider auth hosts + identity-provider redirects
    // that the global allowlist wouldn't list), it's user-initiated, runs no
    // agent turns, and is destroyed the moment login completes, so it's outside
    // the allowlist's threat surface (a long-lived agent exfiltrating data).
    const { vmId } = await this.sandbox.createVm({ image });
    const session: LoginSession = {
      id: randomUUID(),
      provider,
      vmId,
      state: "starting",
      url: null,
      error: null,
      hostProxy: null,
      poll: null,
      createdAt: Date.now(),
      store,
      outerForwardPort: null,
    };
    this.sessions.set(session.id, session);

    try {
      // 1. Capture script (base64-injected so it's agent-owned + chmod-able).
      const capB64 = Buffer.from(`#!/bin/sh\necho "$1" > ${URL_PATH}\n`).toString("base64");
      await this.sandbox.exec(
        vmId,
        `sh -c 'echo ${capB64} | base64 -d > ${CAP_PATH} && chmod +x ${CAP_PATH}'`,
      );

      // 2. Launch the login flow detached. BROWSER=capture forces the loopback
      //    branch and hands us the authorize URL.
      await this.sandbox.exec(
        vmId,
        `sh -c 'rm -f ${URL_PATH} ${LOG_PATH}; BROWSER=${CAP_PATH} setsid ${cfg.command} > ${LOG_PATH} 2>&1 < /dev/null & echo started'`,
      );

      // 3. Wait for the authorize URL (capture file, with stdout as a backstop).
      const url = await this.pollForUrl(vmId);
      session.url = url;

      // 4. Bridge the CLI's loopback port K. Open a loopback forward to guest
      //    127.0.0.1:K (the forwarder dials guest loopback directly, so the CLI
      //    needs no guest-side proxy), then run the host callback bridge on K
      //    → the forward's host port P (the browser hits localhost:K per the
      //    redirect_uri).
      const k = parseRedirectPort(url);
      if (k === null) throw new Error("could not parse the loopback port from the login URL");
      const { localPort: hostP } = await this.forwarder.open(vmId, k);
      session.hostProxy = this.startProxy(k, "127.0.0.1", hostP);

      // 5. Nested only (this server runs inside an expose_sandbox dev VM):
      //    the redirect_uri sends the HOST browser to localhost:K, but our
      //    bridge just bound THIS guest's loopback K. Ask the outer isolade —
      //    over the control socket its broker already serves in this VM — to
      //    pin a forward host:K → devVM:K, completing the chain for both
      //    providers with no config and no manual step. Best-effort: on
      //    failure the login URL still renders, and a pinned `isolade ports
      //    add K:K` in a dev-VM terminal completes the chain by hand.
      await this.ensureOuterCallbackForward(session, k);

      session.state = "awaiting_user";
      this.startCompletionPoll(session, cfg);
      return this.toStatus(session);
    } catch (err) {
      session.state = "error";
      session.error = err instanceof Error ? err.message : String(err);
      this.teardown(session);
      throw err;
    }
  }

  status(sessionId: string): LoginStatus {
    return this.toStatus(this.requireSession(sessionId));
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.teardown(session);
    this.sessions.delete(sessionId);
  }

  providerStatus(provider: Provider, store: AuthStore): ProviderAuthStatus {
    // read() is null exactly when the profile hasn't signed in (no host
    // fallback), so it doubles as the "logged in?" check.
    const raw = store.read(provider);
    if (!raw) return { loggedIn: false, expiresAt: null };
    return { loggedIn: true, expiresAt: parseExpiresAt(provider, raw) };
  }

  logout(provider: Provider, store: AuthStore): void {
    store.remove(provider);
  }

  // Poll the capture file (and stdout backstop) until the authorize URL appears.
  private async pollForUrl(vmId: string): Promise<string> {
    const deadline = Date.now() + URL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { stdout } = await this.sandbox.exec(
        vmId,
        `sh -c 'cat ${URL_PATH} ${LOG_PATH} 2>/dev/null'`,
      );
      const url = extractAuthorizeUrl(stdout);
      if (url) return url;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("timed out waiting for the login URL");
  }

  // Background poll: the detached CLI writes its credential file once the
  // browser callback completes. Harvest it and tear down.
  private startCompletionPoll(session: LoginSession, cfg: ProviderLogin): void {
    session.poll = setInterval(() => {
      void (async () => {
        if (session.state !== "awaiting_user") return;
        if (Date.now() - session.createdAt > SESSION_TTL_MS) {
          session.state = "error";
          session.error = "login timed out";
          this.teardown(session);
          return;
        }
        try {
          const { stdout, exitCode } = await this.sandbox.exec(
            session.vmId,
            `sh -c 'cat "$HOME/${cfg.credRelPath}" 2>/dev/null'`,
          );
          if (exitCode === 0 && cfg.validate(stdout)) {
            session.store.ensureDir();
            session.store.write(session.provider, stdout);
            session.state = "completed";
            session.error = null;
            this.teardown(session);
          }
        } catch {
          // transient exec failure, try again next tick
        }
      })();
    }, COMPLETION_POLL_MS);
  }

  // Nested-mode helper for the login callback chain (see step 5 in start()).
  // No-op unless this server was created with a nested identity AND the outer
  // isolade's control broker is reachable.
  //
  // The pin is requested EPHEMERAL: this login session lives only in memory,
  // so a persisted pin whose session died (a `bun --watch` restart mid-login
  // is routine in the dev loop) would be reopened by the outer isolade on
  // every dev-VM boot, squatting host:K (codex's K is always 1455) against
  // the host's own logins with nothing behind it. Ephemeral, a lost pin
  // simply dies with the dev VM's forwarder, and a login retry re-requests
  // it idempotently. (An outer isolade too old to know the flag persists the
  // pin — old behavior, released on teardown as before.)
  private async ensureOuterCallbackForward(session: LoginSession, k: number): Promise<void> {
    if (!process.env[CLIENT_ID_ENV] || !existsSync(CTL_SOCK)) return;
    try {
      const res = await ctlRequest({ cmd: "forward", port: k, hostPort: k, ephemeral: true });
      if (res.ok) {
        session.outerForwardPort = k;
        console.log(`[auth-login] outer isolade now forwards host:${k} → this VM:${k}`);
      } else {
        console.warn(
          `[auth-login] outer pinned forward for ${k} refused: ${res.error ?? "unknown error"}. ` +
            `Run \`isolade ports add ${k}:${k}\` in a dev-VM terminal to complete the login chain.`,
        );
      }
    } catch (err) {
      console.warn(`[auth-login] outer pinned forward for ${k} failed:`, err);
    }
  }

  // Stop the host proxy + completion poll and destroy the throwaway VM. Leaves
  // the session record so status() still works after completion/error.
  private teardown(session: LoginSession): void {
    if (session.poll) {
      clearInterval(session.poll);
      session.poll = null;
    }
    if (session.hostProxy) {
      session.hostProxy.stop();
      session.hostProxy = null;
    }
    // Release the outer pinned callback forward, if this login requested one.
    if (session.outerForwardPort !== null) {
      const port = session.outerForwardPort;
      session.outerForwardPort = null;
      if (existsSync(CTL_SOCK)) {
        ctlRequest({ cmd: "unforward", port }).catch((err) => {
          console.warn(`[auth-login] releasing outer forward ${port} failed:`, err);
        });
      }
    }
    // Close the host-side forward listener (its guest relay dies with the VM).
    this.forwarder.closeAll(session.vmId);
    this.sandbox.destroyVm(session.vmId).catch(() => {});
  }

  private toStatus(session: LoginSession): LoginStatus {
    return {
      sessionId: session.id,
      provider: session.provider,
      state: session.state,
      url: session.url,
      error: session.error,
    };
  }

  private requireSession(sessionId: string): LoginSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown login session ${sessionId}`);
    return session;
  }
}
