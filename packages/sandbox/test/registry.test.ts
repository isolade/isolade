import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegistryServer, startRegistry } from "../src/registry";

// End-to-end: spin up the in-process registry on a random port, then exercise
// the exact protocol flows BuildKit-as-pusher and microsandbox-as-puller take.
// We don't run BuildKit/microsandbox here (that's the integration tests'
// job), but we replay the request shapes they emit.

let registry: RegistryServer;
let base: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "isolade-registry-test-"));
  registry = await startRegistry({ port: 0, dataDir });
  base = `http://127.0.0.1:${registry.port}`;
});

afterAll(async () => {
  await registry.stop();
  await rm(dataDir, { recursive: true, force: true });
});

function sha256(buf: Uint8Array): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

async function uploadBlob(repo: string, body: Uint8Array): Promise<string> {
  const digest = sha256(body);
  const start = await fetch(`${base}/v2/${repo}/blobs/uploads/`, {
    method: "POST",
  });
  expect(start.status).toBe(202);
  const location = start.headers.get("location")!;
  expect(location).toBeTruthy();
  const put = await fetch(`${base}${location}?digest=${encodeURIComponent(digest)}`, {
    method: "PUT",
    // A Uint8Array is a valid runtime body, but recent TS lib types reject the
    // generic `Uint8Array<ArrayBufferLike>` as BodyInit, so narrow it here.
    body: body as BodyInit,
  });
  expect(put.status).toBe(201);
  expect(put.headers.get("docker-content-digest")).toBe(digest);
  return digest;
}

describe("registry v2 protocol", () => {
  it("responds to /v2/ ping", async () => {
    const res = await fetch(`${base}/v2/`);
    expect(res.status).toBe(200);
  });

  it("pushes and pulls a blob via POST→PUT", async () => {
    const body = new TextEncoder().encode("hello world");
    const digest = await uploadBlob("acme/img", body);

    const head = await fetch(`${base}/v2/acme/img/blobs/${digest}`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("docker-content-digest")).toBe(digest);
    expect(head.headers.get("content-length")).toBe(String(body.length));

    const get = await fetch(`${base}/v2/acme/img/blobs/${digest}`);
    expect(get.status).toBe(200);
    const fetched = new Uint8Array(await get.arrayBuffer());
    expect(fetched).toEqual(body);
  });

  it("rejects a blob whose digest doesn't match its content", async () => {
    const body = new TextEncoder().encode("payload");
    const start = await fetch(`${base}/v2/acme/img/blobs/uploads/`, {
      method: "POST",
    });
    const location = start.headers.get("location")!;
    const lie = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const put = await fetch(`${base}${location}?digest=${lie}`, {
      method: "PUT",
      body,
    });
    expect(put.status).toBe(400);
  });

  it("supports chunked upload via PATCH+PUT", async () => {
    const a = new TextEncoder().encode("alpha-");
    const b = new TextEncoder().encode("beta");
    const full = new Uint8Array(a.length + b.length);
    full.set(a, 0);
    full.set(b, a.length);
    const digest = sha256(full);

    const start = await fetch(`${base}/v2/acme/img/blobs/uploads/`, {
      method: "POST",
    });
    const loc = start.headers.get("location")!;
    const patch1 = await fetch(`${base}${loc}`, { method: "PATCH", body: a });
    expect(patch1.status).toBe(202);
    expect(patch1.headers.get("range")).toBe(`0-${a.length - 1}`);
    const patch2 = await fetch(`${base}${loc}`, { method: "PATCH", body: b });
    expect(patch2.status).toBe(202);
    expect(patch2.headers.get("range")).toBe(`0-${full.length - 1}`);
    const put = await fetch(`${base}${loc}?digest=${encodeURIComponent(digest)}`, {
      method: "PUT",
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("docker-content-digest")).toBe(digest);
  });

  it("mounts a blob from another repo without re-uploading", async () => {
    const body = new TextEncoder().encode("shared layer");
    const digest = await uploadBlob("repo-a/img", body);
    const mount = await fetch(
      `${base}/v2/repo-b/img/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=repo-a/img`,
      { method: "POST" },
    );
    expect(mount.status).toBe(201);
    expect(mount.headers.get("docker-content-digest")).toBe(digest);
    // The blob is now reachable through repo-b too.
    const head = await fetch(`${base}/v2/repo-b/img/blobs/${digest}`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
  });

  it("stores manifests under a tag and resolves both tag and digest", async () => {
    const cfg = new TextEncoder().encode('{"config":"json"}');
    const layer = new TextEncoder().encode("layer-bytes");
    const cfgDigest = await uploadBlob("ns/img", cfg);
    const layerDigest = await uploadBlob("ns/img", layer);

    const manifest = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: cfgDigest,
          size: cfg.length,
        },
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
            digest: layerDigest,
            size: layer.length,
          },
        ],
      }),
    );
    const manifestDigest = sha256(manifest);

    const put = await fetch(`${base}/v2/ns/img/manifests/latest`, {
      method: "PUT",
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest,
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("docker-content-digest")).toBe(manifestDigest);

    // Resolve by tag.
    const byTag = await fetch(`${base}/v2/ns/img/manifests/latest`);
    expect(byTag.status).toBe(200);
    expect(byTag.headers.get("docker-content-digest")).toBe(manifestDigest);
    expect(byTag.headers.get("content-type")).toBe("application/vnd.oci.image.manifest.v1+json");

    // Resolve by digest.
    const byDigest = await fetch(`${base}/v2/ns/img/manifests/${manifestDigest}`);
    expect(byDigest.status).toBe(200);
    const body = new Uint8Array(await byDigest.arrayBuffer());
    expect(body).toEqual(manifest);
  });

  it("cascade-deletes referenced blobs when no other manifest needs them", async () => {
    const cfg = new TextEncoder().encode('{"a":1}');
    const layer = new TextEncoder().encode("aaa");
    const cfgDigest = await uploadBlob("gc/img", cfg);
    const layerDigest = await uploadBlob("gc/img", layer);

    const manifest = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { digest: cfgDigest, size: cfg.length },
        layers: [{ digest: layerDigest, size: layer.length }],
      }),
    );
    const manifestDigest = sha256(manifest);
    await fetch(`${base}/v2/gc/img/manifests/v1`, {
      method: "PUT",
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest,
    });

    const del = await fetch(`${base}/v2/gc/img/manifests/${manifestDigest}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(202);

    // Both referenced blobs are gone.
    for (const d of [cfgDigest, layerDigest]) {
      const head = await fetch(`${base}/v2/gc/img/blobs/${d}`, {
        method: "HEAD",
      });
      expect(head.status).toBe(404);
    }
    // Tag is gone.
    const tag = await fetch(`${base}/v2/gc/img/manifests/v1`);
    expect(tag.status).toBe(404);
  });

  it("keeps blobs alive when another manifest still references them", async () => {
    const sharedCfg = new TextEncoder().encode('{"shared":true}');
    const cfgDigest = await uploadBlob("share/a", sharedCfg);
    const buildManifest = (extraLayer: Uint8Array) => {
      const layerDigest = sha256(extraLayer);
      const body = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config: { digest: cfgDigest, size: sharedCfg.length },
          layers: [{ digest: layerDigest, size: extraLayer.length }],
        }),
      );
      return { body, digest: sha256(body), layerDigest };
    };

    const layer1 = new TextEncoder().encode("layer-1");
    await uploadBlob("share/a", layer1);
    const m1 = buildManifest(layer1);
    await fetch(`${base}/v2/share/a/manifests/t1`, {
      method: "PUT",
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      body: m1.body,
    });

    const layer2 = new TextEncoder().encode("layer-2");
    await uploadBlob("share/a", layer2);
    const m2 = buildManifest(layer2);
    await fetch(`${base}/v2/share/a/manifests/t2`, {
      method: "PUT",
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      body: m2.body,
    });

    const del = await fetch(`${base}/v2/share/a/manifests/${m1.digest}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(202);

    // The shared config blob and the layer that was only in m2 must survive.
    const cfgHead = await fetch(`${base}/v2/share/a/blobs/${cfgDigest}`, {
      method: "HEAD",
    });
    expect(cfgHead.status).toBe(200);
    const layer2Head = await fetch(`${base}/v2/share/a/blobs/${m2.layerDigest}`, {
      method: "HEAD",
    });
    expect(layer2Head.status).toBe(200);
    // The layer only referenced by m1 is gone.
    const layer1Head = await fetch(`${base}/v2/share/a/blobs/${m1.layerDigest}`, {
      method: "HEAD",
    });
    expect(layer1Head.status).toBe(404);
  });

  it("lists repos via _catalog and tags via tags/list", async () => {
    const cat = await fetch(`${base}/v2/_catalog`);
    const catBody = (await cat.json()) as { repositories: string[] };
    expect(catBody.repositories).toContain("ns/img");

    const tags = await fetch(`${base}/v2/ns/img/tags/list`);
    const tagsBody = (await tags.json()) as { name: string; tags: string[] };
    expect(tagsBody.name).toBe("ns/img");
    expect(tagsBody.tags).toContain("latest");
  });

  it("returns 404 for unknown manifests and blobs", async () => {
    const mf = await fetch(`${base}/v2/nope/img/manifests/latest`);
    expect(mf.status).toBe(404);
    const bl = await fetch(`${base}/v2/nope/img/blobs/sha256:deadbeef`);
    expect(bl.status).toBe(404);
  });
});
