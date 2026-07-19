import { z } from "zod";
import {
  chatEffortSchema,
  internetAccessSchema,
  profileStatusSchema,
  secretInjectModeSchema,
} from "./base";

export const createInstanceBodySchema = z.object({
  profile: z.string().min(1),
});

export const updateInstanceBodySchema = z.object({
  title: z.string().min(1).max(200),
});

export const execInstanceBodySchema = z.object({
  command: z.string().min(1),
  workingDir: z.string().min(1).optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
});

// ---- Workspace file tree ----
// The file browser walks the guest filesystem one directory at a time. Every
// `path` is absolute inside the VM. The server constrains them to WORKSPACE_ROOT
// (see packages/server/src/files.ts). Sizes are bytes for files, null for dirs.
export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().nullable(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileListingSchema = z.object({
  path: z.string(),
  entries: z.array(fileEntrySchema),
});
export type FileListing = z.infer<typeof fileListingSchema>;

// ---- Workspace review diff ----
// The Review tab shows a PR-style diff of the workspace: every change this
// branch introduces relative to its base branch (the remote's default branch),
// including uncommitted edits and untracked files. The server resolves the base
// and parses `git diff` into the structures below (see workspace-diff.ts), so
// the client only renders. Multiple repos under /workspace are flattened into
// one file list, and a file's `path` is prefixed with its repo's location relative
// to /workspace when that isn't the root repo.
export const diffFileStatusSchema = z.enum(["added", "deleted", "modified", "renamed"]);
export type DiffFileStatus = z.infer<typeof diffFileStatusSchema>;

// One hunk of a unified diff. `header` is the verbatim `@@ -a,b +c,d @@ …` line
// (the trailing section heading, if any, is kept for display). Each entry in
// `lines` is a raw diff line including its leading marker: ' ' (context),
// '+' (added), '-' (removed), or '\' (the "No newline at end of file" note).
// so the client can colour rows and recompute gutter line numbers from the
// header without a second encoding.
export const diffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof diffHunkSchema>;

export const diffFileSchema = z.object({
  // Display path: the new path (repo-prefixed), or the old path for a deletion.
  path: z.string(),
  // The previous path for a rename, else null.
  oldPath: z.string().nullable(),
  status: diffFileStatusSchema,
  // Binary files carry no hunks. The UI shows a placeholder instead.
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(diffHunkSchema),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const workspaceDiffSchema = z.object({
  files: z.array(diffFileSchema),
  // True when at least one file hit the per-file line cap and was clipped.
  truncated: z.boolean(),
});
export type WorkspaceDiff = z.infer<typeof workspaceDiffSchema>;

// An inclusive 1-based slice of a workspace file, used by the Review tab to
// expand unchanged context around a hunk on demand (so the diff payload stays
// small). `eof` is true when the file has no lines past the requested end, so
// the UI can stop offering to expand further down.
export const fileLinesSchema = z.object({
  lines: z.array(z.string()),
  eof: z.boolean(),
});
export type FileLines = z.infer<typeof fileLinesSchema>;

// Request bodies for the mutation routes. `path`/`from`/`to` are validated for
// containment server-side. `content` is the base64-encoded bytes of an upload.
export const filePathBodySchema = z.object({
  path: z.string().min(1),
});
export const renameFileBodySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export const uploadFileBodySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

// Open a runtime port forward. `remotePort` is the guest port to expose. The
// host loopback port is chosen by the server and returned in the binding —
// unless `hostPort` pins it (needed when something external dials the host
// port by a fixed number, e.g. an OAuth redirect_uri). A pinned port that is
// already taken fails the request.
export const createPortForwardBodySchema = z.object({
  remotePort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535).optional(),
});

// Identify one attached PR for detach (and any future per-PR REST action). The
// full (host, owner, repo, number) tuple is the attachment's primary key.
export const prRefBodySchema = z.object({
  host: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
});

export const createChatBodySchema = z.object({
  model: z.string().min(1),
  // Omitted → server picks the model's declared defaultEffort.
  effort: chatEffortSchema.optional(),
});

export const updateChatBodySchema = z
  .object({
    model: z.string().min(1).optional(),
    effort: chatEffortSchema.optional(),
  })
  .refine((body) => body.model !== undefined || body.effort !== undefined, {
    message: "model or effort is required",
  });

export const createChatMessageBodySchema = z.object({
  content: z.string().min(1),
});

export const setProfileSecretBodySchema = z.object({
  value: z.string().min(1),
});

// A secret *declaration*: the env var name exposed in the VM, how its value is
// delivered (`inject`, see SECRET_INJECT_MODES), and, for the proxy modes, the
// hosts the value may be substituted into. Mirrors the server's config.toml
// schema so the client can validate inline before writing it back to config.
// The `headers`/`full` proxy modes require at least one host. The `env` mode
// puts the real value in the VM and takes no hosts.
export const secretDeclarationSchema = z
  .object({
    env: z
      .string()
      .min(1)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env must be a valid POSIX env var name"),
    hosts: z.array(z.string().min(1)),
    inject: secretInjectModeSchema.default("headers"),
  })
  .superRefine((d, ctx) => {
    if (d.inject === "env") {
      if (d.hosts.length > 0)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hosts"],
          message: "hosts don't apply to env-injected secrets",
        });
    } else if (d.hosts.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hosts"],
        message: "at least one host is required",
      });
    }
  });
export type SecretDeclaration = z.infer<typeof secretDeclarationSchema>;

// Replace-all of an environment's declared secrets, written back to its
// config.toml. Env var names must be unique.
export const setSecretDeclarationsBodySchema = z
  .object({ declarations: z.array(secretDeclarationSchema) })
  .refine((b) => new Set(b.declarations.map((d) => d.env)).size === b.declarations.length, {
    message: "duplicate secret env",
  });

// ---- Profiles ----
// A profile is the whole unit: identity (auth, appearance, git, network,
// secrets) AND a single build definition (its config.toml). The active profile
// drives the whole app. This shape carries the build state so the UI can show a
// status dot (Profiles) and the build panel (Environment) without a second
// fetch. `hasConfig` is false until the config.toml carries a build definition
// (its repos + build); a fresh profile's config.toml holds only its name.
export const profileSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  status: profileStatusSchema,
  errorMessage: z.string().nullable(),
  hasConfig: z.boolean(),
  configPath: z.string(),
});
export type ProfileSummary = z.infer<typeof profileSummarySchema>;
export const profileSummaryArraySchema = z.array(profileSummarySchema);

export const createProfileBodySchema = z.object({
  name: z.string().min(1).max(100),
});

export const renameProfileBodySchema = z.object({
  name: z.string().min(1).max(100),
});

// A window reporting which profile it's currently using, so the server can keep
// that profile's warm titling VM alive (and reap unused ones). `clientId` is a
// stable per-window id. The same body is sent for both activate and deactivate.
export const profileActivationBodySchema = z.object({
  clientId: z.string().min(1).max(200),
});

export const cloneProfileBodySchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1).max(100),
});

// Per-profile UI preferences (theme, fonts, and the debug toggle), server-
// persisted so they follow the identity across machines and re-apply on profile
// switch. Named "appearance" for historical reasons (its config.toml table).
export const appearanceSchema = z.object({
  theme: z.string().optional(),
  fontAgent: z.string().optional(),
  fontUser: z.string().optional(),
  debug: z.boolean().optional(),
});
export type Appearance = z.infer<typeof appearanceSchema>;

// Per-profile model catalog overrides: a sparse map of model id → override
// object that stores only deltas from the catalog defaults (see
// shared/catalog.ts). The value is an object (not a bare tier) so it can grow
// per-model settings later without a format break. Tier "default" appears only
// when a model whose catalog default is "more" has been pulled up to the top
// level.
export const modelTierSchema = z.enum(["default", "more", "hidden"]);
export const modelOverrideSchema = z.object({ tier: modelTierSchema.optional() }).strict();
export const modelOverridesSchema = z.record(z.string(), modelOverrideSchema);
export type ModelOverridesPayload = z.infer<typeof modelOverridesSchema>;

// ---- Profile config (build definition) editing ----
// A profile's build definition lives in its config.toml. This is the structured,
// form-facing shape of the image inputs edited on the Configuration section:
// source repos, the Dockerfile path, and the agent-layer skills. It flattens the
// `[build]` nesting for the UI (`[build].dockerfile` → `dockerfile`,
// `[build].skills` → `skills`). The per-instance runtime (caches, setup/start),
// the forwarded/host ports, the chat prelude, git signing, and secrets each have
// their own section and editor (Runtime, Network, Prompt, Git, Secrets) and are
// NOT part of this form. The server maps this back to TOML and re-validates the
// result against its own authoritative schema before writing, so these rules
// only need to be good enough for inline client feedback.

// Repo name mirrors the server's rule: a valid Docker context-name component.
// (The server additionally rejects a handful of reserved names, surfaced as a
// save error rather than duplicated here.)
export const repoFormSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
      'lowercase alphanumeric with single ".", "-" or "_" separators',
    ),
  source: z.string().min(1),
  branch: z.string().min(1).optional(),
});
export type RepoForm = z.infer<typeof repoFormSchema>;

// A lifecycle phase (`[runtime].setup` / `[runtime].start`): commands run in
// the booted VM.
export const lifecyclePhaseSchema = z.object({
  sync: z.array(z.string().min(1)),
  async: z.array(z.string().min(1)),
});
export type LifecyclePhase = z.infer<typeof lifecyclePhaseSchema>;

// Cache mounts must be HOME-rooted and free of `..` (mirrors the server rule).
const cachePathFormSchema = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("~/") || p.startsWith("$HOME/"), {
    message: "cache paths must start with ~/ or $HOME/",
  })
  .refine((p) => !p.split("/").some((seg) => seg === ".."), {
    message: "cache paths must not contain ..",
  });

export const profileConfigFormSchema = z.object({
  // May be empty: a Dockerfile-only profile builds with no source repos.
  repos: z.array(repoFormSchema),
  dockerfile: z.string().min(1),
  // Skill packages installed into the agent layer at build time (`[build].skills`).
  skills: z.array(z.string().min(1)),
});
export type ProfileConfigForm = z.infer<typeof profileConfigFormSchema>;

// GET /api/profiles/:id/config: everything the Configuration and Dockerfile
// sections need in one shot. `form` is null when there's no build definition yet
// (a name/identity-only config, no error) or when the build definition is
// unparseable (`parseError` carries why; fix config.toml on disk). `hasConfig` is
// true only with a build definition present. `dockerfile` is the resolved
// Dockerfile's contents ("" when it doesn't exist yet), `dockerfilePath` its
// absolute path.
export const profileConfigViewSchema = z.object({
  form: profileConfigFormSchema.nullable(),
  parseError: z.string().nullable(),
  hasConfig: z.boolean(),
  dockerfile: z.string().nullable(),
  dockerfilePath: z.string().nullable(),
});
export type ProfileConfigView = z.infer<typeof profileConfigViewSchema>;

// PUT bodies: the structured form and the Dockerfile contents.
export const setProfileConfigFormBodySchema = z.object({
  form: profileConfigFormSchema,
});
export const setDockerfileBodySchema = z.object({ content: z.string() });

export const errorResponseSchema = z.object({
  error: z.string(),
});

export const okResponseSchema = z.object({
  ok: z.literal(true),
});

// ---- Agent auth (Claude / Codex in-app login) ----
export const authProviderSchema = z.enum(["claude", "codex"]);

export const providerAuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  /** Access-token expiry (epoch ms), if known. */
  expiresAt: z.number().nullable(),
});

export const authStatusSchema = z.object({
  claude: providerAuthStatusSchema,
  codex: providerAuthStatusSchema,
});

export const loginSessionSchema = z.object({
  sessionId: z.string(),
  provider: authProviderSchema,
  state: z.enum(["starting", "awaiting_user", "completed", "error"]),
  /** URL the user opens to authorize. The loopback callback completes it. */
  url: z.string().nullable(),
  error: z.string().nullable(),
});

// ---- Agent git config: committer identity + optional commit signing ----

/** Committer identity applied to every agent commit (signed or not). */
const gitIdentitySchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
});

/** Identity auto-detected from the host's git config, for prefill. Either
 * field may be empty if the host hasn't set it. */
export const detectedIdentitySchema = z.object({
  name: z.string(),
  email: z.string(),
});

/** One key the SSH agent advertises, for the setup key-picker. */
export const signingKeyInfoSchema = z.object({
  /** Full OpenSSH public-key line to store as the signing key. */
  pubkey: z.string(),
  comment: z.string(),
  fingerprint: z.string().nullable(),
  /** True when this is the host's own git signing key, surfaced so the user
   * picks a dedicated agent key rather than their personal one. */
  isHostSigningKey: z.boolean(),
});

export const signingKeysResultSchema = z.object({
  /** Whether the agent socket could be reached at all. */
  reachable: z.boolean(),
  /** The socket the keys were read from (echoed back for the UI). */
  socketPath: z.string().nullable(),
  keys: z.array(signingKeyInfoSchema),
});

/** An SSH agent socket isolade detected, offered as a one-click choice. */
export const agentSocketSchema = z.object({
  path: z.string(),
  /** Human label inferred from the path (e.g. "Secretive", "gpg-agent"). */
  label: z.string(),
});

/** Signing sub-status (the key/socket/on-off half of the git config). */
export const gitSigningStatusSchema = z.object({
  enabled: z.boolean(),
  /** Whether a key + socket have been saved (independent of enabled). */
  configured: z.boolean(),
  socketPath: z.string().nullable(),
  /** Agent sockets detected on the host (Secretive first), for the picker. */
  detectedSockets: z.array(agentSocketSchema),
  key: z
    .object({
      /** Full public-key line currently configured (public, safe to expose). */
      pubkey: z.string(),
      comment: z.string(),
      fingerprint: z.string().nullable(),
    })
    .nullable(),
  /** Whether the agent socket is reachable right now (live probe). */
  agentReachable: z.boolean(),
});

export const gitConfigStatusSchema = z.object({
  /** The configured (saved) committer identity, or null to use the host's. */
  identity: gitIdentitySchema.nullable(),
  /** Identity detected from the host git config, for UI prefill. */
  hostIdentity: detectedIdentitySchema.nullable(),
  signing: gitSigningStatusSchema,
});

export const setGitIdentityBodySchema = gitIdentitySchema;

export const setSigningConfigBodySchema = z.object({
  enabled: z.boolean(),
  socketPath: z.string().min(1),
  /** OpenSSH public-key line of the dedicated agent key. */
  signingKey: z.string().min(1),
});

export type CreateInstanceBody = z.infer<typeof createInstanceBodySchema>;
export type UpdateInstanceBody = z.infer<typeof updateInstanceBodySchema>;
export type ExecInstanceBody = z.infer<typeof execInstanceBodySchema>;
export type FilePathBody = z.infer<typeof filePathBodySchema>;
export type RenameFileBody = z.infer<typeof renameFileBodySchema>;
export type UploadFileBody = z.infer<typeof uploadFileBodySchema>;
export type PrRefBody = z.infer<typeof prRefBodySchema>;
export type CreateChatBody = z.infer<typeof createChatBodySchema>;
export type UpdateChatBody = z.infer<typeof updateChatBodySchema>;
export type CreateChatMessageBody = z.infer<typeof createChatMessageBodySchema>;
export type SetProfileSecretBody = z.infer<typeof setProfileSecretBodySchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type OkResponse = z.infer<typeof okResponseSchema>;
export type AuthProvider = z.infer<typeof authProviderSchema>;
export type ProviderAuthStatus = z.infer<typeof providerAuthStatusSchema>;
export type AuthStatus = z.infer<typeof authStatusSchema>;
export type LoginSession = z.infer<typeof loginSessionSchema>;
export type GitIdentity = z.infer<typeof gitIdentitySchema>;
export type DetectedIdentity = z.infer<typeof detectedIdentitySchema>;
export type AgentSocket = z.infer<typeof agentSocketSchema>;
export type SigningKeyInfo = z.infer<typeof signingKeyInfoSchema>;
export type SigningKeysResult = z.infer<typeof signingKeysResultSchema>;
export type GitSigningStatus = z.infer<typeof gitSigningStatusSchema>;
export type GitConfigStatus = z.infer<typeof gitConfigStatusSchema>;
export type SetGitIdentityBody = z.infer<typeof setGitIdentityBodySchema>;
export type SetSigningConfigBody = z.infer<typeof setSigningConfigBodySchema>;

// ---- Sandbox network policy (global, applied to every instance VM) ----

/** Provider domains the agents themselves need to function, always reachable,
 * even in allowlist mode, or Claude Code / Codex couldn't run at all. Surfaced
 * (locked) in the UI so users understand why these stay reachable.
 *
 * Suffix-matched: each covers the apex AND all subdomains (e.g. "anthropic.com"
 * → api./console./statsig.anthropic.com and any future host). This is a locked,
 * must-always-work guarantee the user can't edit, so robustness beats tightness.
 * Pinning exact hosts would silently break the agent the moment a CLI moves
 * to a new subdomain. The widened surface is all first-party (provider-owned),
 * so the marginal exfiltration risk over the API access the agent already has
 * is negligible. (User-added allowlist entries are the opposite: exact by
 * default, with an explicit "*." opt-in for subdomains.)
 *
 * Known hosts covered today: api./console./statsig.anthropic.com, claude.ai
 * (OAuth), api./auth.openai.com, chatgpt.com (Codex backend). */
export const ESSENTIAL_NETWORK_DOMAINS = [
  "anthropic.com",
  "claude.ai",
  "openai.com",
  "chatgpt.com",
] as const;

/** Global network posture for instance VMs. The default reproduces the
 * historical hard-coded behavior (open internet, no local/host access), so an
 * absent or empty config is a no-op. */
export const networkConfigSchema = z.object({
  /** Public-internet egress. "open" = all public destinations. "allowlist" =
   * only ESSENTIAL_NETWORK_DOMAINS + allowedDomains. */
  internet: internetAccessSchema.default("open"),
  /** Extra hosts permitted in allowlist mode. Matched exactly by default
   * ("api.github.com" → only that host). A leading "*." makes it a suffix that
   * covers the apex + all subdomains ("*.github.com" → github.com and any
   * subdomain). Ignored when internet === "open". */
  allowedDomains: z.array(z.string().min(1)).default([]),
  /** Allow egress to the private/LAN group (RFC-1918 addresses). */
  allowLocalNetwork: z.boolean().default(false),
  /** Allow egress to the host group (services on the user's machine).
   * `hostPorts` below always work regardless of this flag. */
  allowHost: z.boolean().default(false),
  /** Guest TCP ports forwarded to the host loopback when an instance is
   * created, so a dev server in the VM is reachable from the host. */
  ports: z.array(z.number().int().positive()).default([]),
  /** Host bridge TCP ports the instance VM is allowed to reach (egress). Each
   * becomes one allow rule for `host.microsandbox.internal:<port>`, and works
   * regardless of `allowHost`. By default the VM can reach no host port. */
  hostPorts: z.array(z.number().int().positive()).default([]),
});

export type NetworkConfig = z.infer<typeof networkConfigSchema>;

// ---- Runtime config ([runtime] table): what runs in the booted VM ----
// The per-instance lifecycle: host-backed cache mounts plus the two command
// phases. Edited on the Runtime settings section, saved to config.toml's
// `[runtime]` table. Distinct from the build definition (Configuration), which
// bakes the image, and from `[prompt]`, which augments chat.
export const runtimeConfigSchema = z.object({
  caches: z.array(cachePathFormSchema),
  setup: lifecyclePhaseSchema,
  start: lifecyclePhaseSchema,
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

// The empty runtime posture: no caches, no lifecycle commands. Parsing `{}`
// against the read-side schema (below) fills these in.
export const EMPTY_RUNTIME_CONFIG: RuntimeConfig = {
  caches: [],
  setup: { sync: [], async: [] },
  start: { sync: [], async: [] },
};

// ---- Prompt config ([prompt] table): chat augmentation ----
// The prelude prepended (invisibly) to the first user message of every new chat
// in the profile. Edited on the Prompt settings section, saved to config.toml's
// `[prompt]` table. Empty string means "no prelude".
export const promptConfigSchema = z.object({
  prelude: z.string(),
});
export type PromptConfig = z.infer<typeof promptConfigSchema>;

// ---- Update check ----
// The app's once-per-calendar-day update check (see packages/server/src/
// update-check.ts). The server does the network call to isolade.com and the
// version comparison. This is what it hands the UI's UpdateBanner.
export const updateStatusSchema = z.object({
  /** The running app's version. */
  current: z.string(),
  /** True when `latest` is a strictly newer version than `current`. */
  available: z.boolean(),
  /** Latest released version tag, or null if it couldn't be resolved. */
  latest: z.string().nullable(),
  /** Where to get it (the counted /download URL), or null. */
  download: z.string().nullable(),
  /** Release-notes URL, or null. */
  notes: z.string().nullable(),
  /** A few "what changed" bullets for the latest release. */
  changes: z.array(z.string()),
  /** Epoch ms of the last successful check, or null if none yet. */
  checkedAt: z.number().nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
