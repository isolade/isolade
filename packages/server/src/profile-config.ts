import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  internetAccessSchema,
  type SecretInjectMode,
  secretDeclarationSchema,
  secretInjectModeSchema,
} from "@isolade/shared";
import { z } from "zod";
import { cacheDir, configDir } from "./xdg";

// Build-stage aliases the server injects when assembling the final Dockerfile
// (see assembleDockerfile in build-context.ts). Exported as the single source of
// truth so the assembler emits these exact strings and the repo-name validation
// below reserves them.
export const ASSEMBLED_USER_STAGE = "isolade_base";
export const ASSEMBLED_LAYER_STAGE = "isolade_final";

// Repo names a user may not take. Each shares buildkit's `COPY --from=` / `FROM`
// resolution namespace with named contexts and would collide: `context` and
// `dockerfile` are the buildkit `--local` names (the main build context and the
// Dockerfile), and the two stage aliases above are stages the server injects.
// Build stages and `--local`s both win over a same-named context, so a repo
// taking one of these names would be silently unreachable. We can't reserve
// base-image names (`ubuntu`, `node`, …): a named context shadows `FROM <name>`,
// but there's no finite list to check against, so don't name a repo after a
// base image.
const RESERVED_REPO_NAMES = new Set<string>([
  "context",
  "dockerfile",
  ASSEMBLED_USER_STAGE,
  ASSEMBLED_LAYER_STAGE,
]);

// Repo name: the repo's identity. It becomes the buildkit context name the user
// Dockerfile COPYs from (`COPY --from=<name>`), the per-repo checkout directory,
// and the dedup key. The name must *already* be a valid Docker context-name
// component (lowercase alphanumeric with single `.`/`-`/`_` separators), and we
// reject anything that isn't rather than silently rewriting it, so the `name` in
// config matches the context the user types verbatim in their Dockerfile.
const repoNameSchema = z
  .string()
  .min(1)
  .refine((n) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(n), {
    message:
      'repo name must be lowercase alphanumeric with single ".", "-" or "_" ' +
      'separators (e.g. "my-repo", "internal-tools")',
  })
  .refine((n) => !RESERVED_REPO_NAMES.has(n), {
    message:
      `repo name is reserved (collides with a buildkit context or stage): ` +
      [...RESERVED_REPO_NAMES].join(", "),
  });

const repoConfigSchema = z
  .object({
    name: repoNameSchema,
    source: z.string().min(1),
    branch: z.string().min(1).optional(),
  })
  .strict();

const buildConfigSchema = z
  .object({
    dockerfile: z.string().min(1),
    // Skill packages installed into the agent layer with `npx skills add` for
    // both codex and claude (e.g. `["owner/skills"]`). Each entry is passed
    // verbatim to the `skills` CLI. Supports the same shorthands it does
    // (owner/repo, https URL, etc.). Installed at build time, so it belongs to
    // the build definition alongside the Dockerfile.
    skills: z.array(z.string().min(1)).default([]),
  })
  .strict();

// Cache mounts must be HOME-rooted: bind-mounting at the tool's default
// $HOME-relative path means we don't need to set CCACHE_DIR/GOCACHE/etc. in
// the VM env (where nix-direnv shellHooks could rewrite them). The slug we
// derive from the path is what shows up on the host under
// <XDG cache>/isolade/caches/<profileId>/<slug>.
const cachePathSchema = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("~/") || p.startsWith("$HOME/"), {
    message: "cache paths must start with ~/ or $HOME/",
  })
  .refine((p) => !p.split("/").some((seg) => seg === ".."), {
    message: "cache paths must not contain ..",
  });

// Each entry *declares* one secret the profile wants exposed inside the VM
// as an env var. The value is not configured here. Users enter it in the
// Settings UI, and it's stored per-profile in an on-disk secrets file (see
// secrets-store.ts). At VM-create time, a declared secret with a stored value
// is registered with microsandbox. One without a value is simply skipped.
//
// `inject` (default "headers", see SECRET_INJECT_MODES) selects how the value
// reaches the guest:
//   headers / full: microsandbox's proxy substitutes the value into outgoing
//     requests bound for `hosts` (headers only, or anywhere in the request). The
//     real value never enters the VM. `hosts` lists exact or `*`-wildcard
//     patterns (e.g. "api.example.com", "*.example.com") and at least one is
//     required, and we deliberately don't expose `allow_any_host`.
//   env: the real value is injected as a plain guest env var. `hosts` doesn't
//     apply (the proxy isn't involved) and must be omitted.
const secretConfigSchema = z
  .object({
    env: z
      .string()
      .min(1)
      .refine((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s), {
        message: "env must be a valid POSIX env var name",
      }),
    hosts: z.array(z.string().min(1)).default([]),
    inject: secretInjectModeSchema.default("headers"),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.inject === "env") {
      if (entry.hosts.length > 0)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hosts"],
          message: "hosts don't apply to env-injected secrets",
        });
    } else if (entry.hosts.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hosts"],
        message: "at least one host is required",
      });
    }
  });

// The whole of a profile's identity now lives in the same config.toml as its
// build definition, one table each, so the profile is a single git-checkable,
// UI-editable file (no more sibling *.json). None of these are secret (secret
// VALUES and auth tokens stay under the data dir); they're read/written
// comment-preservingly through config-editor by their respective stores.

// [network]: the sandbox network posture applied to every instance VM. Mirrors
// the API-facing networkConfigSchema (@isolade/shared) but in config.toml's
// snake_case; NetworkConfigStore maps between the two.
export const networkTableSchema = z
  .object({
    internet: internetAccessSchema.default("open"),
    allowed_domains: z.array(z.string().min(1)).default([]),
    allow_local_network: z.boolean().default(false),
    allow_host: z.boolean().default(false),
    // Guest TCP ports forwarded to the host loopback on instance create.
    ports: z.array(z.number().int().positive()).default([]),
    // Host bridge TCP ports the instance VM is allowed to reach. Each entry
    // becomes one allow-egress rule for `host.microsandbox.internal:<port>`
    // in the network policy. By default the VM cannot reach any host port.
    host_ports: z.array(z.number().int().positive()).default([]),
  })
  .strict();

// [appearance]: theme, fonts, and the debug toggle — per-profile UI
// preferences, server-persisted so they follow the profile across machines.
// Snake_case counterpart of the API's appearanceSchema.
export const appearanceTableSchema = z
  .object({
    theme: z.string().min(1).optional(),
    font_agent: z.string().min(1).optional(),
    font_user: z.string().min(1).optional(),
    debug: z.boolean().optional(),
  })
  .strict();

// [models]: per-profile model catalog overrides, a sparse map of model id →
// override object holding only deltas from the catalog defaults (see
// shared/catalog.ts). Model ids contain dots, so they're stored (and
// round-tripped) as quoted keys, e.g. `"gpt-5.4" = { tier = "hidden" }`. The
// value is a table (not a bare string) so per-model settings can be added
// later, but it's validated strictly like every other table here: an unknown
// field is a hard error rather than being silently kept. Adding a per-model
// setting therefore means extending this schema, and a config that uses one
// won't load on an older isolade that doesn't know it.
export const modelsTableSchema = z.record(
  z.string(),
  z.object({ tier: z.enum(["default", "more", "hidden"]).optional() }).strict(),
);

// [git]: committer identity + optional agent commit-signing, flattened into one
// table (see git-config-store.ts). `signing_socket` is machine-specific and
// simply won't resolve on another machine, leaving signing off until
// reconfigured there. The private key never leaves the SSH agent; only the
// public key line is recorded.
export const gitTableSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    signing_enabled: z.boolean().default(false),
    signing_socket: z.string().min(1).optional(),
    signing_key: z.string().min(1).optional(),
  })
  .strict();

// A phase of commands run inside the booted instance VM, after credential/git
// setup, with the profile's secrets, caches, network policy, and the built
// `/workspace` all in place. Each entry is a full `/bin/sh -c` line run from
// `/workspace`.
//
//   sync:  run sequentially in declared order. Each must exit 0 before the
//           next. The instance stays `initializing` (chat turns wait) until
//           they all pass. The first failure lands it in `error`.
//   async: fired in parallel and never gate. The instance is chat-ready
//           immediately and a failure is logged, not fatal.
const initPhaseSchema = z
  .object({
    sync: z.array(z.string().min(1)).default([]),
    async: z.array(z.string().min(1)).default([]),
  })
  .strict();

// [runtime]: the per-instance runtime posture — host-backed cache mounts and
// the two lifecycle phases — grouped in one table (the Runtime settings
// section). `setup` and `start` are inline sub-tables ({ sync = […], async =
// […] }), matching how [models] entries render, so the whole runtime posture
// stays in a single comment-preservable `[runtime]` table.
//
//   setup: one-time provisioning, run the first time the VM is created. The
//     disk persists across restarts (writes land on a writable overlay), so it
//     never re-runs. The runtime counterpart to a Dockerfile `RUN`, which runs
//     at build time in BuildKit without the profile's secrets/caches/network.
//   start: run on every VM boot (create AND restart, not a plain re-attach). A
//     stop kills the guest's processes, so use it for things that must come
//     back after a restart: daemons, dev servers, background workers.
export const runtimeTableSchema = z
  .object({
    caches: z.array(cachePathSchema).default([]),
    setup: initPhaseSchema.optional(),
    start: initPhaseSchema.optional(),
  })
  .strict();

// [prompt]: chat augmentation. `prelude` is prepended (invisibly) to the first
// user message of every new chat in this profile — the DB stores the original
// content; only the message sent to the chat backend is augmented.
export const promptTableSchema = z
  .object({
    prelude: z.string().optional(),
  })
  .strict();

export const profileConfigSchema = z
  .object({
    // Display name. Optional so a freshly-created (name-only) or hand-authored
    // config still validates; listing falls back to the directory slug.
    name: z.string().min(1).optional(),
    // The build definition. `build` alone makes a profile buildable (see
    // loadProfileConfig); it's optional so a config that only carries identity
    // (name/git/network/appearance) is still valid. `repos` is optional too: a
    // Dockerfile-only profile (empty `/workspace`, the agent clones what it
    // needs) builds fine, since each repo is just an extra BuildKit context the
    // Dockerfile may COPY from.
    repos: z.array(repoConfigSchema).default([]),
    build: buildConfigSchema.optional(),
    // Profile identity, folded in from the former sibling git/network/appearance
    // JSON files. Read/written by their stores, ignored by the build path.
    git: gitTableSchema.optional(),
    network: networkTableSchema.optional(),
    appearance: appearanceTableSchema.optional(),
    models: modelsTableSchema.optional(),
    // The per-instance runtime posture (caches + setup/start lifecycle) and the
    // chat prelude, each in its own table so the Runtime and Prompt settings
    // sections own one construct apiece (like [git]/[network]/[appearance]).
    runtime: runtimeTableSchema.optional(),
    prompt: promptTableSchema.optional(),
    // DEV-ONLY, DANGEROUS: expose the host's in-process sandbox API inside the VM
    // (for developing isolade within isolade). The VM's isolade server reaches it
    // at ISOLADE_SANDBOX_URL over a per-connection exec-stream relay, with no host
    // port, no network-policy hole (see sandbox-forward.ts). A guest that can
    // drive the host sandbox can drive the host's whole VM fleet, so this is
    // never on by default and only honored when the host runs its own in-process
    // sandbox (an external-sandbox isolade can't serve it). Applies to instances
    // CREATED while set: the URL is baked into the VM's persisted env at create
    // (and the resolution onto the instance row), so toggling it does not change
    // existing instances. Recreate them to pick up the new value.
    expose_sandbox: z.boolean().default(false),
    // DEV-ONLY, requires expose_sandbox: host profile ids seeded into the
    // nested isolade at instance create — their config dirs plus their built
    // image refs (valid in the shared sandbox cache), so the nested instance
    // starts with runnable profiles and no rebuild. Snapshot at create; no
    // auth tokens or secret values ride along (see seed.ts). Like
    // expose_sandbox, the grant is frozen per instance at create.
    seed_profiles: z.array(z.string().min(1)).default([]),
    secrets: z.array(secretConfigSchema).default([]),
  })
  .strict();

function expandHomePath(input: string): string {
  return input.replace(/^~(?=\/|$)/, homedir());
}

function assertDirectory(path: string, label: string) {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

function assertFile(path: string, label: string) {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
}

// A profile is the whole unit (identity + a single build definition). Its
// identity is the directory slug under configDir()/profiles/<id>/. Both its
// display name and build definition live in the one config.toml in that dir.
export interface ProfileEntry {
  id: string;
  name: string;
}

export type RepoSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; branch?: string; checkoutPath: string };

export interface GitRemoteSpec {
  url: string;
}

export interface CacheMount {
  /** Guest-side path with leading `~/` preserved for late HOME resolution. */
  guestPath: string;
  /** Absolute host directory backing the mount. */
  hostPath: string;
}

export interface SecretDeclaration {
  /** Env var name exposed inside the guest. For the proxy modes this is a
   * placeholder whose value never enters the VM. For `env` it holds the real
   * value. */
  env: string;
  /** Hosts the proxy may substitute the value into. `*` wildcards allowed.
   * Empty for the `env` mode, where host scoping doesn't apply. */
  hosts: string[];
  /** How the value is delivered to the guest (see SECRET_INJECT_MODES):
   * `headers` (proxy, headers only), `full` (proxy, whole request), or `env`
   * (real value injected as a guest env var). */
  inject: SecretInjectMode;
}

export interface ResolvedRepo {
  /**
   * Repo identity. Shipped to the builder as the named context `<name>` (the
   * user Dockerfile COPYs from it and decides where to place it). Also the
   * per-repo checkout dir key and the dedup key.
   */
  name: string;
  source: RepoSource;
  /** Absolute host directory holding the working tree (local source or cached git checkout). */
  sourcePath: string;
}

// A profile's fully-resolved config, parsed from its config.toml: the
// container/build definition (repos, Dockerfile, caches, secrets, lifecycle
// commands) that its VMs are created from.
export interface ResolvedProfileConfig {
  profileId: string;
  /** Absolute path to the profile's config.toml. */
  configPath: string;
  repos: ResolvedRepo[];
  build: {
    /** Absolute host path to the Dockerfile. */
    dockerfilePath: string;
    /**
     * Absolute host path to the build context directory: the profile dir
     * itself, where config.toml and the Dockerfile live. Shipped to the builder
     * as buildkit's main context, so the user Dockerfile can `COPY` files that
     * sit beside the profile definition with ordinary relative paths.
     */
    contextDir: string;
  };
  ports: number[];
  caches: CacheMount[];
  hostPorts: number[];
  /** DEV-ONLY: expose the host's in-process sandbox API inside the VM (isolade
   * within isolade). See sandbox-forward.ts. Off unless the profile opts in. */
  exposeSandbox: boolean;
  /** DEV-ONLY: host profile ids to seed into the nested isolade (config dirs +
   * built image refs). Only meaningful with exposeSandbox. See seed.ts. */
  seedProfiles: string[];
  /** Prepended to the first user message of every new chat. */
  prelude: string | null;
  /** Skill packages to install via `npx skills add` in the agent layer. */
  skills: string[];
  /** Secrets the profile declares. Values are supplied separately from the store. */
  secrets: SecretDeclaration[];
  /** Lifecycle commands run in the booted VM (see initPhaseSchema). Both phases
   * are always present with empty arrays when the profile declares neither.
   *   setup: once, at VM create.
   *   start: on every VM boot (create + restart). */
  init: {
    setup: { sync: string[]; async: string[] };
    start: { sync: string[]; async: string[] };
  };
}

// Profile ids share this restricted alphabet (also the on-disk dir slug).
const NAME_RE = /^[a-zA-Z0-9_.-]+$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

function profilesRoot(): string {
  return join(configDir(), "profiles");
}

export function profileDir(profileId: string): string {
  return join(profilesRoot(), profileId);
}

// Everything about a profile — its display name, identity (git/network/
// appearance) and build definition — lives in this one file.
export function profileConfigPath(profileId: string): string {
  return join(profileDir(profileId), "config.toml");
}

// Parse a profile's config.toml against the (lenient) schema, or null when it's
// absent / unparseable / invalid. The single read path for the name+identity
// accessors below, so a corrupt file degrades to defaults everywhere rather
// than throwing in listing/status code.
export function readProfileConfig(profileId: string): z.infer<typeof profileConfigSchema> | null {
  const p = profileConfigPath(profileId);
  if (!existsSync(p)) return null;
  try {
    return profileConfigSchema.parse(Bun.TOML.parse(readFileSync(p, "utf-8")) ?? {});
  } catch {
    return null;
  }
}

// "Buildable" — the config carries a build definition (a `[build]`), the
// precondition loadProfileConfig enforces. Repos are optional (a Dockerfile-only
// profile is buildable). A name-only / identity-only config exists but isn't yet
// runnable.
export function profileHasConfig(profileId: string): boolean {
  return !!readProfileConfig(profileId)?.build;
}

// The profile's display name from config.toml, or null when unset/unparseable
// (listProfiles falls back to the directory slug).
export function readProfileName(profileId: string): string | null {
  return readProfileConfig(profileId)?.name ?? null;
}

function gitCheckoutPath(profileId: string, repoName: string, repoUrl: string): string {
  // One checkout per repository, not per branch: the key intentionally omits
  // the branch so that switching branches reuses (and switches in place) the
  // same working tree rather than cloning a fresh copy. ensureGitCheckout
  // handles the in-place branch switch via `checkout -B` + `reset --hard`.
  const key = `${repoName}\0${repoUrl}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(cacheDir(), "checkouts", profileId, `${repoName}-${hash}`);
}

// Strips the HOME prefix and turns the rest of the path into a single
// directory name. `~/.cache/ccache` → `.cache__ccache`. The choice of `__`
// as separator means the slug round-trips back to the original path
// unambiguously, which makes it easy to render in the UI later.
function cacheSlug(guestPath: string): string {
  const stripped = guestPath.replace(/^~\//, "").replace(/^\$HOME\//, "");
  return stripped.replace(/\/+/g, "__");
}

function profileCacheRoot(profileId: string): string {
  return join(cacheDir(), "caches", profileId);
}

function resolveSecretDeclarations(
  entries: readonly z.infer<typeof secretConfigSchema>[],
): SecretDeclaration[] {
  const seen = new Set<string>();
  const out: SecretDeclaration[] = [];
  for (const entry of entries) {
    if (seen.has(entry.env)) {
      throw new Error(`duplicate secret env: ${entry.env}`);
    }
    seen.add(entry.env);
    out.push({ env: entry.env, hosts: [...entry.hosts], inject: entry.inject });
  }
  return out;
}

function resolveCacheMounts(profileId: string, paths: readonly string[]): CacheMount[] {
  const root = profileCacheRoot(profileId);
  const seen = new Set<string>();
  const out: CacheMount[] = [];
  for (const guestPath of paths) {
    const slug = cacheSlug(guestPath);
    if (!slug || slug === "." || slug === "..") {
      throw new Error(`invalid cache path: ${guestPath}`);
    }
    if (seen.has(slug)) {
      throw new Error(`duplicate cache path: ${guestPath}`);
    }
    seen.add(slug);
    out.push({ guestPath, hostPath: join(root, slug) });
  }
  return out;
}

// Accepts:
//   * https://github.com/owner/repo
//   * https://github.com/owner/repo.git
//   * github.com/owner/repo
//   * file:///abs/path/to/repo
// Branch is configured via the separate `branch` TOML field.
export function parseGitRemoteUrl(input: string): GitRemoteSpec | null {
  const candidate = input.startsWith("github.com/") ? `https://${input}` : input;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol === "file:") {
    if (!url.pathname || url.pathname === "/") return null;
    return { url: `file://${url.pathname}` };
  }

  if (!["https:", "http:"].includes(url.protocol)) return null;
  if (url.hostname !== "github.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  // Reject anything past owner/repo, since we no longer parse /tree/<branch>.
  if (parts.length > 2) return null;

  return { url: `https://github.com/${owner}/${repo}.git` };
}

// Every directory under configDir()/profiles/ that looks like a profile id.
// A profile dir is registered whether or not it has a config.toml (the display
// name falls back to the dir slug) so a hand-created profile dir works.
export function listProfiles(): ProfileEntry[] {
  const root = profilesRoot();
  if (!existsSync(root)) return [];
  const out: ProfileEntry[] = [];
  for (const id of readdirSync(root).toSorted()) {
    if (id.startsWith(".")) continue;
    if (!NAME_RE.test(id)) continue;
    let stat: Stats;
    try {
      stat = statSync(join(root, id));
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    out.push({ id, name: readProfileName(id) ?? id });
  }
  return out;
}

function resolveRepoSource(
  profileId: string,
  profileDirPath: string,
  raw: z.infer<typeof repoConfigSchema>,
): ResolvedRepo {
  const name = raw.name;
  const remote = parseGitRemoteUrl(raw.source);
  if (remote) {
    const checkoutPath = gitCheckoutPath(profileId, name, remote.url);
    return {
      name,
      source: {
        kind: "git",
        url: remote.url,
        branch: raw.branch,
        checkoutPath,
      },
      sourcePath: checkoutPath,
    };
  }
  if (raw.branch !== undefined) {
    throw new Error(`branch is only valid for git sources: ${raw.source}`);
  }
  const expanded = expandHomePath(raw.source);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(profileDirPath, expanded);
  return {
    name,
    source: { kind: "local", path: abs },
    sourcePath: abs,
  };
}

export function loadProfileConfig(profileId: string): ResolvedProfileConfig {
  const configPath = profileConfigPath(profileId);
  const profileDirPath = dirname(configPath);
  try {
    assertFile(configPath, "config file");
    const content = readFileSync(configPath, "utf-8");
    const rawConfig = Bun.TOML.parse(content) ?? {};
    const config = profileConfigSchema.parse(rawConfig);

    // `build` is schema-optional (a config may carry only identity), but the
    // build path needs it. A profile without it is not yet buildable. `repos`
    // may be empty — a Dockerfile-only profile is valid.
    if (!config.build) {
      throw new Error("profile has no build definition yet (needs a [build])");
    }
    const build = config.build;

    const repos: ResolvedRepo[] = [];
    const seenNames = new Set<string>();
    for (const raw of config.repos) {
      const repo = resolveRepoSource(profileId, profileDirPath, raw);
      if (seenNames.has(repo.name)) {
        throw new Error(`duplicate repo name: ${repo.name}`);
      }
      seenNames.add(repo.name);
      repos.push(repo);
    }

    // Dockerfile resolves relative to the profile dir. Users drop the
    // Dockerfile next to config.toml.
    const dockerfileInput = expandHomePath(build.dockerfile);
    const dockerfilePath = isAbsolute(dockerfileInput)
      ? resolve(dockerfileInput)
      : resolve(profileDirPath, dockerfileInput);
    assertFile(dockerfilePath, "build dockerfile");

    // Validate local repo paths eagerly. Git checkouts are validated post-sync
    // by requirePreparedProfileSource so the user can edit config and
    // rebuild before the checkout exists.
    for (const repo of repos) {
      if (repo.source.kind === "local") {
        validateLocalRepoSource(repo.sourcePath);
      }
    }

    return {
      profileId,
      configPath,
      repos,
      build: { dockerfilePath, contextDir: profileDirPath },
      ports: config.network?.ports ?? [],
      caches: resolveCacheMounts(profileId, config.runtime?.caches ?? []),
      hostPorts: config.network?.host_ports ?? [],
      exposeSandbox: config.expose_sandbox,
      seedProfiles: config.seed_profiles,
      prelude: config.prompt?.prelude || null,
      skills: build.skills,
      secrets: resolveSecretDeclarations(config.secrets),
      init: {
        setup: {
          sync: config.runtime?.setup?.sync ?? [],
          async: config.runtime?.setup?.async ?? [],
        },
        start: {
          sync: config.runtime?.start?.sync ?? [],
          async: config.runtime?.start?.async ?? [],
        },
      },
    };
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Invalid isolade config at ${configPath}: ${err.message}`, {
        cause: err,
      });
    }
    throw new Error(`Invalid isolade config at ${configPath}`, { cause: err });
  }
}

function validateLocalRepoSource(sourcePath: string) {
  assertDirectory(sourcePath, "source path");
  if (!existsSync(resolve(sourcePath, ".git"))) {
    throw new Error(`source path is not a Git checkout: ${sourcePath}`);
  }
}

async function runGit(args: string[], cwd?: string, log?: (msg: string) => void): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let stdoutBuf = "";
  let stderrBuf = "";
  const consume = async (stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      onChunk(text);
      if (!log) continue;
      // Git uses \r for in-place progress updates, so split on both so each
      // refresh becomes a separate log line.
      pending += text;
      const lines = pending.split(/\r\n|\r|\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) log(trimmed);
      }
    }
    if (log) {
      const trimmed = pending.trim();
      if (trimmed) log(trimmed);
    }
  };
  const [code] = await Promise.all([
    proc.exited,
    consume(proc.stdout, (t) => {
      stdoutBuf += t;
    }),
    consume(proc.stderr, (t) => {
      stderrBuf += t;
    }),
  ]);
  if (code !== 0) {
    const detail = stderrBuf.trim() || stdoutBuf.trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return stdoutBuf.trim();
}

async function ensureGitCheckout(
  source: Extract<RepoSource, { kind: "git" }>,
  log?: (msg: string) => void,
) {
  const branchSuffix = source.branch ? ` (branch ${source.branch})` : "";
  const branchArgs = source.branch ? ["--branch", source.branch] : [];
  if (!existsSync(resolve(source.checkoutPath, ".git"))) {
    log?.(`Cloning ${source.url}${branchSuffix} into ${source.checkoutPath}`);
    const startedAt = Date.now();
    await rm(source.checkoutPath, { recursive: true, force: true });
    await mkdir(dirname(source.checkoutPath), { recursive: true });
    await runGit(
      ["clone", "--progress", ...branchArgs, source.url, source.checkoutPath],
      undefined,
      log,
    );
    log?.(`Clone finished in ${formatDuration(Date.now() - startedAt)}: ${source.url}`);
    await syncSubmodules(source.checkoutPath, source.url, log);
    return;
  }

  log?.(`Updating ${source.url}${branchSuffix} in ${source.checkoutPath}`);
  const startedAt = Date.now();
  // Deepen previously-shallow caches in place so the rest of the update path
  // (and downstream consumers) see full history. `--unshallow` is a no-op on
  // already-complete repos but errors on them, so gate on .git/shallow.
  if (existsSync(resolve(source.checkoutPath, ".git/shallow"))) {
    log?.(`Unshallowing existing checkout: ${source.checkoutPath}`);
    await runGit(["fetch", "--progress", "--unshallow", "origin"], source.checkoutPath, log);
  }
  if (source.branch) {
    await runGit(
      ["fetch", "--progress", "--prune", "origin", source.branch],
      source.checkoutPath,
      log,
    );
    await runGit(
      ["checkout", "-B", source.branch, `refs/remotes/origin/${source.branch}`],
      source.checkoutPath,
    );
    await runGit(["reset", "--hard", `refs/remotes/origin/${source.branch}`], source.checkoutPath);
  } else {
    // No branch configured → track the remote's *default* branch. We must not
    // derive it from the checkout's current upstream (@{u}): the cache is keyed
    // per-repo, not per-branch, so a checkout left on a previously-configured
    // branch would stick to it instead of following the default. Worse, if that
    // branch was deleted upstream, `--prune` drops its tracking ref and the
    // reset fails outright. Resolve origin/HEAD instead, refreshing it first so
    // a default-branch rename on the remote is picked up.
    await runGit(["fetch", "--progress", "--prune", "origin"], source.checkoutPath, log);
    await runGit(["remote", "set-head", "origin", "--auto"], source.checkoutPath, log);
    const defaultRef = await runGit(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      source.checkoutPath,
    );
    const defaultBranch = defaultRef.replace(/^origin\//, "");
    await runGit(
      ["checkout", "-B", defaultBranch, `refs/remotes/origin/${defaultBranch}`],
      source.checkoutPath,
    );
    await runGit(["reset", "--hard", `refs/remotes/origin/${defaultBranch}`], source.checkoutPath);
  }
  await runGit(["clean", "-fdx"], source.checkoutPath);
  log?.(`Update finished in ${formatDuration(Date.now() - startedAt)}: ${source.url}`);
  await syncSubmodules(source.checkoutPath, source.url, log);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

// Always pull submodules. This matches `git clone --recurse-submodules` muscle
// memory, and the build pipeline wants the worktrees on disk so they end up
// in the build context tar. `.gitmodules` `shallow = true` flags are honored
// by git automatically, so the bundle-only deps (folly, CAF, …) clone cheaply.
// Auth comes from the host: `git` inherits HOME / SSH_AUTH_SOCK, so private
// submodules resolve via the same credentials the user would use manually.
// On failure, runGit surfaces git's stderr verbatim, usually the actionable
// auth error.
async function syncSubmodules(
  repoPath: string,
  parentUrl: string,
  log?: (msg: string) => void,
): Promise<void> {
  if (!existsSync(resolve(repoPath, ".gitmodules"))) return;
  log?.(`Syncing submodules for ${parentUrl}`);
  const startedAt = Date.now();
  await runGit(
    ["submodule", "update", "--init", "--recursive", "--progress", "--jobs=4"],
    repoPath,
    log,
  );
  log?.(`Submodule sync finished in ${formatDuration(Date.now() - startedAt)}: ${parentUrl}`);
}

function validatePreparedRepo(repo: ResolvedRepo) {
  if (repo.source.kind === "git") {
    if (!existsSync(resolve(repo.sourcePath, ".git"))) {
      throw new Error(`git checkout is missing; rebuild the profile first: ${repo.sourcePath}`);
    }
  }
  validateLocalRepoSource(repo.sourcePath);
}

export async function syncProfileSource(
  profileId: string,
  log?: (msg: string) => void,
): Promise<ResolvedProfileConfig> {
  const config = loadProfileConfig(profileId);
  for (const repo of config.repos) {
    if (repo.source.kind === "git") {
      await ensureGitCheckout(repo.source, log);
      validatePreparedRepo(repo);
    }
  }
  await ensureCacheDirs(config.caches);
  return config;
}

export async function ensureCacheDirs(caches: readonly CacheMount[]): Promise<void> {
  for (const cache of caches) {
    await mkdir(cache.hostPath, { recursive: true });
  }
}

export function requirePreparedProfileSource(profileId: string): ResolvedProfileConfig {
  const config = loadProfileConfig(profileId);
  for (const repo of config.repos) {
    validatePreparedRepo(repo);
  }
  return config;
}

// Render secret declarations as canonical TOML `[[secrets]]` blocks. `inject`
// defaults to "headers", so it's emitted only for the other modes, keeping the
// common case clean and round-tripping back via the schema. `env`-mode secrets
// carry no hosts, so the `hosts` line is omitted for them.
function serializeSecretBlocks(declarations: readonly SecretDeclaration[]): string {
  return declarations
    .map((d) => {
      const lines = [`[[secrets]]`, `env = ${JSON.stringify(d.env)}`];
      if (d.inject !== "env") {
        const hosts = d.hosts.map((h) => JSON.stringify(h)).join(", ");
        lines.push(`hosts = [${hosts}]`);
      }
      if (d.inject !== "headers") lines.push(`inject = ${JSON.stringify(d.inject)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// Remove every existing secret declaration from raw config.toml text (both
// `[[secrets]]` array-of-table blocks and a top-level `secrets = [ … ]`
// assignment), leaving all other content untouched. A `[[secrets]]` block runs
// from its header to the next table/array-table header (or EOF). The inline
// form is removed by balancing brackets across lines.
function stripSecretDeclarations(text: string): string {
  const lines = text.split("\n");
  const isHeader = (l: string | undefined) => l !== undefined && /^\s*\[/.test(l);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (/^\s*\[\[\s*secrets\s*\]\]/.test(line)) {
      i++;
      while (i < lines.length && !isHeader(lines[i])) i++;
      continue;
    }
    if (/^\s*secrets\s*=/.test(line)) {
      let depth = 0;
      let seen = false;
      while (i < lines.length) {
        const inner = lines[i];
        if (inner === undefined) break;
        for (const ch of inner) {
          if (ch === "[") {
            depth++;
            seen = true;
          } else if (ch === "]") {
            depth--;
          }
        }
        i++;
        if (seen && depth <= 0) break;
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// Rewrite a profile's config.toml so its declared secrets exactly match
// `declarations`. Everything else in the file is preserved. The secret blocks
// are normalized to clean `[[secrets]]` blocks at the end of the file (comments
// inside the secrets region are not preserved, since secrets are UI-managed). The
// reassembled text is re-parsed against the schema before writing, so a bad
// edit fails cleanly rather than corrupting the file.
export function writeSecretDeclarations(
  profileId: string,
  declarations: readonly SecretDeclaration[],
): void {
  // Refuse to touch a file that isn't already valid.
  loadProfileConfig(profileId);
  // Validate each incoming declaration loudly. The serializer drops hosts for
  // `env` mode, so a env-with-hosts mistake would otherwise be silently
  // normalized away instead of surfacing as an error.
  for (const d of declarations) secretDeclarationSchema.parse(d);
  const configPath = profileConfigPath(profileId);
  const raw = readFileSync(configPath, "utf-8");
  const stripped = stripSecretDeclarations(raw)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
  const blocks = serializeSecretBlocks(declarations);
  const next = blocks ? `${stripped}\n\n${blocks}\n` : `${stripped}\n`;
  // Validate the result parses and yields a well-formed secrets set (env names,
  // host counts, no duplicate env) before committing it to disk.
  const parsed = profileConfigSchema.parse(Bun.TOML.parse(next) ?? {});
  resolveSecretDeclarations(parsed.secrets);
  writeFileSync(configPath, next);
}
