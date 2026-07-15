// Unified isolade entry point. Boots the API server and, unless an external
// sandbox is configured via ISOLADE_SANDBOX_URL, the sandbox runtime in the
// SAME process. There is no separate sandbox sidecar and no localhost:7778
// listener. The server drives the sandbox through in-process calls.
//
// The native-loading parts of @isolade/sandbox are never imported at module
// scope: when an external sandbox is configured the server must run even where
// the microsandbox SDK isn't installed, e.g. a dev container talking to a
// remote sandbox. They're pulled in lazily inside the in-process branch below.
// The only module-scope imports of the package elsewhere in the server are of
// `@isolade/sandbox/relay` (the shared, native-free relay primitives), and that
// subpath must stay free of microsandbox imports.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import { watchParentDeath } from "./parent-watchdog";
import type { SandboxApi } from "./sandbox-client";
import { InProcessSandboxClient } from "./sandbox-inprocess";
import { startUpdateChecks } from "./update-check";
import { stateDir } from "./xdg";

let sandbox: SandboxApi | undefined;
// Host unix socket where the in-process sandbox API is served for VMs that opt
// into `expose_sandbox` (isolade-within-isolade). Stays undefined when we talk
// to an external sandbox. There's no in-process runtime to serve.
let sandboxSocketPath: string | undefined;
if (!process.env.ISOLADE_SANDBOX_URL) {
  try {
    // Ordering matters: MSB_HOME (msb-home, a load-time side effect) and the
    // NAPI library path must be pinned BEFORE the runtime (which loads the
    // microsandbox SDK) is imported. All three are native-free except runtime.
    // Importing them lazily here keeps @isolade/sandbox off the external path.
    await import("@isolade/sandbox/msb-home");
    const { pinNapiLibraryPath } = await import("@isolade/sandbox/napi-path");
    pinNapiLibraryPath();
    const { createSandboxRuntime } = await import("@isolade/sandbox/runtime");
    const runtime = await createSandboxRuntime();
    sandbox = new InProcessSandboxClient(runtime);

    // Serve the sandbox API over a host unix socket (no TCP port) so opted-in
    // VMs can reach it via the reverse exec-stream forward (sandbox-forward.ts).
    // Backed by the SAME runtime objects the server drives in-process, so it's
    // one VM fleet, not two. Best-effort: a bind failure just means nested-dev
    // sandbox exposure is unavailable, not a broken server.
    try {
      const { serveSandboxOnUnix, sandboxAppDeps } = await import("@isolade/sandbox");
      mkdirSync(stateDir(), { recursive: true });
      const socketPath = join(stateDir(), "sandbox-host.sock");
      rmSync(socketPath, { force: true }); // stale socket from a prior run blocks bind
      serveSandboxOnUnix(socketPath, sandboxAppDeps(runtime));
      sandboxSocketPath = socketPath;
    } catch (err) {
      console.warn("[isolade] could not serve the sandbox unix socket:", err);
    }

    // Idempotent: a parent death and a signal can race, and runtime.shutdown()
    // (stopAll → per-VM sync + stop) must run exactly once.
    let shuttingDown = false;
    const shutdown = async (reason: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[isolade] ${reason}; shutting down sandbox`);
      await runtime.shutdown().catch(() => {});
      process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown("received SIGTERM"));
    process.once("SIGINT", () => void shutdown("received SIGINT"));
    // The launcher (the Tauri app, or a dev shell) can die without signalling
    // us: a SIGKILL/force-quit, a crash, or a terminal Ctrl-C that only hits
    // its own process group while we sit in ours. Watch for its death from
    // here so the sandbox VMs always come down *gracefully* (synced, not
    // abruptly torn off their creator), instead of the sidecar + VMs leaking
    // and colliding with the next launch.
    watchParentDeath({
      onParentDeath: () => void shutdown("launcher process exited"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      "[isolade] could not start the in-process sandbox runtime. The " +
        "microsandbox SDK failed to load.\n" +
        "  Build microsandbox alongside this checkout (see README) and re-run " +
        "`bun install`,\n" +
        "  or point isolade at an external sandbox by setting " +
        "ISOLADE_SANDBOX_URL.\n" +
        `  (loader: ${msg})`,
    );
    process.exit(1);
  }
}

const {
  app,
  websocket,
  workspaceCheckoutsCache,
  workspaceCachesCache,
  diffStatsPoller,
  prStatePoller,
} = createApp({ sandbox, sandboxSocketPath });
workspaceCheckoutsCache.start();
workspaceCachesCache.start();
diffStatsPoller.start();
prStatePoller.start();

// Loopback only. The desktop webview is the sole client. Tauri allocates a
// free port and passes it via ISOLADE_PORT (and injects it into the webview).
// `bun run` standalone falls back to 3000 (matched by the Vite dev proxy).
const port = Number(process.env.ISOLADE_PORT) || 3000;

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});

console.log(`[isolade] listening on 127.0.0.1:${port}`);

// The launch update check (and its once-a-day count) is the server's job. It
// must not depend on the webview mounting and hitting /api/update. Every server
// boot counts (dev builds under the "+dev" bucket); see update-check.ts for how
// the version resolves.
startUpdateChecks();
