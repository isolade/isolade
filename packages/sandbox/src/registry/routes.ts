import { type Context, Hono } from "hono";
import { DigestMismatchError, RegistryStore } from "./store";

// Hono regex `:name{.+}` is greedy. For `/v2/foo/manifests/bar`, name matches
// `foo` (regex backtracks). Repo names containing the literal `/manifests/`,
// `/blobs/`, or `/tags/` segments would resolve ambiguously, but the OCI repo
// grammar forbids those segment names in practice and Isolade's refs are all
// `isolade/<uid>` / `isolade-base/<uid>`. We don't validate.
const NAME = ":name{.+}";

// Plain HTTP, no auth, no TLS. Local-only registry behind the host bridge IP.
// BuildKit (inside the build VM) and microsandbox (inside workspace VMs) reach
// it via that bridge address. The sandbox process listens on 0.0.0.0:<port>.
export function createRegistryApp(store: RegistryStore): Hono {
  const app = new Hono();

  // Spec ping. Any 200 here satisfies the v2 protocol probe. An empty body is
  // fine, clients only look at status code.
  app.on(["GET", "HEAD"], "/v2/", (c) => c.body(null, 200));
  app.on(["GET", "HEAD"], "/v2", (c) => c.body(null, 200));

  // ── Manifests ────────────────────────────────────────────────────────

  app.on(["GET", "HEAD"], `/v2/${NAME}/manifests/:ref`, (c) => {
    const name = c.req.param("name");
    const ref = c.req.param("ref");
    const m = store.getManifestByRef(name, ref);
    if (!m) return errorResponse(c, 404, "MANIFEST_UNKNOWN", `${name}:${ref}`);
    c.header("Docker-Content-Digest", m.digest);
    c.header("Content-Type", m.mediaType);
    c.header("Content-Length", String(m.size));
    c.header("ETag", `"${m.digest}"`);
    if (c.req.method === "HEAD") return c.body(null, 200);
    return c.body(new Uint8Array(m.body), 200);
  });

  app.put(`/v2/${NAME}/manifests/:ref`, async (c) => {
    const name = c.req.param("name");
    const ref = c.req.param("ref");
    const mediaType = c.req.header("content-type") || "application/vnd.oci.image.manifest.v1+json";
    const body = Buffer.from(await c.req.arrayBuffer());
    const { digest } = store.putManifest(name, ref, mediaType, body);
    // If the client PUT by digest, sanity-check the body hashes to the same
    // value. Mismatches are a hard error in the spec.
    if (ref.startsWith("sha256:") && ref !== digest) {
      // Roll back: the row got inserted under the actual hash, so deleting by
      // that digest cleans state. The caller's digest is meaningless to us.
      await store.deleteManifest(digest).catch(() => {});
      return errorResponse(c, 400, "DIGEST_INVALID", `body hashes to ${digest}, not ${ref}`);
    }
    c.header("Docker-Content-Digest", digest);
    c.header("Location", `/v2/${name}/manifests/${digest}`);
    return c.body(null, 201);
  });

  app.delete(`/v2/${NAME}/manifests/:digest`, async (c) => {
    const name = c.req.param("name");
    const ref = c.req.param("digest");
    // Spec says DELETE only by digest, but Isolade's existing GC code in
    // builds.ts does a HEAD→DELETE-by-digest dance so this is what we get.
    const digest = ref.startsWith("sha256:")
      ? ref
      : (() => {
          // Permit DELETE-by-tag for symmetry, resolving to the underlying digest.
          // (Removes the tag implicitly via the cascade in deleteManifest.)
          const d = store.resolveTagDigest(name, ref);
          return d;
        })();
    if (!digest) return errorResponse(c, 404, "MANIFEST_UNKNOWN", `${name}:${ref}`);
    const exists = store.getManifestByDigest(digest);
    if (!exists) return errorResponse(c, 404, "MANIFEST_UNKNOWN", digest);
    await store.deleteManifest(digest);
    return c.body(null, 202);
  });

  // ── Blobs ────────────────────────────────────────────────────────────

  app.on(["GET", "HEAD"], `/v2/${NAME}/blobs/:digest`, async (c) => {
    const digest = c.req.param("digest");
    const meta = store.blobStat(digest);
    if (!meta) return errorResponse(c, 404, "BLOB_UNKNOWN", digest);
    const headers = {
      "Docker-Content-Digest": digest,
      "Content-Length": String(meta.size),
      "Content-Type": "application/octet-stream",
    };
    if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
    // Hand the BunFile straight to Response. Bun's HTTP server has a native
    // sendfile-style fast path for this that bypasses JS-land per-chunk hops.
    // The blob index claimed it exists. If the file was unlinked out from under
    // us the stream errors mid-flight (acceptable, since it shouldn't happen in
    // normal operation, and a torn pull is what the client would see anyway).
    const file = Bun.file(store.blobPath(digest));
    return new Response(file, { status: 200, headers });
  });

  app.delete(`/v2/${NAME}/blobs/:digest`, async (c) => {
    // The spec exposes blob delete but Isolade never calls it directly, because
    // manifest deletes cascade. Implemented for completeness. It will only
    // succeed when no manifest still references the blob.
    const digest = c.req.param("digest");
    if (!store.blobExists(digest)) {
      return errorResponse(c, 404, "BLOB_UNKNOWN", digest);
    }
    // No cascade here. If something references it, the orphan check fails.
    // We'd need to expose this on the store. Trivial follow-up if anyone needs
    // it. For now return 405. The GC path is "delete the manifest, blobs go
    // with it."
    return errorResponse(c, 405, "UNSUPPORTED", "delete blobs via manifest cascade");
  });

  // ── Uploads ──────────────────────────────────────────────────────────

  // Start a new upload, mount from another repo, or do a single-shot
  // monolithic push. BuildKit overwhelmingly uses the first form.
  app.post(`/v2/${NAME}/blobs/uploads/`, async (c) => {
    const name = c.req.param("name");
    const mount = c.req.query("mount");
    const digestQ = c.req.query("digest");

    // Cross-repo mount: blobs are stored globally (single namespace) so any
    // already-stored digest can be "mounted" by replying 201 with the digest
    // header. The `from=` repo isn't consulted, because we have one blob store.
    if (mount && store.blobExists(mount)) {
      c.header("Docker-Content-Digest", mount);
      c.header("Location", `/v2/${name}/blobs/${mount}`);
      return c.body(null, 201);
    }
    if (mount) {
      // Mount asked but we don't have the blob. Spec says fall through to a
      // regular upload session.
    }

    // Monolithic single-POST upload (digest in query, body in request).
    if (digestQ) {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      try {
        const rec = await store.writeBlobFromBytes(bytes, digestQ);
        c.header("Docker-Content-Digest", rec.digest);
        c.header("Location", `/v2/${name}/blobs/${rec.digest}`);
        return c.body(null, 201);
      } catch (err) {
        if (err instanceof DigestMismatchError) {
          return errorResponse(c, 400, "DIGEST_INVALID", err.message);
        }
        throw err;
      }
    }

    // Plain upload-session start.
    const uuid = store.startUpload(name);
    c.header("Location", `/v2/${name}/blobs/uploads/${uuid}`);
    c.header("Docker-Upload-UUID", uuid);
    c.header("Range", "0-0");
    return c.body(null, 202);
  });

  app.patch(`/v2/${NAME}/blobs/uploads/:uuid`, async (c) => {
    const name = c.req.param("name");
    const uuid = c.req.param("uuid");
    const upload = store.getUpload(uuid);
    if (!upload) return errorResponse(c, 404, "BLOB_UPLOAD_UNKNOWN", uuid);

    // We don't enforce Content-Range strictly. BuildKit and containerd send
    // contiguous PATCHes anyway, and rejecting on header parse trouble has
    // historically caused more grief than it's worth. If a client ever resumes
    // a partial upload from offset N, our `offset` tracking will diverge and
    // the finalize hash will mismatch, which is the correct end state.
    const body = c.req.raw.body;
    if (body) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await store.appendUpload(uuid, value);
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    const final = store.getUpload(uuid)!;
    c.header("Location", `/v2/${name}/blobs/uploads/${uuid}`);
    c.header("Docker-Upload-UUID", uuid);
    c.header("Range", `0-${Math.max(0, final.offset - 1)}`);
    return c.body(null, 202);
  });

  app.put(`/v2/${NAME}/blobs/uploads/:uuid`, async (c) => {
    const name = c.req.param("name");
    const uuid = c.req.param("uuid");
    const digest = c.req.query("digest");
    if (!digest) return errorResponse(c, 400, "DIGEST_INVALID", "missing ?digest=");

    const upload = store.getUpload(uuid);
    if (!upload) return errorResponse(c, 404, "BLOB_UPLOAD_UNKNOWN", uuid);

    // Tail body (if any) is appended before finalize, since clients may send the
    // final chunk on the PUT itself instead of doing PATCH→PUT(empty).
    const body = c.req.raw.body;
    if (body) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await store.appendUpload(uuid, value);
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    try {
      const rec = await store.finalizeUpload(uuid, digest);
      c.header("Docker-Content-Digest", rec.digest);
      c.header("Location", `/v2/${name}/blobs/${rec.digest}`);
      return c.body(null, 201);
    } catch (err) {
      if (err instanceof DigestMismatchError) {
        return errorResponse(c, 400, "DIGEST_INVALID", err.message);
      }
      throw err;
    }
  });

  // ── Catalog / tags ───────────────────────────────────────────────────

  app.get("/v2/_catalog", (c) => {
    return c.json({ repositories: store.listRepositories() });
  });

  app.get(`/v2/${NAME}/tags/list`, (c) => {
    const name = c.req.param("name");
    return c.json({ name, tags: store.listTags(name) });
  });

  return app;
}

// OCI-style error envelope. Clients log the code & message verbatim, so the
// codes need to match the spec strings even though microsandbox/BuildKit only
// check status codes in practice.
function errorResponse(c: Context, status: number, code: string, detail: string) {
  return c.json({ errors: [{ code, message: detail, detail }] }, status as 400 | 404 | 405);
}
