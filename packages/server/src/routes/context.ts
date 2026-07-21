import type { Context } from "hono";
import type { AuthLoginManager } from "../auth-login";
import type { ChatBackend } from "../chat/backend";
import type { ChatTurnService } from "../chat/chat-turn-service";
import type { ClaudeBackend } from "../chat/claude-backend";
import type { CodexManager } from "../chat/codex-manager";
import type { ChatStreamHub } from "../chat/stream-hub";
import type { ChatManager } from "../chats";
import type { UsageStats } from "../contracts";
import type { DiffStatsPoller } from "../diff-stats";
import type { WorkspaceFiles } from "../files";
import type { InstanceManager } from "../instances";
import type { PrAttachmentManager } from "../pr-attachments";
import type { ProfileManager } from "../profiles";
import type { SandboxApi } from "../sandbox-client";
import type { SecretsStore } from "../secrets-store";
import type { PersistentSessionManager } from "../session-manager";
import type { TerminalManager } from "../terminals";
import type { ActiveProfileTracker, TitleVmManager } from "../title-vm-manager";
import type { UploadStore } from "../uploads";
import type { WorkspaceDiffReader } from "../workspace-diff";

// The dependency bundle every per-domain router receives. Built once in
// createApp (the composition root) and handed to each router factory, which
// pulls out the slice it needs. Managers are the concrete singletons. The
// helper functions are the small cross-cutting closures that used to live at
// the top of the monolithic createApp (profile resolution, the archived-VM
// guard, and the profile-scoped usage snapshot).
export interface RouteContext {
  // ---- Managers / services ----
  profiles: ProfileManager;
  instances: InstanceManager;
  titleVmManager: TitleVmManager;
  activeProfiles: ActiveProfileTracker;
  secretsStore: SecretsStore;
  workspaceFiles: WorkspaceFiles;
  workspaceDiff: WorkspaceDiffReader;
  authLogin: AuthLoginManager;
  sessionManager: PersistentSessionManager;
  terminalManager: TerminalManager;
  chatManager: ChatManager;
  uploadStore: UploadStore;
  chatStreamHub: ChatStreamHub;
  codexManager: CodexManager;
  diffStatsPoller: DiffStatsPoller;
  prAttachments: PrAttachmentManager;
  sandboxClient: SandboxApi;
  chatTurnService: ChatTurnService;
  // The real Claude backend, used for VM/chat-scoped teardown even when a fake
  // backend is swapped in for tests (dispose targets the real process handles).
  realClaudeBackend: ClaudeBackend;
  // The turn/probe backends: the test fake when one is injected, else the real
  // ones. Distinct from realClaudeBackend, which is never faked.
  claudeBackend: ChatBackend;
  codexBackend: ChatBackend;

  // ---- Shared helpers ----
  // Resolve the target profile from `?profile=<id>`, or null if missing/unknown.
  queryProfile: (c: Context) => string | null;
  // The 400 body for a missing/unknown `?profile`.
  readonly NO_PROFILE: { readonly error: string };
  // 409 response refusing VM-touching work on an archived instance.
  archivedError: (c: Context) => Response;
  // The per-profile upstream usage snapshot (Claude + Codex), scoped and
  // 20s-cached by profile. `ensureWarm` forces a cold VM boot for Codex usage.
  profileUsageStats: (profileId: string, ensureWarm?: boolean) => Promise<UsageStats>;
}
