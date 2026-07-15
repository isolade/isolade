import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AuthStore } from "./auth-store";
import { buildEnvironmentTar } from "./build-context";
import {
  readProfileConfigView,
  writeConfigBareKey,
  writeConfigNestedTables,
  writeConfigTable,
  writeDockerfile,
  writeProfileConfigForm,
} from "./config-editor";
import type { ModelOverrides, ProfileConfigForm, ProfileConfigView } from "./contracts";
import type { Db } from "./db";
import { schema } from "./db";
import { GitConfigManager } from "./git-config";
import { GitConfigStore } from "./git-config-store";
import { NetworkConfigStore } from "./network-config-store";
import {
  isValidName,
  listProfiles,
  loadProfileConfig,
  profileConfigPath,
  profileDir,
  profileHasConfig,
  readProfileConfig,
  type SecretDeclaration,
  syncProfileSource,
  writeSecretDeclarations,
} from "./profile-config";
import { PromptConfigStore } from "./prompt-config-store";
import { RuntimeConfigStore } from "./runtime-config-store";
import type { SandboxApi } from "./sandbox-client";
import { dataDir } from "./xdg";

// A profile is the whole unit: identity (auth/appearance/git/network/secrets)
// AND a single build definition (its config.toml). This is the shape the API
// returns: build state plus whether a config.toml has been authored yet.
export interface Profile {
  id: string;
  name: string;
  image: string | null;
  status: "pending" | "building" | "ready" | "error";
  errorMessage: string | null;
  /** Whether a config.toml exists, i.e. the profile is buildable / runnable. */
  hasConfig: boolean;
  /** Absolute path to the profile's config.toml (for display + authoring). */
  configPath: string;
  /** Time the build state was last updated. */
  createdAt: Date;
}

// Split by portability:
//   - Non-secret, machine-portable config lives under configDir()/profiles/<id>/
//     as a single git-checkable, UI-editable config.toml (plus its Dockerfile):
//     the build definition AND the profile's identity (name, [git], [network],
//     [appearance]) all in one file. The signing block records a machine-specific
//     agent socket; on another machine that socket simply won't resolve and
//     signing stays off until reconfigured.
//   - Machine-local / secret state lives under dataDir()/profiles/<id>/: auth
//     tokens (auth/) and workspace secret values (secrets.json), kept off the
//     OS keychain (see secrets-store.ts).
// (The active-profile pointer and the DB are machine-local and also stay under
// dataDir.)
function profileDataDir(profileId: string): string {
  return join(dataDir(), "profiles", profileId);
}

function profileAuthDir(profileId: string): string {
  return join(profileDataDir(profileId), "auth");
}

// Per-profile workspace-secret values (a flat { [env]: value } JSON map). See
// secrets-store.ts for why these live on disk rather than in the OS keychain.
export function profileSecretsPath(profileId: string): string {
  return join(profileDataDir(profileId), "secrets.json");
}

// A profile is "signed in" only when it holds its own credential files, written
// by the in-app login flow (auth-login.ts) — the same files bind-mounted into
// its VMs. isolade never reads credentials from the host (no keychain, no
// ~/.codex), so reported auth status always matches what a profile's VMs
// actually receive.

const appearanceSchema = z.object({
  theme: z.string().optional(),
  fontAgent: z.string().optional(),
  fontUser: z.string().optional(),
  debug: z.boolean().optional(),
});
export type Appearance = z.infer<typeof appearanceSchema>;

// The single profile-scoped manager: per-profile credential/config stores
// (cached), the active-profile pointer, profile CRUD, AND the build pipeline
// (each profile builds one image, and build state lives on the profiles row).
export class ProfileManager {
  private authStores = new Map<string, AuthStore>();
  private gitManagers = new Map<string, GitConfigManager>();
  private networkStores = new Map<string, NetworkConfigStore>();
  private runtimeStores = new Map<string, RuntimeConfigStore>();
  private promptStores = new Map<string, PromptConfigStore>();

  // Build log buffers, keyed by profile id.
  private logBuffer = new Map<string, string[]>();
  private buildsInFlight = 0;
  private readonly skipBootSandboxWork: boolean;

  constructor(
    private db: Db,
    private sandboxClient: SandboxApi,
    opts: { skipBootSandboxWork?: boolean } = {},
  ) {
    this.skipBootSandboxWork = opts.skipBootSandboxWork ?? false;
    this.reconcile();
  }

  // Bring the `profiles` table in line with ~/.config/isolade/profiles/. Each
  // profile dir registers a row, and removed dirs drop their row. Stale 'building'
  // rows (server killed mid-build) reset to pending. Builds run only via
  // rebuild(), and whatever images are registered get GC'd down at boot.
  private reconcile() {
    const onDisk = listProfiles();
    const onDiskIds = new Set(onDisk.map((p) => p.id));
    const existing = this.db.select().from(schema.profiles).all();
    const existingIds = new Set(existing.map((p) => p.id));

    for (const p of onDisk) {
      if (!existingIds.has(p.id)) {
        this.db.insert(schema.profiles).values({ id: p.id, name: p.name }).run();
      } else if (existing.find((r) => r.id === p.id)?.name !== p.name) {
        this.db
          .update(schema.profiles)
          .set({ name: p.name })
          .where(eq(schema.profiles.id, p.id))
          .run();
      }
    }
    for (const row of existing) {
      if (!onDiskIds.has(row.id)) {
        this.db.delete(schema.profiles).where(eq(schema.profiles.id, row.id)).run();
      }
    }
    this.db
      .update(schema.profiles)
      .set({ status: "pending", buildLog: null, errorMessage: null })
      .where(eq(schema.profiles.status, "building"))
      .run();

    if (this.skipBootSandboxWork) return;
    void (async () => {
      if (!(await this.sandboxClient.waitUntilReady())) return;
      this.fireGarbageCollect();
    })();
  }

  // ---- per-profile stores (cached, cheap stateless file readers) ----

  auth(profileId: string): AuthStore {
    let store = this.authStores.get(profileId);
    if (!store) {
      store = new AuthStore(profileAuthDir(profileId));
      this.authStores.set(profileId, store);
    }
    return store;
  }

  git(profileId: string): GitConfigManager {
    let mgr = this.gitManagers.get(profileId);
    if (!mgr) {
      mgr = new GitConfigManager(new GitConfigStore(profileConfigPath(profileId)));
      this.gitManagers.set(profileId, mgr);
    }
    return mgr;
  }

  network(profileId: string): NetworkConfigStore {
    let store = this.networkStores.get(profileId);
    if (!store) {
      store = new NetworkConfigStore(profileConfigPath(profileId));
      this.networkStores.set(profileId, store);
    }
    return store;
  }

  runtime(profileId: string): RuntimeConfigStore {
    let store = this.runtimeStores.get(profileId);
    if (!store) {
      store = new RuntimeConfigStore(profileConfigPath(profileId));
      this.runtimeStores.set(profileId, store);
    }
    return store;
  }

  prompt(profileId: string): PromptConfigStore {
    let store = this.promptStores.get(profileId);
    if (!store) {
      store = new PromptConfigStore(profileConfigPath(profileId));
      this.promptStores.set(profileId, store);
    }
    return store;
  }

  // ---- appearance (per-profile, in config.toml's [appearance] table) ----
  // The API shape is camelCase (Appearance); the table is config.toml snake_case.

  appearance(profileId: string): Appearance {
    const table = readProfileConfig(profileId)?.appearance;
    if (!table) return {};
    return appearanceSchema.parse({
      theme: table.theme,
      fontAgent: table.font_agent,
      fontUser: table.font_user,
      debug: table.debug,
    });
  }

  setAppearance(profileId: string, appearance: Appearance): Appearance {
    const parsed = appearanceSchema.parse(appearance);
    const table: Record<string, unknown> = {};
    if (parsed.theme !== undefined) table.theme = parsed.theme;
    if (parsed.fontAgent !== undefined) table.font_agent = parsed.fontAgent;
    if (parsed.fontUser !== undefined) table.font_user = parsed.fontUser;
    if (parsed.debug !== undefined) table.debug = parsed.debug;
    // An all-empty appearance drops the table rather than leaving it bare.
    writeConfigTable(
      profileConfigPath(profileId),
      "appearance",
      Object.keys(table).length ? table : undefined,
    );
    return parsed;
  }

  // ---- listing ----

  private hydrate(row: typeof schema.profiles.$inferSelect | undefined): Profile | undefined {
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      image: row.image,
      status: row.status,
      errorMessage: row.errorMessage,
      hasConfig: profileHasConfig(row.id),
      configPath: profileConfigPath(row.id),
      createdAt: row.updatedAt,
    };
  }

  list(): Profile[] {
    return this.db
      .select()
      .from(schema.profiles)
      .all()
      .map((row) => this.hydrate(row)!)
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Profile | undefined {
    return this.hydrate(
      this.db.select().from(schema.profiles).where(eq(schema.profiles.id, id)).get(),
    );
  }

  // ---- mutations ----

  // There is no server-side "active profile": the client (each window) names
  // the profile it's acting as on every request. This just guarantees at least
  // one profile exists so a fresh install has something to select.
  ensureDefault(): Profile {
    return this.get("default") ?? this.create("Default", "default");
  }

  create(name: string, idHint?: string): Profile {
    const id = this.uniqueSlug(idHint ?? name);
    // Seed config.toml with just the display name; the rest of the profile
    // (build definition, identity tables) is authored later through the UI.
    writeConfigBareKey(profileConfigPath(id), "name", name);
    this.db.insert(schema.profiles).values({ id, name }).run();
    return this.get(id)!;
  }

  rename(id: string, name: string): Profile {
    if (!this.get(id)) throw new Error(`profile ${id} not found`);
    writeConfigBareKey(profileConfigPath(id), "name", name);
    this.db
      .update(schema.profiles)
      .set({ name, updatedAt: new Date() })
      .where(eq(schema.profiles.id, id))
      .run();
    return this.get(id)!;
  }

  /**
   * Deep-copy a profile: everything in its config.toml (build definition plus
   * the [git]/[network]/[appearance] identity tables) and its Dockerfile, but
   * NOT its auth credentials or secret values. Auth is omitted because
   * single-use refresh tokens shared across two profiles would invalidate each
   * other. A clone is a distinct identity that signs in on its own. Secret
   * values are sensitive and profile-scoped, so they start empty (the
   * declarations come free with the copied config.toml). The clone resets to an
   * unbuilt state.
   */
  clone(srcId: string, name: string): Profile {
    if (!this.get(srcId)) throw new Error(`profile ${srcId} not found`);
    const dst = this.create(name);
    // Whole config dir (config.toml + Dockerfile). config.toml carries the git
    // identity + public signing key too (its machine-specific socket aside).
    // Auth and secret values live under the data dir and are not copied.
    cpSync(profileDir(srcId), profileDir(dst.id), { recursive: true });
    // The copy carried over the source's name; reset it to the clone's.
    writeConfigBareKey(profileConfigPath(dst.id), "name", name);
    // Build state stays at the fresh `pending` create() left, since a clone rebuilds.
    return this.get(dst.id)!;
  }

  remove(id: string): void {
    if (!this.get(id)) throw new Error(`profile ${id} not found`);
    this.db.delete(schema.profiles).where(eq(schema.profiles.id, id)).run();
    rmSync(profileDir(id), { recursive: true, force: true });
    rmSync(profileDataDir(id), { recursive: true, force: true });
    this.authStores.delete(id);
    this.gitManagers.delete(id);
    this.networkStores.delete(id);
    this.runtimeStores.delete(id);
    this.promptStores.delete(id);
  }

  // Slugify a display name into a unique, NAME_RE-valid profile id.
  private uniqueSlug(input: string): string {
    const base =
      input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-") || "profile";
    const taken = new Set(listProfiles().map((p) => p.id));
    if (isValidName(base) && !taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // ---- build pipeline (one image per profile) ----

  getLogs(id: string): string[] {
    if (this.logBuffer.has(id)) return this.logBuffer.get(id)!;
    const row = this.db.select().from(schema.profiles).where(eq(schema.profiles.id, id)).get();
    return row?.buildLog ? row.buildLog.split("\n") : [];
  }

  async rebuild(id: string): Promise<Profile> {
    const profile = this.get(id);
    if (!profile) throw new Error(`profile ${id} not found`);
    if (!profile.hasConfig) throw new Error(`profile ${id} has no config.toml to build`);
    this.logBuffer.delete(id);
    // Keep the previously-built image until the new build succeeds. This keeps
    // instance creation working during a rebuild and protects it from GC.
    this.db
      .update(schema.profiles)
      .set({ status: "building", errorMessage: null, buildLog: null })
      .where(eq(schema.profiles.id, id))
      .run();
    void this.runBuild(id);
    return this.get(id)!;
  }

  private async runBuild(id: string): Promise<void> {
    this.buildsInFlight++;
    try {
      this.emitLog(id, `=== Preparing sources ===`);
      const config = await syncProfileSource(id, (msg) => this.emitLog(id, msg));
      const repoList = config.repos.map((r) => r.name).join(", ") || "no repos";
      this.emitLog(id, `=== Building image (${repoList}) ===`);
      const tarStream = await buildEnvironmentTar(config, (msg) => this.emitLog(id, msg));
      const imageId = await this.sandboxClient.build(tarStream, (line) => this.emitLog(id, line));
      this.emitLog(id, `\n=== Build complete ===`);
      this.db
        .update(schema.profiles)
        .set({
          status: "ready",
          image: imageId,
          errorMessage: null,
        })
        .where(eq(schema.profiles.id, id))
        .run();
      this.flushLog(id);
    } catch (err) {
      this.emitLog(id, `\n=== Build failed: ${String(err)} ===`);
      this.db
        .update(schema.profiles)
        .set({ status: "error", errorMessage: String(err) })
        .where(eq(schema.profiles.id, id))
        .run();
      this.flushLog(id);
    } finally {
      this.buildsInFlight--;
      if (this.buildsInFlight === 0) this.fireGarbageCollect();
    }
  }

  private emitLog(id: string, line: string) {
    if (!this.logBuffer.has(id)) this.logBuffer.set(id, []);
    this.logBuffer.get(id)!.push(line);
  }

  private flushLog(id: string) {
    this.db
      .update(schema.profiles)
      .set({ buildLog: (this.logBuffer.get(id) ?? []).join("\n") })
      .where(eq(schema.profiles.id, id))
      .run();
  }

  // Keep only the newest image of each profile plus any image still in use by a
  // live instance, and drop the rest. Unions across ALL profiles + instances so a
  // background profile's image isn't pruned from under a running VM.
  private fireGarbageCollect() {
    const fromProfiles = this.db
      .select({ image: schema.profiles.image })
      .from(schema.profiles)
      .all()
      .map((p) => p.image);
    const fromInstances = this.db
      .select({ image: schema.instances.image })
      .from(schema.instances)
      .all()
      .map((r) => r.image);
    const keep = [
      ...new Set([...fromProfiles, ...fromInstances].filter((img): img is string => !!img)),
    ];
    this.sandboxClient.garbageCollect(keep).catch((err) => {
      console.warn("[profiles] registry gc failed:", err);
    });
  }

  // ---- model overrides (per-profile, in config.toml's [models] tables) ----
  // A sparse map of model id → override object holding only deltas from the
  // catalog defaults, so catalog changes to untouched models flow through (see
  // shared/catalog.ts). Each entry is its own `[models."<id>"]` sub-table (ids
  // contain dots, hence quoted keys), so per-model settings beyond `tier` can be
  // added later without a format change.

  modelOverrides(profileId: string): ModelOverrides {
    const table = readProfileConfig(profileId)?.models;
    return table ? { ...table } : {};
  }

  setModelOverrides(profileId: string, overrides: ModelOverrides): ModelOverrides {
    // An empty map drops the section rather than leaving bare `[models…]` tables.
    writeConfigNestedTables(
      profileConfigPath(profileId),
      "models",
      Object.keys(overrides).length ? overrides : undefined,
    );
    return overrides;
  }

  // ---- config-derived reads ----

  /** The optional `prelude` from config.toml, prepended to the first message
   * of every new chat. Null when unset or unconfigured. */
  getPrelude(id: string): string | null {
    if (!profileHasConfig(id)) return null;
    try {
      return loadProfileConfig(id).prelude;
    } catch {
      return null;
    }
  }

  /** Secret declarations from config.toml (env var name + host scoping). Empty
   * when the profile has no config.toml yet. */
  getSecretDeclarations(id: string): SecretDeclaration[] {
    if (!profileHasConfig(id)) return [];
    return loadProfileConfig(id).secrets;
  }

  /** Rewrite config.toml so its declared secrets match `declarations`. Values
   * are unaffected (kept per-profile in the on-disk secrets store). */
  setSecretDeclarations(id: string, declarations: SecretDeclaration[]): void {
    if (!this.get(id)) throw new Error(`profile ${id} not found`);
    writeSecretDeclarations(id, declarations);
  }

  // ---- profile config editing (config.toml + Dockerfile) ----
  // The build definition, editable from the UI. The structured form write goes
  // through config-editor, which preserves comments and re-validates before
  // touching disk. Secrets stay owned by the methods above.

  /** Everything the Configuration and Dockerfile sections need: the structured
   * form (or a parse error) and the resolved Dockerfile. */
  readConfigView(id: string): ProfileConfigView {
    if (!this.get(id)) throw new Error(`profile ${id} not found`);
    return readProfileConfigView(id);
  }

  /** Persist the structured form back to config.toml, preserving comments. */
  writeConfigForm(id: string, form: ProfileConfigForm): ProfileConfigView {
    if (!this.get(id)) throw new Error(`profile ${id} not found`);
    writeProfileConfigForm(id, form);
    return readProfileConfigView(id);
  }

  /** Persist the profile's Dockerfile (must live under the profile dir). */
  writeDockerfile(id: string, content: string): void {
    if (!this.get(id)) throw new Error(`profile ${id} not found`);
    writeDockerfile(id, content);
  }
}
