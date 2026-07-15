import { homedir } from "node:os";
import { join } from "node:path";
import { createRegistryApp } from "./routes";
import { RegistryStore } from "./store";

export interface RegistryServer {
  readonly port: number;
  readonly store: RegistryStore;
  // Add a second listener on `hostname:port` (same handler) so guest VMs can
  // reach the registry via the bridge gateway IP. Idempotent, so only the first
  // call binds. The bridge interface doesn't exist until the first VM boots,
  // which is why guest reachability is deferred to here rather than bound at
  // startup. If the targeted bind fails it falls back to 0.0.0.0 so image
  // push/pull is never broken (at the cost of LAN exposure). A 127.0.0.1/
  // localhost hostname is a no-op (the loopback listener already covers it).
  ensureNetworkListener(hostname: string): void;
  stop(): Promise<void>;
}

interface StartOptions {
  port: number;
  dataDir?: string;
}

// Stand up the in-process OCI registry. Binds 127.0.0.1:<port> at startup:
// host-side pulls (the post-build `microsandbox pull`) connect via loopback,
// and macOS won't reliably loop a connect back to the host's own bridge IP.
// Guest reachability (build VMs push, workspace VMs pull, via the bridge
// gateway IP) is added later through ensureNetworkListener once the bridge
// interface is up, so the registry stays off the LAN/Wi-Fi interface.
//
// One server per sandbox process. Boot is synchronous-ish (SQLite open + mkdir),
// so callers should `await startRegistry(...)` during process startup before
// anything that could push or pull.
export async function startRegistry(opts: StartOptions): Promise<RegistryServer> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const store = await RegistryStore.open(dataDir);
  const app = createRegistryApp(store);
  const serveOpts = {
    fetch: app.fetch,
    // Pushes can take a long time (multi-GB layer streams), so don't let Bun's
    // default idle timeout terminate them mid-upload.
    idleTimeout: 0,
    // Bun caps request bodies at 128 MB by default. BuildKit happily sends
    // multi-GB layer blobs in a single PUT during finalize. Effectively
    // unbounded. The upstream client controls layer size, not us.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    error(err: Error) {
      console.error("[registry] server error:", err);
      return new Response("internal error", { status: 500 });
    },
  };

  const server = Bun.serve({
    ...serveOpts,
    port: opts.port,
    hostname: "127.0.0.1",
  });
  // With `port: 0` the OS assigns a free port, so the bound port is only
  // known after listen, so read it back from the server (never opts.port, which
  // would log a misleading ":0"). Bun types this as possibly-undefined; a
  // listening server always has it, but fail loudly rather than hand back a
  // bogus port that every downstream ref would be composed against.
  const boundPort = server.port;
  if (boundPort == null) {
    server.stop(true);
    store.close();
    throw new Error("registry server did not report a bound port");
  }
  console.log(`[registry] listening on 127.0.0.1:${boundPort} (data: ${dataDir})`);

  // The guest-facing listener (bridge IP, or 0.0.0.0 fallback). At most one.
  let guestServer: ReturnType<typeof Bun.serve> | null = null;

  return {
    port: boundPort,
    store,
    ensureNetworkListener(hostname: string) {
      if (hostname === "127.0.0.1" || hostname === "localhost") return;
      if (guestServer) return;
      try {
        guestServer = Bun.serve({ ...serveOpts, port: boundPort, hostname });
        console.log(`[registry] also listening on ${hostname}:${boundPort} (guest bridge)`);
      } catch (err) {
        console.warn(
          `[registry] could not bind guest listener on ${hostname}:${boundPort}; ` +
            `falling back to 0.0.0.0 (reachable on LAN):`,
          err,
        );
        try {
          guestServer = Bun.serve({
            ...serveOpts,
            port: boundPort,
            hostname: "0.0.0.0",
          });
          console.log(`[registry] also listening on 0.0.0.0:${boundPort} (fallback)`);
        } catch (err2) {
          console.error(`[registry] 0.0.0.0 fallback also failed:`, err2);
        }
      }
    },
    async stop() {
      server.stop(true);
      if (guestServer) {
        try {
          guestServer.stop(true);
        } catch {}
      }
      store.close();
    },
  };
}

// XDG data dir. Same root as packages/server uses for isolade.db so a single
// `~/.local/share/isolade/` houses all on-host state. Exported so other
// in-process consumers (e.g. the stats collector's `du` of the registry's
// blob storage) can derive the same path without hard-coding it.
export function defaultDataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "isolade", "registry");
}
