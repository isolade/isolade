import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import { shellQuote } from "../shell";
import {
  ensureHostUploadDir,
  guestUploadDir,
  safeFilename,
  toUpload,
  uploadGuestPath,
  uploadHostPath,
} from "../uploads";
import type { RouteContext } from "./context";

// ---- Message file attachments (browser upload / clipboard paste) ----
//
// Two endpoints, both instance-scoped so the bytes belong to (and are served
// from) the one instance's VM:
//   POST .../uploads   stage a file's bytes, returns its metadata + id
//   GET  .../uploads/:uploadId   stream the bytes back (preview / download)
//
// Staging is decoupled from sending: the client uploads on file-select/paste so
// it can show a preview immediately, then references the returned ids in the
// send body (see chat-turn-service, which associates them with the message).
export function createUploadsRouter(ctx: RouteContext): Hono {
  const { instances, uploadStore, sandboxClient, archivedError } = ctx;
  const app = new Hono();

  // Stage an upload. The raw request body is the file bytes (streamed, never
  // fully buffered, so large files are fine); `filename` comes from the query
  // string and the MIME type from Content-Type. No size cap by design.
  //
  // The bytes go two places, both streamed: the host store (source of truth for
  // preview/download) and the instance's VM. We write into the VM by piping the
  // bytes into `cat`, which runs AS THE AGENT USER, so the files are agent-owned
  // (not root). That also sidesteps a bind mount, which can't cross the
  // nested-isolade boundary. So the VM must be up: wait out init.
  app.post("/api/instances/:id/uploads", async (c) => {
    const instanceId = c.req.param("id");
    let instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const rawName = c.req.query("filename")?.trim();
    if (!rawName) return c.json({ error: "filename is required" }, 400);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty upload" }, 400);
    const filename = safeFilename(rawName);
    const mediaType = c.req.header("content-type") ?? "application/octet-stream";

    // The bytes have to land in a running VM. A freshly spawned instance (the
    // new-chat flow uploads while the VM is still booting) may still be
    // initializing, so wait it out, then refuse if the environment failed.
    if (instance.status === "initializing") await instances.awaitInit(instanceId);
    instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.status === "error") {
      return c.json({ error: `environment initialization failed: ${instance.lastError}` }, 409);
    }

    // 1. Stream the request body to the host copy (the source of truth). This
    //    also acts as the on-disk buffer we read back to feed the VM, so a large
    //    file never sits fully in memory.
    const id = randomUUID();
    const hostPath = join(ensureHostUploadDir(instanceId, id), filename);
    // `as unknown as` bridges the DOM ReadableStream type (what the request body
    // is typed as) and Node's stream/web type that Readable.fromWeb expects.
    await pipeline(
      Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(hostPath),
    );
    const size = statSync(hostPath).size;
    if (size === 0) return c.json({ error: "empty upload" }, 400);

    // 2. Stream the host copy into the VM, piped into a shell (running as the
    //    agent user) that creates the agent-owned upload dir and writes the
    //    file. Paths are quoted; the dir is created with the file's own owner.
    const guestPath = uploadGuestPath(id, filename);
    const command = `mkdir -p ${shellQuote(guestUploadDir(id))} && cat > ${shellQuote(guestPath)}`;
    try {
      const { exitCode } = await sandboxClient.execStream(instance.vmId, command, {
        stdin: createReadStream(hostPath),
        stdout: () => {},
      });
      if (exitCode !== 0) {
        return c.json({ error: `failed to place upload in VM (exit ${exitCode})` }, 502);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `failed to place upload in VM: ${message}` }, 502);
    }

    return c.json(uploadStore.record({ id, instanceId, filename, mediaType, size }), 201);
  });

  // Serve an upload's bytes for preview (inline) or download (?download=1 →
  // attachment disposition). Scoped to the instance so one VM's ids can't read
  // another's files.
  app.get("/api/instances/:id/uploads/:uploadId", (c) => {
    const instanceId = c.req.param("id");
    if (!instances.get(instanceId)) return c.json({ error: "not found" }, 404);
    const row = uploadStore.get(c.req.param("uploadId"));
    if (!row || row.instanceId !== instanceId) return c.json({ error: "not found" }, 404);
    const hostPath = uploadHostPath(instanceId, row.id, row.filename);
    let size: number;
    try {
      size = statSync(hostPath).size;
    } catch {
      return c.json({ error: "upload bytes missing" }, 404);
    }
    const disposition = c.req.query("download") ? "attachment" : "inline";
    const meta = toUpload(row);
    // Stream the file rather than reading it fully into memory, so large
    // downloads stay cheap. Readable.toWeb yields a standard ReadableStream that
    // the Response body accepts.
    const stream = Readable.toWeb(
      createReadStream(hostPath),
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": meta.mediaType,
        "Content-Length": String(size),
        // Quote the filename so spaces/specials in the name don't break the header.
        "Content-Disposition": `${disposition}; filename="${meta.filename.replace(/"/g, "")}"`,
      },
    });
  });

  return app;
}
