import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import {
  createInstanceBodySchema,
  execInstanceBodySchema,
  prRefBodySchema,
  terminalResizeMessageSchema,
  updateInstanceBodySchema,
} from "../contracts";
import { terminalCommand } from "../terminals";
import type { RouteContext } from "./context";

// ---- Instances (chats' VMs) + their terminal PTY tabs ----
export function createInstancesRouter(ctx: RouteContext): Hono {
  const {
    instances,
    terminalManager,
    sessionManager,
    chatManager,
    chatStreamHub,
    codexManager,
    realClaudeBackend,
    sandboxClient,
    prAttachments,
    archivedError,
  } = ctx;
  const app = new Hono();

  // Drop every server-side handle bound to an instance's current VM boot:
  // in-memory terminal PTY sessions, in-flight chat streams, and the persistent
  // codex/claude processes living inside the VM. Leaves the terminal/chat DB
  // rows intact. Archive keeps them so unarchive restores the tabs. hardRemove
  // deletes them explicitly. Shared by archive (VM about to stop) and delete /
  // clear-archive (VM about to be destroyed).
  const teardownVmSessions = (instance: { id: string; vmId: string }) => {
    for (const terminal of terminalManager.list(instance.id)) {
      sessionManager.close(terminal.id);
    }
    for (const chat of chatManager.list(instance.id)) chatStreamHub.cancelForChat(chat.id);
    codexManager.close(instance.vmId);
    realClaudeBackend.disposeForVm(instance.vmId);
  };

  // Permanently delete an instance: tear down its sessions, drop its terminal
  // and chat rows, then destroy the VM and delete the instance row. Used by the
  // single-instance DELETE and by clear-archive.
  const hardRemove = async (instance: { id: string; vmId: string }) => {
    teardownVmSessions(instance);
    terminalManager.removeForInstance(instance.id);
    chatManager.removeForInstance(instance.id);
    await instances.remove(instance.id);
  };

  app.post("/api/instances", async (c) => {
    const { profile } = createInstanceBodySchema.parse(await c.req.json());
    try {
      const instance = await instances.create({ profileId: profile });
      return c.json(instance, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/instances", (c) => {
    return c.json(instances.list());
  });

  app.get("/api/instances/:id", (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    return c.json(instance);
  });

  app.patch("/api/instances/:id", async (c) => {
    const id = c.req.param("id");
    if (!instances.get(id)) return c.json({ error: "not found" }, 404);
    const { title } = updateInstanceBodySchema.parse(await c.req.json());
    const updated = instances.setTitle(id, title);
    return c.json(updated);
  });

  // Mark an instance read. The user is viewing it, so clear the unread flag.
  // Idempotent and tolerant of unknown ids (the client fires this optimistically
  // and a since-deleted instance is a no-op, not an error).
  app.post("/api/instances/:id/read", (c) => {
    instances.markRead(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Pull requests attached to a chat (via the in-VM `isolade pr` CLI, or these
  // endpoints). The badge in the title bar reads them off the instance list, so
  // these are for the UI's explicit list/detach affordances.
  app.get("/api/instances/:id/prs", (c) => {
    const id = c.req.param("id");
    if (!instances.get(id)) return c.json({ error: "not found" }, 404);
    return c.json(prAttachments.listFor(id));
  });

  app.delete("/api/instances/:id/prs", async (c) => {
    const id = c.req.param("id");
    if (!instances.get(id)) return c.json({ error: "not found" }, 404);
    const ref = prRefBodySchema.parse(await c.req.json());
    prAttachments.detach(id, ref);
    return c.json({ ok: true });
  });

  app.delete("/api/instances/:id", async (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    await hardRemove(instance);
    return c.json({ ok: true });
  });

  // Clear the archive: permanently delete every archived chat of ONE profile,
  // named explicitly via `?profile=<id>`. The scope is mandatory. A missing
  // param is refused rather than treated as "all profiles", so no caller can
  // wipe another profile's archive by accident (the sidebar's archive is
  // profile-scoped, and this is an irreversible bulk delete). Registered
  // before the `:id`-parameterised archive routes below. Its 3-segment shape
  // (`instances/archive/clear`) can't collide with `instances/:id/<action>`.
  app.post("/api/instances/archive/clear", async (c) => {
    const profile = c.req.query("profile");
    if (!profile) return c.json({ error: "profile query parameter is required" }, 400);
    const archived = instances.listArchived(profile);
    for (const instance of archived) {
      await hardRemove(instance);
    }
    return c.json({ ok: true, cleared: archived.length });
  });

  // Archive a chat: stop its VM (kept on disk for a later unarchive) and hide
  // it from the main sidebar list. Tear down the VM-bound sessions first, same
  // as delete. The difference is the VM is stopped, not destroyed, and the
  // terminal/chat rows survive.
  app.post("/api/instances/:id/archive", async (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    teardownVmSessions(instance);
    const updated = await instances.archive(id);
    return c.json(updated);
  });

  // Unarchive a chat: clear the flag and boot its VM back up. The VM's previous
  // boot is long gone (stopped at archive time), so there are no live sessions
  // to tear down. unarchive() just resumes the VM via restart().
  app.post("/api/instances/:id/unarchive", async (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    try {
      const updated = await instances.unarchive(id);
      return c.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Pin / unpin a chat: toggle the flag that lifts it into the sidebar's
  // "Pinned" section. No VM lifecycle here (a pinned chat keeps running like any
  // other), so unlike archive/unarchive this is a plain flag flip.
  app.post("/api/instances/:id/pin", (c) => {
    const id = c.req.param("id");
    if (!instances.get(id)) return c.json({ error: "not found" }, 404);
    return c.json(instances.setPinned(id, true));
  });

  app.post("/api/instances/:id/unpin", (c) => {
    const id = c.req.param("id");
    if (!instances.get(id)) return c.json({ error: "not found" }, 404);
    return c.json(instances.setPinned(id, false));
  });

  app.post("/api/instances/:id/restart", async (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    // Restarting an archived instance would boot its VM while the archived
    // flag still claims it's stopped. unarchive is the sanctioned boot path.
    if (instance.archived) return archivedError(c);
    // Tear down server-side state bound to the *previous* VM boot before
    // restarting. Persistent terminal sessions hold a long-lived
    // execInteractive WS to the sandbox. Once we stop the VM the
    // proxied WS dies, but the session entry lingers long enough that
    // a fresh client reconnect would attach to it (and immediately get
    // closed). codex-manager holds a similar long-lived handle. The
    // DB rows for terminals/chats stay. Only the in-memory sessions
    // get cleared, so the UI reconnects cleanly against the new boot.
    for (const terminal of terminalManager.list(id)) {
      sessionManager.close(terminal.id);
    }
    codexManager.close(instance.vmId);
    // The persistent `claude` processes live inside the VM we're about to
    // stop, so drop their handles so the next turn starts fresh against the new
    // boot (and resumes the conversation via --resume).
    realClaudeBackend.disposeForVm(instance.vmId);
    try {
      const updated = await instances.restart(id);
      return c.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/instances/:id/exec", async (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const { command, workingDir, timeoutMs } = execInstanceBodySchema.parse(await c.req.json());
    try {
      const result = await sandboxClient.exec(instance.vmId, command, {
        workingDir,
        timeoutMs,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Terminals: the per-instance shell PTY shown in the side panel.
  app.post("/api/instances/:id/terminals", (c) => {
    const instanceId = c.req.param("id");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);

    const terminal = terminalManager.create(instanceId);
    return c.json(terminal, 201);
  });

  app.get("/api/instances/:id/terminals", (c) => {
    const instanceId = c.req.param("id");
    if (!instances.get(instanceId)) return c.json({ error: "not found" }, 404);
    return c.json(terminalManager.list(instanceId));
  });

  app.delete("/api/instances/:id/terminals/:terminalId", (c) => {
    const terminalId = c.req.param("terminalId");
    if (!terminalManager.get(terminalId)) return c.json({ error: "not found" }, 404);
    sessionManager.close(terminalId);
    terminalManager.remove(terminalId);
    return c.json({ ok: true });
  });

  app.get("/api/terminals", (c) => {
    return c.json(terminalManager.listAll());
  });

  app.get(
    "/api/instances/:id/terminals/:terminalId/socket",
    upgradeWebSocket((c) => {
      const instanceId = c.req.param("id");
      const terminalId = c.req.param("terminalId");
      const rows = Number(c.req.query("rows")) || 24;
      const cols = Number(c.req.query("cols")) || 80;
      let currentWs: import("hono/ws").WSContext | null = null;

      return {
        onOpen(_event, ws) {
          if (!instanceId || !terminalId) {
            ws.close(1008, "missing identifiers");
            return;
          }
          const instance = instances.get(instanceId);
          if (!instance) {
            ws.close(1008, "instance not found");
            return;
          }
          const terminal = terminalManager.get(terminalId);
          if (!terminal) {
            ws.close(1008, "terminal not found");
            return;
          }
          // A PTY start against a stopped VM would boot it (see archivedError).
          if (instance.archived) {
            ws.close(1008, "instance is archived");
            return;
          }
          currentWs = ws;
          if (!sessionManager.has(terminalId)) {
            sessionManager.start(terminalId, instance.vmId, terminalCommand(), {
              rows,
              cols,
            });
          }
          sessionManager.attach(terminalId, ws);
        },
        onMessage(event, _ws) {
          if (!terminalId) return;
          const data = event.data;
          if (typeof data === "string") {
            // Text frames are either a structured resize message (JSON
            // matching the schema) or plain typed input. We optimistically
            // try the resize parse. Anything that doesn't match falls
            // through to input, by design, not an error.
            try {
              const msg = terminalResizeMessageSchema.parse(JSON.parse(data));
              if (msg.type === "resize") {
                sessionManager.sendResize(terminalId, msg.rows, msg.cols);
                return;
              }
            } catch {}
            sessionManager.sendInput(terminalId, Buffer.from(data));
          } else if (data instanceof ArrayBuffer) {
            sessionManager.sendInput(terminalId, Buffer.from(data));
          } else if (data instanceof Uint8Array) {
            sessionManager.sendInput(terminalId, Buffer.from(data));
          }
        },
        onClose() {
          if (currentWs && terminalId) {
            sessionManager.detach(terminalId, currentWs);
            currentWs = null;
          }
        },
      };
    }),
  );

  return app;
}
