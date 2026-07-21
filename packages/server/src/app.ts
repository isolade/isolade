import { join } from "node:path";
import { dirAllocatedBytes, fileAllocatedBytes } from "@isolade/shared/node";
import { type Context, Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { AuthLoginManager } from "./auth-login";
import type { ChatBackend } from "./chat/backend";
import { ChatTurnService } from "./chat/chat-turn-service";
import { ClaudeBackend } from "./chat/claude-backend";
import { CodexBackend } from "./chat/codex-backend";
import { CodexManager } from "./chat/codex-manager";
import { ChatStreamHub } from "./chat/stream-hub";
import { annotateAggregateShares } from "./chat/subscription-share";
import { ChatManager } from "./chats";
import { type AggregateTotals, sandboxStatsSchema } from "./contracts";
import { createDb } from "./db";
import { DiffStatsPoller } from "./diff-stats";
import { WorkspaceFiles } from "./files";
import { InstanceManager } from "./instances";
import { PrAttachmentManager, PrStatePoller } from "./pr-attachments";
import { ProfileManager } from "./profiles";
import { createAuthRouter } from "./routes/auth";
import { createChatsRouter } from "./routes/chats";
import type { RouteContext } from "./routes/context";
import { createFilesRouter } from "./routes/files";
import { createGitRouter } from "./routes/git";
import { createInstancesRouter } from "./routes/instances";
import { createNetworkRouter } from "./routes/network";
import { createProfilesRouter } from "./routes/profiles";
import { createPromptRouter } from "./routes/prompt";
import { createRuntimeRouter } from "./routes/runtime";
import { createUploadsRouter } from "./routes/uploads";
import { type SandboxApi, SandboxClient } from "./sandbox-client";
import { SecretsStore } from "./secrets-store";
import { importSeedProfiles, sweepSeedStaging } from "./seed";
import { PersistentSessionManager } from "./session-manager";
import { TerminalManager } from "./terminals";
import { ActiveProfileTracker, TitleVmManager } from "./title-vm-manager";
import { getUpdateStatus, initUpdateChecks } from "./update-check";
import { sweepUploads, UploadStore } from "./uploads";
import { fetchCodexUsageFromAppServer, getUsageStats } from "./usage";
import { WorkspaceDiffReader } from "./workspace-diff";
import { cacheDir, dataDir } from "./xdg";

// Tracks user+system CPU between samples to derive a percent. See the
// matching SelfProcessSampler in packages/sandbox/src/stats.ts for details.
class SelfProcessSampler {
  private prevCpu = process.cpuUsage();
  private prevAtMs = Date.now();

  constructor(private name: string) {}

  sample() {
    const cpu = process.cpuUsage();
    const nowMs = Date.now();
    const cpuDeltaUs = cpu.user + cpu.system - (this.prevCpu.user + this.prevCpu.system);
    const wallDeltaMs = nowMs - this.prevAtMs;
    this.prevCpu = cpu;
    this.prevAtMs = nowMs;
    const cpuPercent = wallDeltaMs > 0 ? (cpuDeltaUs / 1000 / wallDeltaMs) * 100 : 0;
    return {
      name: this.name,
      pid: process.pid,
      cpuPercent,
      memoryBytes: process.memoryUsage().rss,
    };
  }
}

const serverSelfSampler = new SelfProcessSampler("server");

// Background-refreshed cache for a directory size. Used for the
// workspace-checkouts tree (user repos, node_modules, etc.) and the
// per-workspace caches tree (ccache, cargo registry, etc.). `du -sk` over
// either can take seconds, so refreshing every 30s keeps the /api/stats hot
// path snappy. The sizes only change when a workspace is added/rebuilt or
// a build runs inside a sandbox.
const DIR_SIZE_REFRESH_MS = 30_000;

class DirSizeCache {
  private bytes: number | null = null;
  private inFlight: Promise<number> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly path: string) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async snapshot(): Promise<number> {
    if (this.bytes !== null) return this.bytes;
    return this.refresh();
  }

  private async tick(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      // A transient du -sk failure (path doesn't exist yet, permissions
      // hiccup) is fine, and we keep the previous snapshot. But a chronic
      // failure means /api/stats serves stale data forever, so log.
      console.warn(`[stats] dir size refresh failed for ${this.path}:`, err);
    }
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), DIR_SIZE_REFRESH_MS);
  }

  private refresh(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const promise = dirAllocatedBytes(this.path).then((n) => {
      this.bytes = n;
      return n;
    });
    this.inFlight = promise;
    promise.finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    return promise;
  }
}

const DEFAULT_SANDBOX_URL = process.env.ISOLADE_SANDBOX_URL || "http://localhost:7778";

export interface CreateAppOptions {
  dbPath?: string;
  // Test seam: replace the real claude/codex backends with a fake.
  // Both backends share the `ChatBackend` interface from
  // chat/claude-backend.ts. When provided, this fake is used for any
  // provider (the resolver in the POST handler still picks "anthropic"
  // vs "openai", but they map to the same fake).
  backendForTest?: {
    sendMessage: (typeof ClaudeBackend.prototype)["sendMessage"];
    probeContext: (typeof ClaudeBackend.prototype)["probeContext"];
    generateTitle: (typeof ClaudeBackend.prototype)["generateTitle"];
  };
  // Override hub timings so tests don't wait minutes for idle-cancel
  // or eviction.
  hubOptions?: ConstructorParameters<typeof ChatStreamHub>[1];
  // Skip all boot-time sandbox reach-out: the VM resync AND the profile
  // reconcile's registry GC. Tests set this so constructing an app never polls a
  // sandbox that isn't theirs (waitUntilReady would otherwise burn up to 30s
  // with no sandbox) or fires a real registry GC.
  skipResync?: boolean;
  // Sandbox driver. The merged entry point injects an in-process implementation
  // (the default product config). When omitted, the app talks to a sandbox over
  // HTTP at ISOLADE_SANDBOX_URL, used for the external-sandbox dev mode and by
  // tests (which set skipResync so the unreachable client is never polled).
  sandbox?: SandboxApi;
  // Host unix socket where the in-process sandbox API is served, enabling
  // `expose_sandbox` profiles to reach it from inside their VMs (isolade within
  // isolade). Set only by the in-process entry point. Undefined for the
  // external-sandbox path (nothing to serve) and in tests.
  sandboxSocketPath?: string;
  // Bearer token that gates every /api/* route. In production it comes from
  // ISOLADE_AUTH_TOKEN (minted per launch by the Tauri host). This override lets
  // tests enable the gate deterministically. When neither is set, the gate is
  // disabled so proxied, tokenless requests still work. This is the browser dev
  // flow (scripts/dev.sh), where Vite proxies /api to a loopback-only server.
  authToken?: string;
}

export function createApp(dbPathOrOpts?: string | CreateAppOptions) {
  const opts: CreateAppOptions =
    typeof dbPathOrOpts === "string" || dbPathOrOpts === undefined
      ? { dbPath: dbPathOrOpts }
      : dbPathOrOpts;
  const db = createDb(opts.dbPath);
  // Nested-dev seeding (isolade within isolade): when this server boots inside
  // an `expose_sandbox` dev VM, the host staged a profile bundle at SEED_MOUNT.
  // Import it BEFORE ProfileManager is constructed: reconcile() leaves rows it
  // already finds alone, so seeded profiles arrive READY (their image refs live
  // in the shared host sandbox cache) and the constructor-tail GC includes them
  // in this instance's keep-set registration. No-op when the mount is absent
  // (every ordinary boot). Never blocks boot.
  try {
    importSeedProfiles(db);
  } catch (err) {
    console.warn("[server] seed import failed:", err);
  }
  // The update check persists its state in app_state (see update-check-store.ts),
  // so it needs the DB. Wire it before startUpdateChecks / the /api/update route.
  initUpdateChecks(db);
  const sandboxClient = opts.sandbox ?? new SandboxClient(DEFAULT_SANDBOX_URL);
  const workspaceCheckoutsCache = new DirSizeCache(join(cacheDir(), "workspace-checkouts"));
  const workspaceCachesCache = new DirSizeCache(join(cacheDir(), "workspaces"));
  // Per-instance unpushed-diff stats shown in the sidebar. Like the dir-size
  // caches, constructed here but started only by the real entrypoint.
  const diffStatsPoller = new DiffStatsPoller(db, sandboxClient);
  // Chat-attached PRs (via the in-VM `isolade pr` CLI) + their background `gh`
  // state refresher. Like the diff-stats poller, constructed here but started
  // only by the real entrypoint.
  const prAttachments = new PrAttachmentManager(db, sandboxClient);
  const prStatePoller = new PrStatePoller(db, prAttachments);
  const sessionManager = new PersistentSessionManager(sandboxClient);
  const secretsStore = new SecretsStore();
  // The single profile-scoped manager: per-profile auth / git / network /
  // appearance stores, profile CRUD, AND the build pipeline (each profile
  // builds one image, and build state lives on the profile). There is no
  // server-side "active profile". Each client/window names the profile it acts
  // as per request.
  const profiles = new ProfileManager(db, sandboxClient, {
    skipBootSandboxWork: opts.skipResync,
  });
  // Guarantee at least one profile exists so a fresh install has something to
  // select (and to sign into before authoring a config.toml).
  if (profiles.list().length === 0) profiles.ensureDefault();
  const instances = new InstanceManager(db, sandboxClient, profiles, secretsStore, prAttachments, {
    sandboxSocketPath: opts.sandboxSocketPath,
  });
  // Reclaim seed staging dirs orphaned by a crash between staging and the
  // instance insert (or a missed removal). Local filesystem only, never blocks.
  try {
    const liveIds = new Set(instances.list().map((i) => i.id));
    sweepSeedStaging(liveIds);
    // Same idea for message-attachment dirs orphaned by a missed removal.
    sweepUploads(liveIds);
  } catch (err) {
    console.warn("[server] staging sweep failed:", err);
  }
  // Per-profile always-warm titling VMs + the reference-counter that decides,
  // from window activate/heartbeat/deactivate signals, when to warm one and
  // when to tear it down. Lets a chat's first-message title be minted instantly
  // instead of waiting on the instance's own VM cold boot.
  const titleVmManager = new TitleVmManager(db, sandboxClient, profiles);
  const activeProfiles = new ActiveProfileTracker(titleVmManager);
  // Backs the right-panel file tree: browses + mutates each instance VM's
  // /workspace, with path-containment guards living in the service.
  const workspaceFiles = new WorkspaceFiles(sandboxClient);
  // Backs the right-panel Review tab: a PR-style diff of each instance VM's
  // /workspace against its base branch.
  const workspaceDiff = new WorkspaceDiffReader(sandboxClient);
  // In-app agent login runs the CLI's no-callback flow inside a throwaway VM
  // booted from any READY profile image (a successful, cached build, since they all
  // ship claude + codex). The VM is just a host for the CLI. The credentials it
  // produces are written into the *requested* profile's store (see the route).
  const loginImage = (): string | null =>
    process.env.DEFAULT_IMAGE ??
    profiles.list().find((p) => p.status === "ready" && p.image)?.image ??
    null;
  const authLogin = new AuthLoginManager(sandboxClient, loginImage);
  // Re-attach to every persisted VM the sandbox-service stop-without-removed
  // on its last shutdown. Fire-and-forget: blocking app boot on the
  // sandbox-service would make `bun run dev` (which launches both in
  // parallel) deadlock. Failed restarts land each instance in `status=error`
  // with a `lastError` message. The UI surfaces those and the user can
  // retry from the context menu.
  void (async () => {
    if (opts.skipResync) return;
    if (!(await sandboxClient.waitUntilReady())) {
      console.warn("[server] sandbox-service not ready within timeout; skipping VM resync");
      return;
    }
    // Titling VMs are ephemeral and never resumed, so destroy any left over from a
    // prior run before re-attaching instances. Independent of resyncAll (which
    // only touches the instances table), so run it alongside.
    await titleVmManager.reapOrphans().catch((err) => {
      console.warn("[server] titling-VM reap failed:", err);
    });
    await instances.resyncAll();
    // Retry nested-client removals a crash or failed cascade left behind.
    // Only where the in-process sandbox lives: a server sharing an external
    // sandbox can't tell its own orphans from other servers' live clients.
    if (opts.sandboxSocketPath) {
      await instances.sweepOrphanClients().catch((err) => {
        console.warn("[server] orphan-client sweep failed:", err);
      });
    }
  })().catch((err) => {
    console.warn("[server] VM resync failed:", err);
  });
  // Leak-guard sweep for clients whose deactivate beacon was lost. Production
  // only. Tests (skipResync) don't start the timer.
  if (!opts.skipResync) activeProfiles.startSweep();
  // No host listener for signing: each opted-in VM gets a per-VM exec-stream
  // broker, started by InstanceManager at create/restart/re-attach.
  const terminalManager = new TerminalManager(db);
  const chatManager = new ChatManager(db);
  const uploadStore = new UploadStore(db);
  const realClaudeBackend = new ClaudeBackend(sandboxClient, chatManager);
  const codexManager = new CodexManager(sandboxClient);
  const realCodexBackend = new CodexBackend(sandboxClient, chatManager, codexManager);
  // Pre-warm a titling VM's agent processes the moment it's ready, so the first
  // title is just an inference turn rather than a cold CLI / app-server start.
  titleVmManager.setPrewarm((vmId) => {
    realClaudeBackend.warmTitleSession(vmId);
    // The default chat model is codex, so most first titles run through codex.
    // Warm its app-server here too (CodexBackend.generateTitle reuses the cached
    // connection getOrCreate establishes).
    void codexManager.getOrCreate(vmId).catch(() => {});
  });
  // Tests inject a fake backend to drive the hub deterministically
  // without spinning up a VM. In production both providers run their
  // real backends.
  const claudeBackend: ChatBackend = opts.backendForTest ?? realClaudeBackend;
  const codexBackend: ChatBackend = opts.backendForTest ?? realCodexBackend;
  const chatStreamHub = new ChatStreamHub(chatManager, opts.hubOptions);

  // Feed the sidebar's per-instance "working" indicator from the hub's live
  // set of in-flight turns. Wired here because the hub is built after the
  // instance manager and the dependency only runs one way.
  instances.setActivitySource(() => chatStreamHub.activeInstanceIds());

  const app = new Hono();

  // The API binds to loopback (see packages/server/src/index.ts), so CORS is
  // defense-in-depth against a stray *non-local* browser tab poking 127.0.0.1,
  // not the primary boundary. Allowed origins:
  //   - the Tauri webview's custom-protocol origin in the packaged app: macOS
  //     uses tauri://localhost, Windows/Linux use http://tauri.localhost.
  //   - any loopback http origin: the Vite dev server. `bun run app`
  //     (scripts/app.sh) gives Vite a *random* free port so several app
  //     instances can run at once, so there's no single localhost:PORT to pin.
  //     We accept any localhost / 127.0.0.1 / [::1] http origin instead. That
  //     only widens the surface to other things already on this machine's
  //     loopback, an acceptable trade-off for a single-user desktop tool, and a
  //     real website (non-loopback origin) is still rejected.
  // Same-origin requests (the web served directly off this server, where
  // API_BASE is "") send no Origin and are unaffected.
  const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost"]);
  const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const isAllowedOrigin = (origin: string): boolean => {
    if (TAURI_ORIGINS.has(origin)) return true;
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
    } catch {
      return false; // missing/garbage Origin (e.g. same-origin requests)
    }
  };
  app.use(
    "*",
    cors({
      origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
    }),
  );

  // Bearer-token gate. The Tauri host mints a random token per launch, hands it
  // to this sidecar via ISOLADE_AUTH_TOKEN, and injects the same value into the
  // webview (window.__ISOLADE__.token) so every request can present it. When no
  // token is configured (the browser dev flow, scripts/dev.sh, the demo
  // recorder, and tests), the gate is skipped entirely and the API is open, as
  // before. Registered after CORS (which short-circuits preflight OPTIONS before
  // this runs) and before every route, so it covers plain requests, SSE, and WS
  // upgrades alike.
  //
  // fetch-based callers send the token in `Authorization: Bearer <token>`. The
  // callers that can't set headers (EventSource for profile build logs, WebSocket
  // for terminals, and navigator.sendBeacon for profile deactivate / instance
  // delete) pass it as a `?token=` query param instead. We accept either.
  const authToken = opts.authToken ?? process.env.ISOLADE_AUTH_TOKEN;
  if (authToken) {
    app.use("/api/*", async (c, next) => {
      const header = c.req.header("Authorization");
      const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
      const presented = bearer ?? c.req.query("token");
      if (presented !== authToken) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return next();
    });
  }

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json({ error: err.issues.map((issue) => issue.message).join(", ") }, 400);
    }
    throw err;
  });

  app.get("/api/health", (c) => {
    return c.json({ status: "ok" });
  });

  // Update check. The network call + anonymous counting happen at isolade.com.
  // This reports whether a newer version exists (disabled status only when no
  // version resolves or on an unsupported platform). `?force=1` re-resolves now
  // for the manual "Check for updates" button; otherwise the warm cached status
  // is returned.
  // Counting stays gated to once per calendar day regardless. See update-check.ts.
  app.get("/api/update", async (c) => {
    return c.json(await getUpdateStatus(c.req.query("force") === "1"));
  });

  app.get("/api/stats", async (c) => {
    try {
      const [raw, workspaceCheckoutsBytes, workspaceCachesBytes, databaseBytes] = await Promise.all(
        [
          sandboxClient.getStats(),
          workspaceCheckoutsCache.snapshot(),
          workspaceCachesCache.snapshot(),
          fileAllocatedBytes(join(dataDir(), "isolade.db")),
        ],
      );
      const sandboxStats = sandboxStatsSchema.parse(raw);
      const { selfProcess: sandboxSelf, ...rest } = sandboxStats;
      return c.json({
        ...rest,
        workspaceCheckoutsBytes,
        workspaceCachesBytes,
        databaseBytes,
        services: [serverSelfSampler.sample(), sandboxSelf],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  // Profile-scoped routes carry the target profile in `?profile=<id>`
  // (there is no server-side active profile, and each window names it).
  const queryProfile = (c: Context): string | null => {
    const id = c.req.query("profile");
    return id && profiles.get(id) ? id : null;
  };
  const NO_PROFILE = { error: "missing or unknown ?profile" } as const;

  // Read Codex usage through the profile's warm-VM app-server. `ensureWarm`
  // forces a cold boot when no VM is up yet, which is appropriate for the explicit
  // Usage view, which is worth the wait. Chat enrichment passes false: a chat
  // list/turn must never spin up (and leak) a warm VM as a side effect, so it
  // just reuses an already-warm one and otherwise reports Codex unavailable.
  async function fetchProfileCodexUsage(profileId: string, ensureWarm: boolean) {
    const vmId = ensureWarm
      ? await titleVmManager.ensureReadyVmId(profileId)
      : titleVmManager.getReadyVmId(profileId);
    if (!vmId) {
      return {
        ok: false as const,
        error: "Codex usage unavailable: profile has no warm VM",
      };
    }
    const conn = await codexManager.getOrCreate(vmId);
    return fetchCodexUsageFromAppServer((method, params) => conn.send(method, params));
  }

  // The per-profile upstream usage snapshot (Claude + Codex), scoped and 20s-
  // cached by profile. Claude reads the profile's own credentials. Codex flows
  // through the profile's warm-VM app-server. Shared by /api/usage and the
  // per-chat subscriptionShare so both see the same profile-scoped numbers.
  const profileUsageStats = (profileId: string, ensureWarm = false) =>
    getUsageStats({
      authStore: profiles.auth(profileId),
      cacheKey: profileId,
      fetchCodexUsage: () => fetchProfileCodexUsage(profileId, ensureWarm),
    });

  app.get("/api/usage", async (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const stats = await profileUsageStats(profile, true);
    // Aggregate is server-local and cheap, not subject to the upstream
    // 20s cache. If the aggregation throws (e.g. legacy DB missing
    // columns), fall back to null so the upstream panels keep rendering.
    let aggregate: AggregateTotals | null = null;
    try {
      aggregate = chatManager.getAggregateTotals(profile);
      // Annotates each per-provider bucket with `subscriptionShare`,
      // expressed as a lifetime % of the resolved rate plan's window
      // budget. Uses the already-fetched (cached) usage stats.
      await annotateAggregateShares(aggregate, stats, profiles.auth(profile));
    } catch (err) {
      console.warn("[usage] aggregate totals failed", err);
    }
    return c.json({ ...stats, aggregate });
  });

  // Persisted daily usage series for the Usage-page contribution heatmap.
  // Purely server-local (the usage_events log), so it skips the upstream
  // rate-limit cache that /api/usage is subject to. On failure it returns an
  // empty series rather than erroring, so the heatmap degrades to "no data".
  app.get("/api/usage/history", (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    try {
      return c.json({ days: chatManager.getUsageHistory(profile) });
    } catch (err) {
      console.warn("[usage] history failed", err);
      return c.json({ days: [] });
    }
  });

  // Refuse VM-touching work on an archived instance. Archiving promises the
  // VM stays stopped, but the sandbox layer self-heals operations against VMs
  // missing from its in-memory map by BOOTING them (ensureAttached →
  // Sandbox.start), so without this guard, merely viewing an archived chat's
  // file tree or reconnecting its terminal would silently resurrect the VM
  // while its row still says "stopped". 409: the instance exists, its state
  // forbids the action, and unarchiving lifts it. DB-backed reads (transcript,
  // terminal/chat lists, port list) stay open so an archived chat remains
  // viewable.
  const archivedError = (c: Context): Response =>
    c.json({ error: "instance is archived. Unarchive it to interact" }, 409);

  // Owns a single assistant turn's orchestration (titling, prelude injection,
  // usage persistence, abort semantics). Built here so it shares the same
  // profile-scoped usage cache as /api/usage and the chat-list enrichment.
  const chatTurnService = new ChatTurnService({
    chatManager,
    uploadStore,
    instances,
    profiles,
    titleVmManager,
    diffStatsPoller,
    chatStreamHub,
    claudeBackend,
    codexBackend,
    profileUsageStats: (profileId: string) => profileUsageStats(profileId),
  });

  // The dependency bundle every per-domain router pulls its slice from.
  const routeContext: RouteContext = {
    profiles,
    instances,
    titleVmManager,
    activeProfiles,
    secretsStore,
    workspaceFiles,
    workspaceDiff,
    authLogin,
    sessionManager,
    terminalManager,
    chatManager,
    uploadStore,
    chatStreamHub,
    codexManager,
    diffStatsPoller,
    prAttachments,
    sandboxClient,
    chatTurnService,
    realClaudeBackend,
    claudeBackend,
    codexBackend,
    queryProfile,
    NO_PROFILE,
    archivedError,
    profileUsageStats,
  };

  // Per-domain sub-routers, each mounted at the root (their handlers carry the
  // full `/api/...` path). CORS, the auth gate, and onError above apply to all
  // of them because they're registered before these mounts.
  app.route("/", createProfilesRouter(routeContext));
  app.route("/", createInstancesRouter(routeContext));
  app.route("/", createFilesRouter(routeContext));
  app.route("/", createUploadsRouter(routeContext));
  app.route("/", createChatsRouter(routeContext));
  app.route("/", createAuthRouter(routeContext));
  app.route("/", createGitRouter(routeContext));
  app.route("/", createNetworkRouter(routeContext));
  app.route("/", createRuntimeRouter(routeContext));
  app.route("/", createPromptRouter(routeContext));

  return {
    app,
    instances,
    profiles,
    titleVmManager,
    activeProfiles,
    terminalManager,
    chatManager,
    chatStreamHub,
    db,
    websocket,
    workspaceCheckoutsCache,
    workspaceCachesCache,
    diffStatsPoller,
    prStatePoller,
  };
}
