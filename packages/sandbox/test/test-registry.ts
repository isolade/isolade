/**
 * Minimal OCI Distribution v2 registry for tests. In-memory, listens on
 * 0.0.0.0 so microsandbox VMs can reach it via the host bridge.
 *
 * Implements the subset buildctl uses for push: ping, blob upload (initiate,
 * chunked PATCH, commit PUT, monolithic POST?digest, cross-repo mount), blob
 * HEAD/GET, and manifest PUT/HEAD/GET/DELETE. No auth, no garbage collection.
 *
 * Lives under test/ today because that's where it's used. If/when we drop the
 * Docker registry from production this is a reasonable starting point.
 */
import { createHash, randomUUID } from "node:crypto";

export interface ManifestRecord {
  digest: string;
  contentType: string;
  body: Buffer;
}

export interface TestRegistryHandle {
  /** "host:port" reachable from the host (loopback). */
  endpoint: string;
  /** Listen port. */
  port: number;
  /** name -> manifest record. Tag-keyed as `${name}:${ref}` and digest-keyed as `${name}@${digest}`. */
  manifests: Map<string, ManifestRecord>;
  /** digest -> blob bytes. */
  blobs: Map<string, Buffer>;
  shutdown: () => Promise<void>;
}

const sha256 = (buf: Buffer | Uint8Array): string =>
  `sha256:${createHash("sha256").update(buf).digest("hex")}`;

export async function startTestRegistry(): Promise<TestRegistryHandle> {
  const blobs = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer>();
  const manifests = new Map<string, ManifestRecord>();

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // v2 ping (used by clients to verify the API)
    if (path === "/v2/" || path === "/v2") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // /v2/<name>/blobs/uploads/   (POST = initiate, may be monolithic or mount)
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/v2\/(.+)\/blobs\/uploads\/?$/)) && method === "POST") {
      const name = m[1]!;
      const digest = url.searchParams.get("digest");
      const mount = url.searchParams.get("mount");

      // Cross-repo blob mount: succeed only if we already have the blob, else
      // fall through to a normal upload (per Distribution spec).
      if (mount && blobs.has(mount)) {
        return new Response(null, {
          status: 201,
          headers: {
            "Docker-Content-Digest": mount,
            Location: `/v2/${name}/blobs/${mount}`,
          },
        });
      }

      if (digest) {
        // Monolithic upload: payload is the full blob.
        const body = Buffer.from(await req.arrayBuffer());
        const got = sha256(body);
        if (got !== digest) {
          return new Response(`digest mismatch: got ${got}, expected ${digest}`, {
            status: 400,
          });
        }
        blobs.set(digest, body);
        return new Response(null, {
          status: 201,
          headers: {
            "Docker-Content-Digest": digest,
            Location: `/v2/${name}/blobs/${digest}`,
          },
        });
      }

      const uuid = randomUUID();
      uploads.set(uuid, Buffer.alloc(0));
      return new Response(null, {
        status: 202,
        headers: {
          Location: `/v2/${name}/blobs/uploads/${uuid}`,
          "Docker-Upload-UUID": uuid,
          Range: "0-0",
        },
      });
    }

    // /v2/<name>/blobs/uploads/<uuid>   (PATCH chunk, PUT commit)
    if ((m = path.match(/^\/v2\/(.+)\/blobs\/uploads\/([\w-]+)\/?$/))) {
      const name = m[1]!;
      const uuid = m[2]!;

      if (method === "PATCH") {
        const cur = uploads.get(uuid);
        if (!cur) return new Response("upload not found", { status: 404 });
        const chunk = Buffer.from(await req.arrayBuffer());
        const merged = chunk.length ? Buffer.concat([cur, chunk]) : cur;
        uploads.set(uuid, merged);
        return new Response(null, {
          status: 202,
          headers: {
            Location: `/v2/${name}/blobs/uploads/${uuid}`,
            Range: `0-${Math.max(0, merged.length - 1)}`,
            "Docker-Upload-UUID": uuid,
          },
        });
      }

      if (method === "PUT") {
        const digest = url.searchParams.get("digest");
        if (!digest) return new Response("digest required", { status: 400 });
        const cur = uploads.get(uuid) ?? Buffer.alloc(0);
        const tail = Buffer.from(await req.arrayBuffer());
        const body = tail.length ? Buffer.concat([cur, tail]) : cur;
        const got = sha256(body);
        if (got !== digest) {
          return new Response(`digest mismatch: got ${got}, expected ${digest}`, {
            status: 400,
          });
        }
        blobs.set(digest, body);
        uploads.delete(uuid);
        return new Response(null, {
          status: 201,
          headers: {
            "Docker-Content-Digest": digest,
            Location: `/v2/${name}/blobs/${digest}`,
          },
        });
      }
    }

    // /v2/<name>/blobs/<digest>   (HEAD existence check, GET pull)
    if ((m = path.match(/^\/v2\/(.+)\/blobs\/(sha256:[a-f0-9]+)$/))) {
      const digest = m[2]!;
      const blob = blobs.get(digest);
      if (!blob) return new Response(null, { status: 404 });
      const headers = {
        "Docker-Content-Digest": digest,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(blob.length),
      };
      if (method === "HEAD") return new Response(null, { status: 200, headers });
      if (method === "GET") return new Response(new Uint8Array(blob), { status: 200, headers });
    }

    // /v2/<name>/manifests/<reference>   (PUT publish, HEAD/GET fetch, DELETE remove)
    if ((m = path.match(/^\/v2\/(.+)\/manifests\/(.+)$/))) {
      const name = m[1]!;
      const ref = m[2]!;

      if (method === "PUT") {
        const body = Buffer.from(await req.arrayBuffer());
        const contentType =
          req.headers.get("content-type") ?? "application/vnd.oci.image.manifest.v1+json";
        const digest = sha256(body);
        const record: ManifestRecord = { digest, contentType, body };
        manifests.set(`${name}:${ref}`, record);
        manifests.set(`${name}@${digest}`, record);
        return new Response(null, {
          status: 201,
          headers: {
            "Docker-Content-Digest": digest,
            Location: `/v2/${name}/manifests/${digest}`,
          },
        });
      }

      const record = manifests.get(`${name}:${ref}`) ?? manifests.get(`${name}@${ref}`);
      if (method === "HEAD" || method === "GET") {
        if (!record) return new Response(null, { status: 404 });
        const headers = {
          "Docker-Content-Digest": record.digest,
          "Content-Type": record.contentType,
          "Content-Length": String(record.body.length),
        };
        return method === "HEAD"
          ? new Response(null, { status: 200, headers })
          : new Response(new Uint8Array(record.body), { status: 200, headers });
      }

      if (method === "DELETE") {
        const found = manifests.delete(`${name}:${ref}`) || manifests.delete(`${name}@${ref}`);
        return new Response(null, { status: found ? 202 : 404 });
      }
    }

    return new Response(`not found: ${method} ${path}`, { status: 404 });
  };

  // 0.0.0.0 binding so microsandbox VMs can reach us via the host bridge IP.
  // port: 0 lets the kernel pick a free port.
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: handler });
  const port = server.port;
  if (typeof port !== "number") throw new Error("test registry: server has no port");

  return {
    endpoint: `127.0.0.1:${port}`,
    port,
    manifests,
    blobs,
    async shutdown() {
      server.stop(true);
    },
  };
}
