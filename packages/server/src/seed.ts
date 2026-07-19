import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Db } from "./db";
import { schema } from "./db";
import { isValidName, profileDir } from "./profile-config";
import { stateDir } from "./xdg";

// Profile seeding for `expose_sandbox` dev VMs (isolade within isolade).
//
// A nested isolade starts with empty XDG state: no profiles, and (because
// image refs are memoized per-installation in the DB while the images
// themselves live in the SHARED host sandbox cache) nothing runnable without a
// rebuild. Profiles listed in the dev profile's `seed_profiles` fix that: at
// instance create the host stages a SNAPSHOT bundle and bind-mounts it into
// the dev VM at SEED_MOUNT; at boot the nested server imports it.
//
// The bundle carries only non-sensitive material:
//   profiles/<id>/    a copy of the profile's config dir (config.toml +
//                     Dockerfile — git-trackable by design)
//   manifest.json     { version, profiles: { <id>: { name, image } } }, the
//                     host's current READY image refs. The refs are opaque
//                     keys into the shared cache (pullPolicy "never"), so the
//                     nested instance can boot them without any build. The
//                     host pre-registers them in the dev VM's retention
//                     keep-set (see clients.ts) so no GC collects them before
//                     the nested server's first own registration.
//
// NO auth tokens and NO secret values are seeded. Sign-in happens inside the
// nested instance (once per profile x provider), persisted across dev VMs via
// the dev profile's cache mount over the nested auth tree — a separate,
// dev-scoped credential grant, deliberately not the host's.
//
// Both sides of the contract live in this one module because both sides run
// this same server build: stageSeed()/removeSeedStaging() on the host,
// importSeedProfiles() in the guest.
//
// Known, accepted quirks of the snapshot model (dev-only feature):
//   - Staleness: a host rebuild after staging isn't propagated; the nested
//     instance keeps booting the seeded ref (retained by its keep-set) until
//     the dev VM is recreated, or the profile is rebuilt inside.
//   - Resurrection: deleting a seeded profile inside the nested instance
//     removes its config dir, which the next boot's import re-copies. The
//     seed set is host-owned; in-guest deletions are transient.

export const SEED_MOUNT = "/run/isolade-seed";

const MANIFEST_NAME = "manifest.json";
const PROFILES_SUBDIR = "profiles";

const seedManifestSchema = z.object({
  version: z.literal(1),
  profiles: z.record(
    z.string(),
    z.object({
      name: z.string().min(1),
      image: z.string().min(1),
    }),
  ),
});

export interface SeedProfileEntry {
  id: string;
  name: string;
  image: string;
}

/** Host-side staging dir backing a dev VM's seed mount. Lives as long as the
 * instance (bind mounts must survive stop/restart); removeSeedStaging deletes
 * it when the instance is removed. */
export function seedStagingDir(instanceId: string): string {
  return join(stateDir(), "seeds", instanceId);
}

/** Stage the seed bundle for a new dev VM: config-dir copies + the image-ref
 * manifest. Idempotent per instance (a leftover dir from a crashed create is
 * replaced). Returns the staging dir to bind-mount at SEED_MOUNT. */
export function stageSeed(instanceId: string, entries: readonly SeedProfileEntry[]): string {
  const root = seedStagingDir(instanceId);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, PROFILES_SUBDIR), { recursive: true });
  const manifest: z.infer<typeof seedManifestSchema> = { version: 1, profiles: {} };
  for (const entry of entries) {
    cpSync(profileDir(entry.id), join(root, PROFILES_SUBDIR, entry.id), { recursive: true });
    manifest.profiles[entry.id] = { name: entry.name, image: entry.image };
  }
  writeFileSync(join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

export function removeSeedStaging(instanceId: string): void {
  rmSync(seedStagingDir(instanceId), { recursive: true, force: true });
}

/** Host-side boot sweep: drop staging dirs whose instance no longer exists (a
 * crash between staging and the instance insert, or a missed removal). Keeps
 * every live instance's dir — archived ones included, their mounts must
 * survive until the instance is deleted. */
export function sweepSeedStaging(liveInstanceIds: ReadonlySet<string>): void {
  const root = join(stateDir(), "seeds");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // no seeds dir → nothing staged, nothing to sweep
  }
  for (const entry of entries) {
    if (liveInstanceIds.has(entry)) continue;
    try {
      rmSync(join(root, entry), { recursive: true, force: true });
      console.log(`[seed] swept orphaned staging dir ${entry}`);
    } catch (err) {
      console.warn(`[seed] sweeping staging dir ${entry} failed:`, err);
    }
  }
}

/** Guest-side import, run between createDb and ProfileManager construction so
 * the seeded rows exist BEFORE reconcile() runs (it leaves known rows alone,
 * and its boot GC then naturally includes the seeded refs in this instance's
 * keep-set registration). No-op unless the seed mount is present.
 *
 * Import rules, chosen so repeated boots (`bun --watch` restarts the nested
 * server constantly) never clobber in-guest work:
 *   - config dir: copied only if absent (edits inside the guest survive).
 *   - DB row: inserted only if absent (a rebuild inside the guest that
 *     memoized a NEWER ref is never downgraded back to the seeded one).
 * Both live in the guest overlay, so they persist or vanish together; a fresh
 * dev VM imports everything, an established one imports nothing. */
export function importSeedProfiles(db: Db, mountDir: string = SEED_MOUNT): void {
  const manifestPath = join(mountDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return;

  let manifest: z.infer<typeof seedManifestSchema>;
  try {
    manifest = seedManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (err) {
    console.warn(`[seed] unreadable manifest at ${manifestPath}; skipping import:`, err);
    return;
  }

  for (const [id, entry] of Object.entries(manifest.profiles)) {
    // The manifest sits on a guest-writable mount; validate ids so a mangled
    // file can't write outside the profiles root. (Authorization never derives
    // from this file — the host's grant is the persisted instance row.)
    if (!isValidName(id)) {
      console.warn(`[seed] skipping profile with invalid id: ${JSON.stringify(id)}`);
      continue;
    }
    const bundleDir = join(mountDir, PROFILES_SUBDIR, id);
    if (!existsSync(bundleDir)) {
      console.warn(`[seed] manifest lists ${id} but the bundle has no config dir; skipping`);
      continue;
    }
    try {
      if (!existsSync(profileDir(id))) {
        cpSync(bundleDir, profileDir(id), { recursive: true });
      }
      db.insert(schema.profiles)
        .values({ id, name: entry.name, image: entry.image, status: "ready" })
        .onConflictDoNothing()
        .run();
      console.log(`[seed] imported profile ${id} (image ${entry.image})`);
    } catch (err) {
      console.warn(`[seed] importing profile ${id} failed:`, err);
    }
  }
}
