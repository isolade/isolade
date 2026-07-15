import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "crypto";
import { type CreateAppOptions, createApp } from "../src/app";
import { schema } from "../src/db";

// Isolate XDG dirs so a test server's profile/auth/git/network state writes to a
// throwaway temp tree, never the developer's real ~/.config / ~/.local. Returns
// a restore() that puts the env back and removes the temp tree.
function isolateXdg(): { restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "isolade-srv-"));
  const vars = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
  const prev = new Map(vars.map((v) => [v, process.env[v]] as const));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.XDG_STATE_HOME = join(root, "state");
  return {
    restore() {
      for (const [v, value] of prev) {
        if (value === undefined) delete process.env[v];
        else process.env[v] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const originalFetch = globalThis.fetch.bind(globalThis);
const appFetchRegistry = new Map<string, (request: Request) => Response | Promise<Response>>();
let fetchShimInstalled = false;

function installFetchShim() {
  if (fetchShimInstalled) return;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const handler = appFetchRegistry.get(new URL(request.url).host);
    if (handler) return Promise.resolve(handler(request));
    return originalFetch(input as never, init);
  }) as typeof fetch;

  fetchShimInstalled = true;
}

function unregisterFetchHost(host: string) {
  appFetchRegistry.delete(host);
  if (appFetchRegistry.size === 0 && fetchShimInstalled) {
    globalThis.fetch = originalFetch;
    fetchShimInstalled = false;
  }
}

export function createTestServer(dbPathOrOpts?: string | CreateAppOptions) {
  const opts: CreateAppOptions =
    typeof dbPathOrOpts === "string" || dbPathOrOpts === undefined
      ? { dbPath: dbPathOrOpts || ":memory:", skipResync: true }
      : { dbPath: ":memory:", skipResync: true, ...dbPathOrOpts };
  const xdg = isolateXdg();
  const { app, instances, chatManager, chatStreamHub, db, websocket } = createApp(opts);

  // Real loopback server so WebSocket upgrades work, and the fetch shim below
  // covers server-origin HTTP requests, but `new WebSocket(...)` bypasses it.
  const server = Bun.serve({
    fetch: app.fetch,
    websocket,
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
  });
  const host = `127.0.0.1:${server.port}`;

  installFetchShim();
  appFetchRegistry.set(host, (request) => app.request(request));

  const baseUrl = `http://${host}`;
  const wsUrl = `ws://${host}`;

  /** Insert a minimal instance row directly, no VM needed for CRUD tests. */
  function seedInstance() {
    const id = randomUUID();
    db.insert(schema.instances)
      .values({
        id,
        vmId: `vm-${id.slice(0, 8)}`,
        status: "running",
        image: "test-image",
        profileId: "default",
      })
      .run();
    return id;
  }

  return {
    baseUrl,
    wsUrl,
    instances,
    chatManager,
    chatStreamHub,
    db,
    seedInstance,
    async cleanup() {
      await instances.cleanup();
      unregisterFetchHost(host);
      server.stop(true);
      xdg.restore();
    },
  };
}
