import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestServer } from "./helpers";

// The bearer-token gate the Tauri host arms via ISOLADE_AUTH_TOKEN. Tests pass
// the token through CreateAppOptions.authToken so they don't have to mutate the
// process env. fetch-based callers authenticate with the Authorization header,
// and header-less callers (EventSource, WebSocket, sendBeacon) use a ?token=
// param. The middleware accepts either, so both paths are exercised here.
const TOKEN = "test-secret-token";

// Resolve with the WebSocket close code. A handshake blocked by the auth
// middleware never reaches the terminal route, so it fails the upgrade (abnormal
// close 1006). One that clears auth reaches the route and is closed 1008 because
// the terminal doesn't exist. The code thus tells us which layer rejected it.
function wsCloseCode(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), 5000);
    ws.onclose = (e) => {
      clearTimeout(timer);
      resolve(e.code);
    };
    ws.onerror = () => {}; // a failed handshake can also surface as error
  });
}

describe("bearer-token auth", () => {
  describe("when a token is configured", () => {
    let baseUrl: string;
    let wsUrl: string;
    let instanceId: string;
    let cleanup: () => Promise<void>;

    beforeAll(() => {
      const server = createTestServer({ authToken: TOKEN });
      baseUrl = server.baseUrl;
      wsUrl = server.wsUrl;
      instanceId = server.seedInstance();
      cleanup = server.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it("rejects a request with no token (401)", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(401);
    });

    it("rejects the wrong bearer token (401)", async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: "Bearer nope" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts the correct bearer token header (200)", async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });

    it("accepts the token as a ?token= query param (200)", async () => {
      const res = await fetch(`${baseUrl}/api/health?token=${TOKEN}`);
      expect(res.status).toBe(200);
    });

    it("rejects a wrong ?token= query param (401)", async () => {
      const res = await fetch(`${baseUrl}/api/health?token=nope`);
      expect(res.status).toBe(401);
    });

    it("blocks a WebSocket upgrade with no token", async () => {
      const code = await wsCloseCode(
        `${wsUrl}/api/instances/${instanceId}/terminals/x/socket?rows=24&cols=80`,
      );
      expect(code).not.toBe(1008); // rejected at auth, never reached the route
    });

    it("lets a WebSocket upgrade past auth with a ?token= param", async () => {
      const code = await wsCloseCode(
        `${wsUrl}/api/instances/${instanceId}/terminals/x/socket?rows=24&cols=80&token=${TOKEN}`,
      );
      expect(code).toBe(1008); // cleared auth, then the route rejects the bogus terminal
    });
  });

  describe("when no token is configured", () => {
    let baseUrl: string;
    let cleanup: () => Promise<void>;

    beforeAll(() => {
      const server = createTestServer(); // no authToken → gate disabled (dev/browser flow)
      baseUrl = server.baseUrl;
      cleanup = server.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it("leaves the API open (200 without any token)", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
    });
  });
});
