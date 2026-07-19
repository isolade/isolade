// First import: pins MSB_HOME/MSB_PATH (isolated microsandbox layout) as a side
// effect, before vms/builder/stats or the microsandbox SDK are evaluated.
import "./msb-home";
import { PushQueue } from "@isolade/shared";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { createSandboxRuntime, type SandboxRuntime } from "./runtime";
import type { VmManager } from "./vms";

const SANDBOX_PORT = Number(process.env.SANDBOX_PORT) || 7778;

type SandboxVmManager = Pick<
  VmManager,
  | "create"
  | "remove"
  | "removeAll"
  | "stop"
  | "stopAll"
  | "restart"
  | "ensure"
  | "exec"
  | "writeFile"
  | "execStream"
  | "execInteractive"
  | "listVmHandles"
>;

// Both runners require the caller's client identity (see clients.ts). There
// is deliberately no "host" default anywhere on this path: an identity-less
// request is refused at the route, never treated as the host's.
type RunBuild = (tarStream: ReadableStream, clientId: string) => AsyncGenerator<string, string>;

type RunRegistryGc = (
  keep: string[],
  clientId: string,
  log?: (line: string) => void,
) => Promise<void>;

// What the HTTP veneer needs from whoever owns the runtime objects. In
// production this is always sandboxAppDeps(runtime). Tests pass a fake
// vmManager and only the runners the test exercises (a missing runner
// answers 501 rather than constructing real machinery).
export interface SandboxAppDeps {
  vmManager: SandboxVmManager;
  runBuild?: RunBuild;
  runRegistryGc?: RunRegistryGc;
  getStats?: () => Promise<unknown>;
  /** Replace a client's retention keep-set (no sweep). See clients.ts. */
  registerKeepSet?: (clientId: string, keep: string[]) => Promise<void>;
  /** Every client id known to the registry (see clients.ts). */
  listClients?: () => Promise<string[]>;
  /** Remove a nested client: destroy its VMs, drop its keep-set, sweep. */
  removeClient?: (clientId: string) => Promise<void>;
}

/** The full dep set for a live runtime: the one production wiring. */
export function sandboxAppDeps(runtime: SandboxRuntime): SandboxAppDeps {
  return {
    vmManager: runtime.vmManager,
    runBuild: (tarStream, clientId) => runtime.builder.runBuild(tarStream, clientId),
    runRegistryGc: (keep, clientId, log) => runtime.builder.runRegistryGc(keep, clientId, log),
    getStats: runtime.getStats,
    registerKeepSet: runtime.registerKeepSet,
    listClients: runtime.listClients,
    removeClient: runtime.removeClient,
  };
}

// The sandbox HTTP app: a pure transport veneer (JSON/WS/SSE) over the
// runtime objects handed in via deps. It owns no lifecycle. Construct the
// runtime with createSandboxRuntime() and shut it down there.
export function createSandboxApp(deps: SandboxAppDeps) {
  const { vmManager } = deps;
  const notWired = (what: string) => new Error(`${what} is not wired into this sandbox app`);
  const buildRunner: RunBuild =
    deps.runBuild ??
    // eslint-disable-next-line require-yield
    async function* () {
      throw notWired("build");
    };
  const gcRunner: RunRegistryGc =
    deps.runRegistryGc ?? (() => Promise.reject(notWired("registry gc")));

  const app = new Hono();

  // VMs

  app.post("/vms", async (c) => {
    const opts = await c.req.json();
    // Identity is mandatory: a VM created without a client id could never be
    // attributed for ownership/cascade bookkeeping (see clients.ts), and a
    // silent "host" default would let a caller predating the client registry
    // masquerade as the host. Refuse instead.
    if (typeof opts?.clientId !== "string" || opts.clientId.length === 0) {
      return c.json({ error: "clientId required" }, 400);
    }
    try {
      const { vmId, ports } = await vmManager.create(opts);
      return c.json({ id: vmId, ports }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.delete("/vms/:id", async (c) => {
    const vmId = c.req.param("id");
    try {
      await vmManager.remove(vmId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Stop the named VM (if running) and re-start it from its persisted
  // microsandbox record. Returns the fresh PortBinding[] so the caller can
  // repopulate its port-forward map. The isolade-side vmId stays stable.
  // User-facing "Restart VM" action. For the server's boot-time resync,
  // use /ensure instead. It skips the stop/start cycle when the VM is
  // already alive in this process's in-memory map.
  app.post("/vms/:id/restart", async (c) => {
    const vmId = c.req.param("id");
    try {
      const ports = await vmManager.restart(vmId);
      return c.json({ id: vmId, ports });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Stop the named VM without removing its persisted microsandbox record, so a
  // later /ensure or /restart can resume it. Used when a chat is archived: the
  // guest stops consuming CPU/RAM but its rootfs survives for unarchive.
  app.post("/vms/:id/stop", async (c) => {
    const vmId = c.req.param("id");
    try {
      await vmManager.stop(vmId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Re-attach to the named VM without a forced restart. If the VM is
  // already in vmManager.vms (sandbox-service didn't reload), just returns
  // current port bindings. Otherwise calls Sandbox.start to resume from
  // the persisted record. Used by the isolade server's boot-time resync
  // to avoid stop/start-cycling every VM every time the server reloads.
  app.post("/vms/:id/ensure", async (c) => {
    const vmId = c.req.param("id");
    try {
      const ports = await vmManager.ensure(vmId);
      return c.json({ id: vmId, ports });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post("/vms/:id/exec", async (c) => {
    const vmId = c.req.param("id");
    const { command, workingDir, timeoutMs } = await c.req.json();
    try {
      const result = await vmManager.exec(vmId, command, {
        workingDir,
        timeoutMs,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post("/vms/:id/write", async (c) => {
    const vmId = c.req.param("id");
    const { path, content } = await c.req.json();
    try {
      await vmManager.writeFile(vmId, path, Buffer.from(content, "base64"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get(
    "/vms/:id/exec-stream",
    upgradeWebSocket((c) => {
      const vmId = c.req.param("id")!;
      const command = decodeURIComponent(c.req.query("command") || "");

      const stdin = new PushQueue<Buffer>();
      // Fires when the WS closes (browser/server-side cancel). Plumbed into
      // vmManager.execStream so the underlying subprocess gets killed
      // instead of running to completion after the client has gone away.
      const abort = new AbortController();

      return {
        onOpen(_evt, ws) {
          vmManager
            .execStream(vmId, command, {
              stdin,
              signal: abort.signal,
              stdout(chunk: Buffer) {
                try {
                  ws.send(Uint8Array.from(chunk));
                } catch {}
              },
              stderr(chunk: Buffer) {
                try {
                  ws.send(
                    JSON.stringify({
                      type: "stderr",
                      data: chunk.toString("utf8"),
                    }),
                  );
                } catch {}
              },
            })
            .then(({ exitCode }) => {
              try {
                ws.send(JSON.stringify({ type: "exit", exitCode }));
                ws.close(1000, "command exited");
              } catch {}
            })
            .catch((err) => {
              try {
                ws.send(JSON.stringify({ type: "error", message: String(err) }));
                ws.close(1011, "exec error");
              } catch {}
            });
        },

        onMessage(evt) {
          const data = evt.data;
          if (typeof data === "string") {
            try {
              const msg = JSON.parse(data);
              if (msg.type === "stdin_eof") {
                stdin.end();
                return;
              }
            } catch {}
            stdin.push(Buffer.from(data));
          } else if (data instanceof ArrayBuffer) {
            stdin.push(Buffer.from(data));
          } else if (data instanceof Uint8Array) {
            stdin.push(Buffer.from(data));
          }
        },

        onClose() {
          stdin.end();
          abort.abort();
        },
      };
    }),
  );

  app.get(
    "/vms/:id/pty",
    upgradeWebSocket((c) => {
      const vmId = c.req.param("id")!;
      const shell = decodeURIComponent(c.req.query("shell") || "/bin/sh");
      const rows = Number(c.req.query("rows")) || 24;
      const cols = Number(c.req.query("cols")) || 80;

      const stdin = new PushQueue<Buffer>();
      const resize = new PushQueue<[number, number]>();

      return {
        onOpen(_evt, ws) {
          vmManager
            .execInteractive(vmId, shell, {
              stdin,
              stdout(chunk: Buffer) {
                try {
                  ws.send(Uint8Array.from(chunk));
                } catch {}
              },
              rows,
              cols,
              resize,
            })
            .then(() => {
              try {
                ws.close(1000, "shell exited");
              } catch {}
            })
            .catch((err: unknown) => {
              console.error(`[pty ${vmId}] interactive session failed:`, err);
              // WS close reasons cap at 123 bytes, so keep the identifying prefix.
              const reason = `terminal error: ${
                err instanceof Error ? err.message : String(err)
              }`.slice(0, 120);
              try {
                ws.close(1011, reason);
              } catch {}
            });
        },

        onMessage(evt) {
          const data = evt.data;
          if (typeof data === "string") {
            try {
              const msg = JSON.parse(data);
              if (msg.type === "resize" && msg.rows && msg.cols) {
                resize.push([msg.rows, msg.cols]);
                return;
              }
            } catch {}
            stdin.push(Buffer.from(data));
          } else if (data instanceof ArrayBuffer) {
            stdin.push(Buffer.from(data));
          } else if (data instanceof Uint8Array) {
            stdin.push(Buffer.from(data));
          }
        },

        onClose() {
          stdin.end();
          resize.end();
        },
      };
    }),
  );

  // Builds

  app.post("/builds", async (c) => {
    const tarStream = c.req.raw.body;
    if (!tarStream) return c.json({ error: "request body required" }, 400);
    // The body is the raw context tar, so the client identity rides a query
    // param rather than a JSON field. Required — an identity-less build has
    // no keep-set to protect its ref, so it is refused, never defaulted to
    // the host.
    const clientId = c.req.query("client");
    if (!clientId) return c.json({ error: "client query parameter required" }, 400);

    return streamSSE(c, async (stream) => {
      try {
        const gen = buildRunner(tarStream, clientId);
        while (true) {
          const result = await gen.next();
          if (result.done) {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ imageId: result.value }),
            });
            break;
          }
          await stream.writeSSE({ event: "log", data: result.value });
        }
      } catch (err) {
        console.error("[builds] error:", err);
        await stream.writeSSE({ event: "error", data: String(err) }).catch(() => {});
      }
    });
  });

  app.get("/stats", async (c) => {
    if (!deps.getStats) return c.json({ error: "stats are not wired into this sandbox app" }, 501);
    try {
      return c.json(await deps.getStats());
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post("/registry/gc", async (c) => {
    let body: { keep?: unknown; clientId?: unknown };
    try {
      body = (await c.req.json()) as { keep?: unknown; clientId?: unknown };
    } catch (err) {
      console.warn("[sandbox] /registry/gc: failed to parse body:", err);
      return c.json({ error: `invalid JSON body: ${String(err)}` }, 400);
    }
    if (!Array.isArray(body.keep) || !body.keep.every((x) => typeof x === "string")) {
      console.warn("[sandbox] /registry/gc: rejecting body", JSON.stringify(body));
      return c.json({ error: "keep must be a string[]" }, 400);
    }
    // Required: a GC registers the caller's keep-set before sweeping, so an
    // identity-less request has nothing valid to register — and defaulting it
    // to the host would let it shrink the host's keep-set. Refuse instead.
    if (typeof body.clientId !== "string" || body.clientId.length === 0) {
      return c.json({ error: "clientId required" }, 400);
    }
    const clientId = body.clientId;
    return streamSSE(c, async (stream) => {
      try {
        await gcRunner(body.keep as string[], clientId, (line) => {
          void stream.writeSSE({ event: "log", data: line }).catch(() => {});
        });
        await stream.writeSSE({ event: "done", data: "" });
      } catch (err) {
        console.warn(`[sandbox] registry gc failed:`, err);
        await stream.writeSSE({ event: "error", data: String(err) }).catch(() => {});
      }
    });
  });

  // Clients (nested isolade servers driving this sandbox, see clients.ts).

  // Every client id the registry knows. The host server reconciles this
  // against its instances table at boot and retries removals a crash or a
  // failed cascade left behind.
  app.get("/clients", async (c) => {
    if (!deps.listClients) {
      return c.json({ error: notWired("client registry").message }, 501);
    }
    try {
      return c.json({ clients: await deps.listClients() });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Replace a client's retention keep-set without sweeping. The host server
  // uses this at dev-VM create to pre-protect the image refs it seeds into the
  // nested instance, closing the window before that instance's first own GC.
  app.put("/clients/:id/keep", async (c) => {
    if (!deps.registerKeepSet) {
      return c.json({ error: notWired("client registry").message }, 501);
    }
    const clientId = c.req.param("id");
    let body: { keep?: unknown };
    try {
      body = (await c.req.json()) as { keep?: unknown };
    } catch (err) {
      return c.json({ error: `invalid JSON body: ${String(err)}` }, 400);
    }
    if (!Array.isArray(body.keep) || !body.keep.every((x) => typeof x === "string")) {
      return c.json({ error: "keep must be a string[]" }, 400);
    }
    try {
      await deps.registerKeepSet(clientId, body.keep as string[]);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Remove a client: destroy the VMs it created, drop its keep-set, and sweep
  // the image caches against the remaining union. Called by the host server
  // when an `expose_sandbox` instance is deleted.
  app.delete("/clients/:id", async (c) => {
    if (!deps.removeClient) {
      return c.json({ error: notWired("client registry").message }, 501);
    }
    const clientId = c.req.param("id");
    try {
      await deps.removeClient(clientId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}

// Production boot for the STANDALONE sandbox service (external-sandbox dev
// mode, `bun run --cwd packages/sandbox dev`). Invoked from src/main.ts after
// the microsandbox-availability probe. Tests import createSandboxApp directly
// and never call this. The runtime (VmManager, builder, registry, samplers)
// is the same one the in-process mode drives. Only the transport differs.
export async function startSandboxServer() {
  const runtime = await createSandboxRuntime();
  const app = createSandboxApp(sandboxAppDeps(runtime));

  const onExit = async (signal: string) => {
    console.log(`[sandbox] received ${signal}, shutting down`);
    await runtime.shutdown().catch((err) => {
      console.warn("[sandbox] shutdown failed:", err);
    });
    process.exit(0);
  };
  process.once("SIGTERM", () => void onExit("SIGTERM"));
  process.once("SIGINT", () => void onExit("SIGINT"));

  return {
    port: SANDBOX_PORT,
    hostname: "0.0.0.0",
    fetch: app.fetch,
    websocket,
    idleTimeout: 0,
  };
}

// Serve the sandbox HTTP API over a host UNIX SOCKET (no TCP port), backed by an
// already-running in-process runtime's objects: the SAME VmManager/builder the
// isolade server drives directly. This is the host end of the "expose the
// sandbox into a VM" path: a nested isolade dev instance reaches this socket
// over a per-connection exec-stream relay (see packages/server/src/sandbox-forward.ts),
// so the powerful sandbox API is never bound to any routable interface and needs
// no network-policy egress rule. The app is the same one startSandboxServer
// exposes, veneering the same runtime.
export function serveSandboxOnUnix(socketPath: string, deps: SandboxAppDeps) {
  const app = createSandboxApp(deps);
  // No server-level idleTimeout here (Bun doesn't accept one on a unix socket).
  // The long-lived cases (an exec-stream WS quiet during a long agent turn,
  // build-log SSE) ride the same `websocket` handler the TCP server uses, so
  // their liveness behavior matches the already-shipping port-served path.
  return Bun.serve({
    unix: socketPath,
    fetch: app.fetch,
    websocket,
  });
}
