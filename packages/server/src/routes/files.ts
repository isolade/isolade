import { type Context, Hono } from "hono";
import {
  createPortForwardBodySchema,
  filePathBodySchema,
  renameFileBodySchema,
  uploadFileBodySchema,
  WORKSPACE_ROOT,
} from "../contracts";
import { FileError, MAX_CONTEXT_LINES, MAX_UPLOAD_BYTES } from "../files";
import type { RouteContext } from "./context";

// ---- Workspace file tree, review diff, and runtime port forwards (right panel)
// Every route resolves the instance, guards against archived VMs, then delegates
// to WorkspaceFiles / WorkspaceDiffReader (paths confined to /workspace) or the
// instance manager's port-forward controls.
export function createFilesRouter(ctx: RouteContext): Hono {
  const { instances, workspaceFiles, workspaceDiff, archivedError } = ctx;
  const app = new Hono();

  // A FileError carries its own status (404 for not-a-dir, 409 for clobber, 400
  // for an escaping path). Anything else is 500.
  const fileError = (c: Context, err: unknown) => {
    if (err instanceof FileError) return c.json({ error: err.message }, err.status as 400);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  };

  app.get("/api/instances/:id/files", async (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const dir = c.req.query("path") || WORKSPACE_ROOT;
    try {
      return c.json(await workspaceFiles.list(instance.vmId, dir));
    } catch (err) {
      return fileError(c, err);
    }
  });

  // ---- Workspace review diff (right panel) ----
  // PR-style diff of the instance's /workspace against its base branch, parsed
  // into per-file hunks for the Review tab.
  app.get("/api/instances/:id/diff", async (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    try {
      return c.json(await workspaceDiff.get(instance.vmId));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Read a line range from a workspace file, backing the Review tab's
  // expand-context controls. Path is confined to /workspace by WorkspaceFiles,
  // and the range is bounded here so a crafted request can't stream a whole file.
  app.get("/api/instances/:id/file-lines", async (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const filePath = c.req.query("path");
    const start = Number(c.req.query("start"));
    const end = Number(c.req.query("end"));
    if (
      !filePath ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start
    ) {
      return c.json({ error: "invalid range" }, 400);
    }
    if (end - start + 1 > MAX_CONTEXT_LINES) {
      return c.json({ error: `range exceeds ${MAX_CONTEXT_LINES} lines` }, 400);
    }
    try {
      return c.json(await workspaceFiles.readLines(instance.vmId, filePath, start, end));
    } catch (err) {
      return fileError(c, err);
    }
  });

  app.post("/api/instances/:id/files/delete", async (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const { path } = filePathBodySchema.parse(await c.req.json());
    try {
      await workspaceFiles.remove(instance.vmId, path);
      return c.json({ ok: true });
    } catch (err) {
      return fileError(c, err);
    }
  });

  app.post("/api/instances/:id/files/rename", async (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const { from, to } = renameFileBodySchema.parse(await c.req.json());
    try {
      await workspaceFiles.rename(instance.vmId, from, to);
      return c.json({ ok: true });
    } catch (err) {
      return fileError(c, err);
    }
  });

  app.post("/api/instances/:id/files/mkdir", async (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const { path } = filePathBodySchema.parse(await c.req.json());
    try {
      await workspaceFiles.mkdir(instance.vmId, path);
      return c.json({ ok: true });
    } catch (err) {
      return fileError(c, err);
    }
  });

  app.post("/api/instances/:id/files/create", async (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const { path } = filePathBodySchema.parse(await c.req.json());
    try {
      await workspaceFiles.createFile(instance.vmId, path);
      return c.json({ ok: true });
    } catch (err) {
      return fileError(c, err);
    }
  });

  app.post("/api/instances/:id/files/upload", async (c) => {
    const instance = instances.get(c.req.param("id"));
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const { path, content } = uploadFileBodySchema.parse(await c.req.json());
    const bytes = Buffer.from(content, "base64");
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return c.json(
        {
          error: `file exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB upload limit`,
        },
        413,
      );
    }
    try {
      await workspaceFiles.upload(instance.vmId, path, bytes);
      return c.json({ ok: true });
    } catch (err) {
      return fileError(c, err);
    }
  });

  app.get("/api/instances/:id/ports", (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    return c.json(instances.listPortForwards(id));
  });

  // Open a runtime forward for a guest port (idempotent). Returns the binding,
  // including the host loopback port the server picked.
  app.post("/api/instances/:id/ports", async (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const { remotePort, hostPort } = createPortForwardBodySchema.parse(await c.req.json());
    try {
      return c.json(await instances.addForward(id, remotePort, hostPort), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Close a runtime forward. Config-declared ports reopen on the next restart.
  app.delete("/api/instances/:id/ports/:remotePort", (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    const remotePort = Number(c.req.param("remotePort"));
    if (!Number.isInteger(remotePort)) return c.json({ error: "invalid port" }, 400);
    instances.removeForward(id, remotePort);
    return c.json({ ok: true });
  });

  // Live listener probe for the port panel: forwarded-port statuses + guest
  // ports that are listening but not yet forwarded (one-click candidates).
  app.get("/api/instances/:id/port-status", async (c) => {
    const id = c.req.param("id");
    const instance = instances.get(id);
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    try {
      return c.json(await instances.probePorts(id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
