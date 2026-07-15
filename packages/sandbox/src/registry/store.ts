import { Database } from "bun:sqlite";
import { createHash, type Hash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// OCI media types we treat as "this is a manifest, parse it for refs". Anything
// else (layer tarballs, config blobs) is just opaque bytes addressed by digest.
const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

export interface ManifestRecord {
  digest: string;
  mediaType: string;
  size: number;
  body: Buffer;
}

export interface BlobRecord {
  digest: string;
  size: number;
}

interface UploadState {
  uuid: string;
  repo: string;
  path: string;
  offset: number;
  hash: Hash;
}

// File-backed, SQLite-indexed OCI registry storage. Blobs sit on disk
// content-addressed by their full digest string ("sha256:<hex>"). The SQLite
// db tracks tags, manifests (the body is inlined, since manifests are
// kilobytes), and the blob/child references each manifest pulls in. Deleting a
// manifest cascades: any blob no longer referenced by another manifest is
// unlinked.
//
// In-memory upload state: a server restart mid-push aborts in-flight uploads
// (BuildKit retries). We don't persist hash state to avoid the serialization
// dance.
export class RegistryStore {
  private db: Database;
  private uploads = new Map<string, UploadState>();
  private blobsDir: string;
  private uploadsDir: string;

  constructor(dataDir: string) {
    this.blobsDir = join(dataDir, "blobs");
    this.uploadsDir = join(dataDir, "uploads");
    this.db = new Database(join(dataDir, "registry.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        digest TEXT PRIMARY KEY,
        size   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS manifests (
        digest     TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        size       INTEGER NOT NULL,
        body       BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags (
        repo            TEXT NOT NULL,
        tag             TEXT NOT NULL,
        manifest_digest TEXT NOT NULL REFERENCES manifests(digest),
        PRIMARY KEY (repo, tag)
      );
      CREATE TABLE IF NOT EXISTS manifest_blob_refs (
        manifest_digest TEXT NOT NULL REFERENCES manifests(digest) ON DELETE CASCADE,
        blob_digest     TEXT NOT NULL,
        PRIMARY KEY (manifest_digest, blob_digest)
      );
      CREATE TABLE IF NOT EXISTS manifest_child_refs (
        parent_digest TEXT NOT NULL REFERENCES manifests(digest) ON DELETE CASCADE,
        child_digest  TEXT NOT NULL,
        PRIMARY KEY (parent_digest, child_digest)
      );
      CREATE INDEX IF NOT EXISTS idx_blob_refs_blob ON manifest_blob_refs(blob_digest);
      CREATE INDEX IF NOT EXISTS idx_child_refs_child ON manifest_child_refs(child_digest);
      CREATE INDEX IF NOT EXISTS idx_tags_manifest ON tags(manifest_digest);
    `);
  }

  static async open(dataDir: string): Promise<RegistryStore> {
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(dataDir, "blobs"), { recursive: true });
    await mkdir(join(dataDir, "uploads"), { recursive: true });
    return new RegistryStore(dataDir);
  }

  close() {
    this.db.close();
  }

  // ── blobs ──────────────────────────────────────────────────────────────

  blobExists(digest: string): boolean {
    return this.db.prepare("SELECT 1 FROM blobs WHERE digest = ?").get(digest) !== null;
  }

  blobStat(digest: string): BlobRecord | null {
    const row = this.db.prepare("SELECT digest, size FROM blobs WHERE digest = ?").get(digest) as {
      digest: string;
      size: number;
    } | null;
    return row ? { digest: row.digest, size: row.size } : null;
  }

  blobPath(digest: string): string {
    // digest is "sha256:<hex>", so keep the colon out of the filename, but the
    // hex alone is fine since we only ever index/dedup by full digest string.
    return join(this.blobsDir, digestToFilename(digest));
  }

  // ── uploads ────────────────────────────────────────────────────────────

  startUpload(repo: string): string {
    const uuid = randomUUID();
    const path = join(this.uploadsDir, uuid);
    this.uploads.set(uuid, {
      uuid,
      repo,
      path,
      offset: 0,
      hash: createHash("sha256"),
    });
    return uuid;
  }

  getUpload(uuid: string): UploadState | null {
    return this.uploads.get(uuid) ?? null;
  }

  // Append a chunk to an in-progress upload. Returns the new total offset.
  async appendUpload(uuid: string, chunk: Uint8Array): Promise<number> {
    const u = this.uploads.get(uuid);
    if (!u) throw new Error(`unknown upload ${uuid}`);
    if (chunk.length === 0) return u.offset;
    await writeFile(u.path, chunk, { flag: u.offset === 0 ? "w" : "a" });
    u.hash.update(chunk);
    u.offset += chunk.length;
    return u.offset;
  }

  // Atomically move the staged upload into the blob store after verifying its
  // digest matches the client's claim. Idempotent against concurrent identical
  // pushes: last rename wins, both succeed.
  async finalizeUpload(uuid: string, expectedDigest: string): Promise<BlobRecord> {
    const u = this.uploads.get(uuid);
    if (!u) throw new Error(`unknown upload ${uuid}`);
    const actual = `sha256:${u.hash.digest("hex")}`;
    if (actual !== expectedDigest) {
      await rm(u.path, { force: true }).catch(() => {});
      this.uploads.delete(uuid);
      throw new DigestMismatchError(expectedDigest, actual);
    }
    const final = this.blobPath(actual);
    await rename(u.path, final);
    const size = u.offset;
    this.db.prepare("INSERT OR REPLACE INTO blobs (digest, size) VALUES (?, ?)").run(actual, size);
    this.uploads.delete(uuid);
    return { digest: actual, size };
  }

  async cancelUpload(uuid: string): Promise<void> {
    const u = this.uploads.get(uuid);
    if (!u) return;
    await rm(u.path, { force: true }).catch(() => {});
    this.uploads.delete(uuid);
  }

  // Used by the mount-from-repo shortcut: if the blob is already in our store,
  // we can satisfy the cross-repo mount with a 201 and no upload at all.
  mountBlob(digest: string): BlobRecord | null {
    return this.blobStat(digest);
  }

  // Single-shot monolithic upload (POST .../uploads/?digest=...). Verifies
  // hash, stores blob. Used less often than POST→PATCH→PUT but spec-required.
  async writeBlobFromBytes(bytes: Uint8Array, expectedDigest: string): Promise<BlobRecord> {
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== expectedDigest) {
      throw new DigestMismatchError(expectedDigest, actual);
    }
    const path = this.blobPath(actual);
    await writeFile(path, bytes);
    this.db
      .prepare("INSERT OR REPLACE INTO blobs (digest, size) VALUES (?, ?)")
      .run(actual, bytes.length);
    return { digest: actual, size: bytes.length };
  }

  // ── manifests ──────────────────────────────────────────────────────────

  // Store (or replace) a manifest at <repo>:<ref>. Parses the body to extract
  // referenced blob/child-manifest digests so deletes can cascade later.
  // Returns the manifest's computed digest.
  putManifest(repo: string, ref: string, mediaType: string, body: Buffer): { digest: string } {
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const { blobRefs, childRefs } = extractRefs(body, mediaType);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO manifests (digest, media_type, size, body) VALUES (?, ?, ?, ?)",
        )
        .run(digest, mediaType, body.length, body);
      // Refresh refs in case this digest was previously stored (no-op for
      // brand-new digests, since the ON CONFLICT path of INSERT OR REPLACE above
      // already wiped them via the ON DELETE CASCADE).
      const insBlob = this.db.prepare(
        "INSERT OR IGNORE INTO manifest_blob_refs (manifest_digest, blob_digest) VALUES (?, ?)",
      );
      for (const b of blobRefs) insBlob.run(digest, b);
      const insChild = this.db.prepare(
        "INSERT OR IGNORE INTO manifest_child_refs (parent_digest, child_digest) VALUES (?, ?)",
      );
      for (const c of childRefs) insChild.run(digest, c);

      // Only update the tag pointer when ref is a tag (not a digest). PUT
      // manifests/<digest> stores the manifest under that digest with no tag
      // movement, which is how index/list children land before the parent tag
      // PUT brings everything together.
      if (!ref.startsWith("sha256:")) {
        this.db
          .prepare("INSERT OR REPLACE INTO tags (repo, tag, manifest_digest) VALUES (?, ?, ?)")
          .run(repo, ref, digest);
      }
    });
    tx();
    return { digest };
  }

  // Resolve a tag or digest to the stored manifest. Returns null on miss.
  getManifestByRef(repo: string, ref: string): ManifestRecord | null {
    let digest = ref;
    if (!ref.startsWith("sha256:")) {
      const row = this.db
        .prepare("SELECT manifest_digest FROM tags WHERE repo = ? AND tag = ?")
        .get(repo, ref) as { manifest_digest: string } | null;
      if (!row) return null;
      digest = row.manifest_digest;
    }
    return this.getManifestByDigest(digest);
  }

  getManifestByDigest(digest: string): ManifestRecord | null {
    const row = this.db
      .prepare("SELECT digest, media_type, size, body FROM manifests WHERE digest = ?")
      .get(digest) as {
      digest: string;
      media_type: string;
      size: number;
      body: Buffer | Uint8Array;
    } | null;
    if (!row) return null;
    return {
      digest: row.digest,
      mediaType: row.media_type,
      size: row.size,
      body: Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body),
    };
  }

  // Full delete of a manifest by digest. Cascade rules:
  //   * Drop every tag that pointed at this manifest.
  //   * For each referenced blob, unlink the on-disk file iff no surviving
  //     manifest still references it.
  //   * Drop the manifest row (which cascades to *_refs via ON DELETE CASCADE).
  //
  // Child manifests of an index are NOT auto-deleted here. They have their
  // own digests and the puller (microsandbox / containerd) walks them by
  // digest, so leaving them addressable until they're individually GC'd is the
  // safer call. In Isolade's flow today there are no indices, so this branch
  // is academic. The moment we add multi-arch builds it'll matter.
  async deleteManifest(digest: string): Promise<{ blobsDeleted: number }> {
    const blobsToCheck = (
      this.db
        .prepare("SELECT blob_digest FROM manifest_blob_refs WHERE manifest_digest = ?")
        .all(digest) as { blob_digest: string }[]
    ).map((r) => r.blob_digest);

    this.db.transaction(() => {
      this.db.prepare("DELETE FROM tags WHERE manifest_digest = ?").run(digest);
      this.db.prepare("DELETE FROM manifests WHERE digest = ?").run(digest);
    })();

    let blobsDeleted = 0;
    for (const blob of blobsToCheck) {
      const stillRefd = this.db
        .prepare("SELECT 1 FROM manifest_blob_refs WHERE blob_digest = ? LIMIT 1")
        .get(blob);
      if (stillRefd) continue;
      this.db.prepare("DELETE FROM blobs WHERE digest = ?").run(blob);
      await unlink(this.blobPath(blob)).catch(() => {});
      blobsDeleted++;
    }
    return { blobsDeleted };
  }

  // ── catalog / tags ─────────────────────────────────────────────────────

  listRepositories(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT repo FROM tags ORDER BY repo").all() as {
        repo: string;
      }[]
    ).map((r) => r.repo);
  }

  listTags(repo: string): string[] {
    return (
      this.db.prepare("SELECT tag FROM tags WHERE repo = ? ORDER BY tag").all(repo) as {
        tag: string;
      }[]
    ).map((r) => r.tag);
  }

  // Resolve a tag without loading the manifest body. Used by HEAD handlers
  // that just need the digest header.
  resolveTagDigest(repo: string, tag: string): string | null {
    const row = this.db
      .prepare("SELECT manifest_digest FROM tags WHERE repo = ? AND tag = ?")
      .get(repo, tag) as { manifest_digest: string } | null;
    return row?.manifest_digest ?? null;
  }
}

export class DigestMismatchError extends Error {
  constructor(
    public expected: string,
    public actual: string,
  ) {
    super(`digest mismatch: expected ${expected}, got ${actual}`);
  }
}

// "sha256:abc..." → "sha256-abc..." for a filesystem-friendly filename.
function digestToFilename(digest: string): string {
  return digest.replace(":", "-");
}

interface RefExtraction {
  blobRefs: string[];
  childRefs: string[];
}

function extractRefs(body: Buffer, mediaType: string): RefExtraction {
  if (!MANIFEST_MEDIA_TYPES.has(mediaType)) {
    // Unknown media type, so treat as opaque with no refs to track.
    return { blobRefs: [], childRefs: [] };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { blobRefs: [], childRefs: [] };
  }
  // Image index / Docker manifest list: children are other manifests.
  if (Array.isArray(parsed?.manifests)) {
    const childRefs: string[] = [];
    for (const m of parsed.manifests) {
      if (typeof m?.digest === "string") childRefs.push(m.digest);
    }
    return { blobRefs: [], childRefs };
  }
  // Image manifest: config + layers are blobs.
  const blobRefs: string[] = [];
  if (typeof parsed?.config?.digest === "string") blobRefs.push(parsed.config.digest);
  if (Array.isArray(parsed?.layers)) {
    for (const l of parsed.layers) {
      if (typeof l?.digest === "string") blobRefs.push(l.digest);
    }
  }
  return { blobRefs, childRefs: [] };
}
