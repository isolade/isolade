import { Image } from "microsandbox";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

// Sweep the local registry to match `keepTags`. Tags not in the keep set have
// their manifest deleted. The in-process registry's DELETE handler cascades
// orphaned blobs in the same transaction, so there's no separate offline blob
// GC step. Caller must still guarantee no concurrent pushes (BuilderManager's
// opChain serializes this).
//
// `keepTags` is a Set of `<repo>:<tag>` strings (no registry host prefix). The
// caller is responsible for expanding any related refs (e.g. base + final
// passes) before calling.
export async function runRegistryGarbageCollect(
  registry: string,
  keepTags: Set<string>,
  log: (line: string) => void,
): Promise<void> {
  const repos = await listRepositories(registry);
  let deleted = 0;
  let scanned = 0;
  for (const repo of repos) {
    const tags = await listTags(registry, repo);
    for (const tag of tags) {
      scanned++;
      if (keepTags.has(`${repo}:${tag}`)) continue;
      try {
        await deleteManifestByTag(registry, repo, tag);
        deleted++;
        log(`deleted ${repo}:${tag}`);
      } catch (err) {
        log(`delete failed for ${repo}:${tag}: ${String(err)}`);
      }
    }
  }
  log(`scanned ${scanned} tags across ${repos.length} repos, deleted ${deleted}`);
}

// Reclaim space from microsandbox's image cache. List cached refs via the
// SDK and remove everything not in `keepRefs`. microsandbox owns the actual
// deletion (DB rows + per-image fsmeta/vmdk + per-layer .erofs files).
//
// Same serialization rule as runRegistryGarbageCollect: a half-finished
// `microsandbox pull` for a fresh build could race the listing and leave a
// brand-new ref un-protected. We deliberately don't pass `force: true` so a
// stale server-side instances row can't silently corrupt a live VM.
export async function runMicrosandboxGc(
  keepRefs: string[],
  log: (line: string) => void,
): Promise<void> {
  const cached = await Image.list();
  const keepSet = new Set(keepRefs);
  const doomed = cached.filter((img) => !keepSet.has(img.reference));

  if (doomed.length === 0) {
    log(`microsandbox gc: ${cached.length} cached ref(s), all in keep set`);
    return;
  }
  log(`microsandbox gc: dropping ${doomed.length} of ${cached.length} cached ref(s)`);

  let removed = 0;
  for (const img of doomed) {
    try {
      await Image.remove(img.reference);
      removed++;
      log(`  removed ${img.reference}`);
    } catch (err) {
      log(`  skip ${img.reference}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`microsandbox gc: removed ${removed} of ${doomed.length}`);
}

async function listRepositories(registry: string): Promise<string[]> {
  // n=1000 is the registry's max page size (newer versions reject larger
  // values with PAGINATION_NUMBER_INVALID) and well above any plausible build
  // count for this dev-only registry.
  const res = await fetch(`http://${registry}/v2/_catalog?n=1000`);
  if (!res.ok) {
    throw new Error(`_catalog failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { repositories?: unknown };
  if (!Array.isArray(body.repositories)) return [];
  return body.repositories.filter((r): r is string => typeof r === "string");
}

async function listTags(registry: string, repo: string): Promise<string[]> {
  const res = await fetch(`http://${registry}/v2/${repo}/tags/list`);
  if (!res.ok) return [];
  const body = (await res.json()) as { tags?: unknown };
  if (!Array.isArray(body.tags)) return [];
  return body.tags.filter((t): t is string => typeof t === "string");
}

export async function deleteManifestByTag(
  registry: string,
  repo: string,
  tag: string,
): Promise<void> {
  const base = `http://${registry}/v2/${repo}/manifests`;
  const head = await fetch(`${base}/${encodeURIComponent(tag)}`, {
    method: "HEAD",
    headers: { Accept: MANIFEST_ACCEPT },
  });
  const digest = head.headers.get("docker-content-digest");
  if (!head.ok || !digest) {
    throw new Error(`manifest lookup failed: ${head.status} ${head.statusText}`);
  }
  const del = await fetch(`${base}/${digest}`, { method: "DELETE" });
  if (!del.ok && del.status !== 404) {
    throw new Error(`manifest delete failed: ${del.status} ${del.statusText}`);
  }
}

export function parseImageRef(ref: string): { registry: string; name: string; tag: string } | null {
  const atColon = ref.lastIndexOf(":");
  if (atColon < 0) return null;
  const tag = ref.slice(atColon + 1);
  const prefix = ref.slice(0, atColon);
  const firstSlash = prefix.indexOf("/");
  if (firstSlash < 0) return null;
  const registry = prefix.slice(0, firstSlash);
  const name = prefix.slice(firstSlash + 1);
  if (!registry.includes(".") && !registry.includes(":") && registry !== "localhost") {
    return null;
  }
  return { registry, name, tag };
}

export interface ImageConfig {
  user: string | null;
  env: Record<string, string>;
  workingDir: string | null;
}

// Reads an image's config blob from the local OCI registry over plain HTTP.
// Returns null on any failure (parse error, network, non-local registry):
// callers fall back to root-user defaults rather than blocking VM creation.
//
// Used to discover the USER/HOME the image expects so we can preserve a
// user-set USER directive (instead of forcing root) and route credential
// patches into the right HOME instead of hardcoding /root.
// Reads via microsandbox's local image cache first (no network). Falls back
// to a direct registry HTTP fetch only when the image hasn't been pulled yet,
// i.e. the first createVm for a brand-new ref. After that, every call is
// a local-cache hit. Returns null when both paths fail, and callers treat that
// as "default to root".
export async function inspectImageConfig(imageRef: string): Promise<ImageConfig | null> {
  const local = await inspectImageConfigLocal(imageRef);
  if (local) return local;

  const parsed = parseImageRef(imageRef);
  if (!parsed) {
    console.warn(
      `[inspect ${imageRef}] unparseable ref and not in local cache; falling back to root defaults`,
    );
    return null;
  }
  const { registry, name, tag } = parsed;
  try {
    let manifest = await fetchManifest(registry, name, tag);
    if (!manifest) {
      console.warn(`[inspect ${imageRef}] manifest fetch returned null`);
      return null;
    }
    if (Array.isArray((manifest as { manifests?: unknown[] }).manifests)) {
      const list = manifest as { manifests: { digest?: unknown }[] };
      const child = list.manifests[0];
      const childDigest = child?.digest;
      if (typeof childDigest !== "string") {
        console.warn(`[inspect ${imageRef}] manifest list missing child digest`);
        return null;
      }
      manifest = await fetchManifest(registry, name, childDigest);
      if (!manifest) {
        console.warn(`[inspect ${imageRef}] child manifest fetch returned null`);
        return null;
      }
    }
    const configDigest = (manifest as { config?: { digest?: unknown } }).config?.digest;
    if (typeof configDigest !== "string") {
      console.warn(
        `[inspect ${imageRef}] manifest has no config.digest (keys=${Object.keys(manifest as object).join(",")})`,
      );
      return null;
    }
    const blobRes = await fetch(
      `http://${registry}/v2/${name}/blobs/${encodeURIComponent(configDigest)}`,
    );
    if (!blobRes.ok) {
      console.warn(
        `[inspect ${imageRef}] config blob ${configDigest} fetch failed: ${blobRes.status}`,
      );
      return null;
    }
    const blob = (await blobRes.json()) as { config?: Record<string, unknown> };
    const c = blob.config ?? {};
    const env: Record<string, string> = {};
    if (Array.isArray(c.Env)) {
      for (const entry of c.Env as unknown[]) {
        if (typeof entry !== "string") continue;
        const eq = entry.indexOf("=");
        if (eq < 0) continue;
        env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
    }
    const user = typeof c.User === "string" && c.User.length > 0 ? c.User : null;
    const workingDir =
      typeof c.WorkingDir === "string" && c.WorkingDir.length > 0 ? c.WorkingDir : null;
    console.log(
      `[inspect ${imageRef}] (registry) user=${user ?? "(unset)"} workingDir=${workingDir ?? "(unset)"} env.HOME=${env.HOME ?? "(unset)"}`,
    );
    return { user, env, workingDir };
  } catch (err) {
    console.warn(
      `[inspect ${imageRef}] registry path threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// Reads the image config from microsandbox's local cache. Returns null if the
// image hasn't been pulled yet (first VM create for a new image) or if any
// error occurs. The caller falls back to the registry path in that case.
async function inspectImageConfigLocal(imageRef: string): Promise<ImageConfig | null> {
  try {
    const detail = await Image.inspect(imageRef);
    if (!detail.config) return null;
    const c = detail.config;
    const env: Record<string, string> = {};
    for (const entry of c.env) {
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const user = c.user && c.user.length > 0 ? c.user : null;
    const workingDir = c.workingDir && c.workingDir.length > 0 ? c.workingDir : null;
    console.log(
      `[inspect ${imageRef}] (local) user=${user ?? "(unset)"} workingDir=${workingDir ?? "(unset)"} env.HOME=${env.HOME ?? "(unset)"}`,
    );
    return { user, env, workingDir };
  } catch {
    // Not in local cache yet, so the caller falls back to registry HTTP.
    return null;
  }
}

async function fetchManifest(
  registry: string,
  name: string,
  reference: string,
): Promise<unknown | null> {
  const res = await fetch(
    `http://${registry}/v2/${name}/manifests/${encodeURIComponent(reference)}`,
    { headers: { Accept: MANIFEST_ACCEPT } },
  );
  if (!res.ok) return null;
  return res.json();
}

// Best-effort home directory for the image's runtime user. HOME from the
// image config wins. Otherwise we synthesize one from User: empty/root → /root,
// anything else → /home/<user>. Group suffixes ("alice:dev") are stripped.
export function deriveHome(config: ImageConfig | null): string {
  if (!config) return "/root";
  if (config.env.HOME) return config.env.HOME;
  const user = imageUserName(config);
  if (!user || user === "root") return "/root";
  return `/home/${user}`;
}

// Just the user portion of config.User, with group/uid:gid handling: returns
// null when the image leaves USER unset (microsandbox falls back to root).
export function imageUserName(config: ImageConfig | null): string | null {
  if (!config?.user) return null;
  const head = config.user.split(":")[0];
  if (!head) return null;
  if (head === "0") return "root";
  return head;
}
