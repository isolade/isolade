import {
  type Appearance,
  type AuthProvider,
  type AuthStatus,
  appearanceSchema,
  authStatusSchema,
  type Chat,
  type ChatEvent,
  type ChatMessage,
  type ChatModelsResponse,
  type ContextBreakdown,
  type CreateChatBody,
  type CreateInstanceBody,
  chatArraySchema,
  chatEventArraySchema,
  chatMessageArraySchema,
  chatModelsResponseSchema,
  chatSchema,
  contextBreakdownSchema,
  createChatBodySchema,
  createInstanceBodySchema,
  createProfileBodySchema,
  errorResponseSchema,
  type FileLines,
  type FileListing,
  fileLinesSchema,
  fileListingSchema,
  filePathBodySchema,
  type GitConfigStatus,
  gitConfigStatusSchema,
  type Instance,
  instanceArraySchema,
  instanceSchema,
  type LoginSession,
  loginSessionSchema,
  type ModelOverridesPayload,
  modelOverridesSchema,
  type NetworkConfig,
  networkConfigSchema,
  type OkResponse,
  okResponseSchema,
  type PortForward,
  type PortProbe,
  type ProfileConfigForm,
  type ProfileConfigView,
  type ProfileSecret,
  type ProfileSummary,
  type PromptConfig,
  type ProviderAuthStatus,
  type PrRefBody,
  portForwardArraySchema,
  portForwardSchema,
  portProbeSchema,
  profileConfigViewSchema,
  profileSecretArraySchema,
  profileSecretSchema,
  profileSummaryArraySchema,
  profileSummarySchema,
  promptConfigSchema,
  providerAuthStatusSchema,
  type ResourceStats,
  type RuntimeConfig,
  renameFileBodySchema,
  renameProfileBodySchema,
  resourceStatsSchema,
  runtimeConfigSchema,
  type SecretDeclaration,
  type SetGitIdentityBody,
  type SetSigningConfigBody,
  type SigningKeysResult,
  setActiveLeafBodySchema,
  setDockerfileBodySchema,
  setGitIdentityBodySchema,
  setProfileConfigFormBodySchema,
  setProfileSecretBodySchema,
  setSecretDeclarationsBodySchema,
  setSigningConfigBodySchema,
  signingKeysResultSchema,
  type Terminal,
  terminalArraySchema,
  terminalSchema,
  type UpdateChatBody,
  type UpdateInstanceBody,
  type UpdateStatus,
  type UsageHistory,
  type UsageStats,
  updateChatBodySchema,
  updateInstanceBodySchema,
  updateStatusSchema,
  uploadFileBodySchema,
  usageHistorySchema,
  usageStatsSchema,
  type WorkspaceDiff,
  workspaceDiffSchema,
} from "./contracts";

// What the Tauri host injects before page load: the loopback port the API
// server bound this launch, and the bearer token to authenticate with. Guarded
// with `typeof window` so this module is importable outside a browser (bun test).
const injected = typeof window !== "undefined" ? window.__ISOLADE__ : undefined;

// In the Tauri webview the API server runs on a loopback port the host picked
// at launch and injected as window.__ISOLADE__. In a plain browser this is
// absent, so requests go same-origin ("") and the Vite dev proxy forwards /api.
export const API_BASE = injected ? `http://127.0.0.1:${injected.port}` : "";

// The per-launch bearer token the Tauri host injected alongside `port`. Absent
// in a plain browser (dev), where the server runs tokenless behind the Vite
// proxy and its auth gate is off. See app/src/lib.rs and packages/server/src/app.ts.
const AUTH_TOKEN = injected?.token ?? null;

// EventSource, WebSocket, and navigator.sendBeacon can't set request headers, so
// they carry the token as a `?token=` query param instead. Appends it (when
// present) to an API URL, preserving any existing query string.
export function withAuthToken(url: string): string {
  if (!AUTH_TOKEN) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(AUTH_TOKEN)}`;
}

// Every JSON/fetch API call goes through here so the bearer token (when the
// Tauri host minted one) rides along on the Authorization header. In a plain
// browser AUTH_TOKEN is null and this is a straight fetch. Header merging uses
// Headers so it's robust to whatever shape the caller passed.
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (AUTH_TOKEN) headers.set("Authorization", `Bearer ${AUTH_TOKEN}`);
  return fetch(input, { ...init, headers });
}

async function parseResponse<T>(
  response: Response,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = errorResponseSchema.parse(await response.json()).error;
    } catch {}
    throw new Error(message);
  }
  return schema.parse(await response.json());
}

async function parseOptionalOk(response: Response): Promise<OkResponse | null> {
  if (response.status === 204) return null;
  return parseResponse(response, okResponseSchema);
}

export async function getResourceStats(): Promise<ResourceStats> {
  return parseResponse(await apiFetch(`${API_BASE}/api/stats`), resourceStatsSchema);
}

// Whether a newer app version is available. The server resolves the latest
// version + compares locally (counting stays gated to once/day). In dev/browser
// it returns a no-op status. `force` re-resolves now for the manual button.
export async function getUpdateStatus(force = false): Promise<UpdateStatus> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/update${force ? "?force=1" : ""}`),
    updateStatusSchema,
  );
}

export async function getUsageStats(profile: string): Promise<UsageStats> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/usage${profileQuery(profile)}`),
    usageStatsSchema,
  );
}

// Persisted daily usage series powering the contribution-graph heatmap.
// Separate from getUsageStats: it's local-only and not gated by the upstream
// rate-limit cache, so it can refresh independently and cheaply.
export async function getUsageHistory(profile: string): Promise<UsageHistory> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/usage/history${profileQuery(profile)}`),
    usageHistorySchema,
  );
}

// Trigger a (re)build of the profile's image. Returns the updated profile
// (build status flips to "building").
export async function rebuildProfile(id: string): Promise<ProfileSummary> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/rebuild`, {
      method: "POST",
    }),
    profileSummarySchema,
  );
}

// Secrets the profile declares, each flagged with whether a value is stored.
// The value itself is never returned, only its presence.
export async function listProfileSecrets(id: string): Promise<ProfileSecret[]> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/secrets`),
    profileSecretArraySchema,
  );
}

export async function setProfileSecret(
  id: string,
  env: string,
  value: string,
): Promise<ProfileSecret> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/secrets/${encodeURIComponent(env)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setProfileSecretBodySchema.parse({ value })),
    }),
    profileSecretSchema,
  );
}

export async function clearProfileSecret(id: string, env: string): Promise<ProfileSecret> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/secrets/${encodeURIComponent(env)}`, {
      method: "DELETE",
    }),
    profileSecretSchema,
  );
}

// Replace-all of a profile's declared secrets (env var names + host scoping),
// written back to its config.toml. Returns the updated declarations, each
// flagged with whether a value is stored.
export async function setSecretDeclarations(
  id: string,
  declarations: SecretDeclaration[],
): Promise<ProfileSecret[]> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/secret-declarations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setSecretDeclarationsBodySchema.parse({ declarations })),
    }),
    profileSecretArraySchema,
  );
}

// ---- Profile config (build definition) editing ----
// A profile's config.toml + Dockerfile, editable from the UI. `getProfileConfig`
// returns the structured form (null with a parseError when the file is
// malformed) and the resolved Dockerfile. The writers all return the fresh view
// so the caller re-syncs in one round trip.

export async function getProfileConfig(id: string): Promise<ProfileConfigView> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/config`),
    profileConfigViewSchema,
  );
}

export async function setProfileConfigForm(
  id: string,
  form: ProfileConfigForm,
): Promise<ProfileConfigView> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setProfileConfigFormBodySchema.parse({ form })),
    }),
    profileConfigViewSchema,
  );
}

export async function setDockerfile(id: string, content: string): Promise<void> {
  await parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/dockerfile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setDockerfileBodySchema.parse({ content })),
    }),
    okResponseSchema,
  );
}

// ---- Profiles ----
// A profile is the whole unit: identity (auth, appearance, git, network,
// secrets) and a single build definition. Switching the active profile re-skins
// the whole app. The client reloads after a switch so every panel re-reads it.
export async function listProfiles(): Promise<ProfileSummary[]> {
  return parseResponse(await apiFetch(`${API_BASE}/api/profiles`), profileSummaryArraySchema);
}

export async function getProfile(id: string): Promise<ProfileSummary> {
  return parseResponse(await apiFetch(`${API_BASE}/api/profiles/${id}`), profileSummarySchema);
}

export async function createProfile(name: string): Promise<ProfileSummary> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createProfileBodySchema.parse({ name })),
    }),
    profileSummarySchema,
  );
}

export async function cloneProfile(sourceId: string, name: string): Promise<ProfileSummary> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${sourceId}/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createProfileBodySchema.parse({ name })),
    }),
    profileSummarySchema,
  );
}

export async function renameProfile(id: string, name: string): Promise<ProfileSummary> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(renameProfileBodySchema.parse({ name })),
    }),
    profileSummarySchema,
  );
}

export async function deleteProfile(id: string): Promise<void> {
  await parseOptionalOk(await apiFetch(`${API_BASE}/api/profiles/${id}`, { method: "DELETE" }));
}

// Tell the server this window is using `id` (on boot, on switch, and as a
// periodic heartbeat) so it keeps the profile's warm titling VM alive. Best
// effort. Callers ignore failures, and titling falls back to the instance VM.
export async function activateProfile(id: string, clientId: string): Promise<void> {
  await apiFetch(`${API_BASE}/api/profiles/${id}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId }),
  });
}

// Fire-and-forget on window unload (pagehide) so the profile's warm titling VM
// is released once no window is using it. Uses sendBeacon (no preflight, no
// awaiting) with a keepalive fetch fallback, mirroring beaconDeleteInstance.
export function beaconDeactivateProfile(id: string, clientId: string): void {
  const body = JSON.stringify({ clientId });
  try {
    // sendBeacon can't set an Authorization header, so the token rides on the URL.
    navigator.sendBeacon(
      withAuthToken(`${API_BASE}/api/profiles/${id}/deactivate`),
      new Blob([body], { type: "application/json" }),
    );
  } catch {}
  try {
    void apiFetch(`${API_BASE}/api/profiles/${id}/deactivate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {}
}

export async function getProfileAppearance(id: string): Promise<Appearance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/appearance`),
    appearanceSchema,
  );
}

export async function setProfileAppearance(
  id: string,
  appearance: Appearance,
): Promise<Appearance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/appearance`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appearanceSchema.parse(appearance)),
    }),
    appearanceSchema,
  );
}

// ---- Agent auth (Claude / Codex in-app login), per profile ----
const profileQuery = (profile: string) => `?profile=${encodeURIComponent(profile)}`;

export async function getAuthStatus(profile: string): Promise<AuthStatus> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/auth${profileQuery(profile)}`),
    authStatusSchema,
  );
}

export async function startLogin(provider: AuthProvider, profile: string): Promise<LoginSession> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/auth/${provider}/login${profileQuery(profile)}`, {
      method: "POST",
    }),
    loginSessionSchema,
  );
}

export async function getLoginStatus(sessionId: string): Promise<LoginSession> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/auth/login/${sessionId}`),
    loginSessionSchema,
  );
}

export async function cancelLogin(sessionId: string): Promise<void> {
  await apiFetch(`${API_BASE}/api/auth/login/${sessionId}/cancel`, {
    method: "POST",
  }).catch(() => {});
}

export async function logoutProvider(
  provider: AuthProvider,
  profile: string,
): Promise<ProviderAuthStatus> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/auth/${provider}/logout${profileQuery(profile)}`, {
      method: "POST",
    }),
    providerAuthStatusSchema,
  );
}

// ---- Agent git config: committer identity + commit signing, per profile ----
export async function getGitConfig(profile: string): Promise<GitConfigStatus> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/git${profileQuery(profile)}`),
    gitConfigStatusSchema,
  );
}

export async function setGitIdentity(
  profile: string,
  body: SetGitIdentityBody,
): Promise<GitConfigStatus> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/git/identity${profileQuery(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setGitIdentityBodySchema.parse(body)),
    }),
    gitConfigStatusSchema,
  );
}

export async function listSigningKeys(
  profile: string,
  socket?: string,
): Promise<SigningKeysResult> {
  const qs = `${profileQuery(profile)}${socket ? `&socket=${encodeURIComponent(socket)}` : ""}`;
  return parseResponse(
    await apiFetch(`${API_BASE}/api/git/signing/keys${qs}`),
    signingKeysResultSchema,
  );
}

export async function setSigning(
  profile: string,
  body: SetSigningConfigBody,
): Promise<GitConfigStatus> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/git/signing${profileQuery(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setSigningConfigBodySchema.parse(body)),
    }),
    gitConfigStatusSchema,
  );
}

export async function disableSigning(profile: string): Promise<GitConfigStatus> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/git/signing/disable${profileQuery(profile)}`, {
      method: "POST",
    }),
    gitConfigStatusSchema,
  );
}

export async function getNetworkConfig(profile: string): Promise<NetworkConfig> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/network${profileQuery(profile)}`),
    networkConfigSchema,
  );
}

export async function setNetworkConfig(
  profile: string,
  body: NetworkConfig,
): Promise<NetworkConfig> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/network${profileQuery(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(networkConfigSchema.parse(body)),
    }),
    networkConfigSchema,
  );
}

export async function getRuntimeConfig(profile: string): Promise<RuntimeConfig> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/runtime${profileQuery(profile)}`),
    runtimeConfigSchema,
  );
}

export async function setRuntimeConfig(
  profile: string,
  body: RuntimeConfig,
): Promise<RuntimeConfig> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/runtime${profileQuery(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runtimeConfigSchema.parse(body)),
    }),
    runtimeConfigSchema,
  );
}

export async function getPromptConfig(profile: string): Promise<PromptConfig> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/prompt${profileQuery(profile)}`),
    promptConfigSchema,
  );
}

export async function setPromptConfig(profile: string, body: PromptConfig): Promise<PromptConfig> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/prompt${profileQuery(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptConfigSchema.parse(body)),
    }),
    promptConfigSchema,
  );
}

export async function updateInstanceTitle(id: string, body: UpdateInstanceBody): Promise<Instance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updateInstanceBodySchema.parse(body)),
    }),
    instanceSchema,
  );
}

export async function listInstances(): Promise<Instance[]> {
  return parseResponse(await apiFetch(`${API_BASE}/api/instances`), instanceArraySchema);
}

export async function createInstance(body: CreateInstanceBody): Promise<Instance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createInstanceBodySchema.parse(body)),
    }),
    instanceSchema,
  );
}

export async function deleteInstance(id: string): Promise<void> {
  await parseOptionalOk(await apiFetch(`${API_BASE}/api/instances/${id}`, { method: "DELETE" }));
}

// Archive a chat: stops its VM and hides it under the sidebar's "Archived"
// disclosure. Returns the updated instance (status "stopped", archived true).
export async function archiveInstance(id: string): Promise<Instance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}/archive`, {
      method: "POST",
    }),
    instanceSchema,
  );
}

// Unarchive a chat: clears the flag and boots its VM back up. Returns the
// updated instance (archived false, status "restarting" then "running").
export async function unarchiveInstance(id: string): Promise<Instance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}/unarchive`, {
      method: "POST",
    }),
    instanceSchema,
  );
}

// Pin a chat: lifts it into the sidebar's "Pinned" section. Returns the updated
// instance (pinned true). No VM lifecycle change, unlike archive.
export async function pinInstance(id: string): Promise<Instance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}/pin`, {
      method: "POST",
    }),
    instanceSchema,
  );
}

// Unpin a chat: drops it back into the main list. Returns the updated instance
// (pinned false).
export async function unpinInstance(id: string): Promise<Instance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}/unpin`, {
      method: "POST",
    }),
    instanceSchema,
  );
}

// Clear the archive: permanently delete every archived chat of the given
// profile. The scope is mandatory (the server refuses an unscoped clear), so
// a missing active profile can never fan out into deleting every profile's
// archive.
export async function clearArchive(profileId: string): Promise<void> {
  await parseOptionalOk(
    await apiFetch(
      `${API_BASE}/api/instances/archive/clear?profile=${encodeURIComponent(profileId)}`,
      { method: "POST" },
    ),
  );
}

// Detach a pull request from a chat. The badge is added via the in-VM
// `isolade pr add` CLI; this backs the badge's remove affordance. The ref is
// the attachment's full (host, owner, repo, number) key.
export async function detachInstancePr(id: string, ref: PrRefBody): Promise<void> {
  await parseOptionalOk(
    await apiFetch(`${API_BASE}/api/instances/${id}/prs`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ref),
    }),
  );
}

// Clear an instance's unread flag because the user is viewing it. Fire-and-
// forget: the caller clears local state optimistically, and a lost request
// just self-heals on the next turn-complete/read cycle.
export async function markInstanceRead(id: string): Promise<void> {
  await parseOptionalOk(await apiFetch(`${API_BASE}/api/instances/${id}/read`, { method: "POST" }));
}

export async function restartInstance(id: string): Promise<Instance> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}/restart`, {
      method: "POST",
    }),
    instanceSchema,
  );
}

// Fire-and-forget cleanup used on `beforeunload` so a typed-but-unsent draft
// doesn't leave its VM behind. Uses sendBeacon (no preflight, no awaiting).
export function beaconDeleteInstance(id: string): void {
  try {
    // sendBeacon can't set an Authorization header, so the token rides on the URL.
    navigator.sendBeacon(
      withAuthToken(`${API_BASE}/api/instances/${id}`),
      new Blob([""], { type: "text/plain" }),
    );
  } catch {}
  // Fallback: a regular fire-and-forget DELETE.
  try {
    void apiFetch(`${API_BASE}/api/instances/${id}`, {
      method: "DELETE",
      keepalive: true,
    });
  } catch {}
}

export async function listPorts(id: string): Promise<PortForward[]> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}/ports`),
    portForwardArraySchema,
  );
}

export async function addPortForward(id: string, remotePort: number): Promise<PortForward> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}/ports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remotePort }),
    }),
    portForwardSchema,
  );
}

export async function removePortForward(id: string, remotePort: number): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/instances/${id}/ports/${remotePort}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`removePortForward failed: ${res.status}`);
}

export async function getPortProbe(id: string): Promise<PortProbe> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${id}/port-status`),
    portProbeSchema,
  );
}

// ---- Workspace file tree ----
// All paths are absolute inside the VM (rooted at /workspace). The directory
// listing is lazy: the tree calls this once per expanded folder.
export async function listFiles(instanceId: string, path?: string): Promise<FileListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/files${qs}`),
    fileListingSchema,
  );
}

// ---- Workspace review diff ----
// The PR-style diff of the instance's workspace against its base branch, parsed
// server-side into per-file hunks for the Review tab.
export async function getWorkspaceDiff(
  instanceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceDiff> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/diff`, { signal }),
    workspaceDiffSchema,
  );
}

// Read an inclusive 1-based line range from a workspace file, used by the
// Review tab to expand unchanged context around a hunk. `path` is the diff's
// repo-relative file path. The server confines it to /workspace.
export async function getFileLines(
  instanceId: string,
  path: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<FileLines> {
  const qs = `?path=${encodeURIComponent(path)}&start=${start}&end=${end}`;
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/file-lines${qs}`, {
      signal,
    }),
    fileLinesSchema,
  );
}

export async function deleteFile(instanceId: string, path: string): Promise<void> {
  await parseOptionalOk(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/files/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(filePathBodySchema.parse({ path })),
    }),
  );
}

export async function renameFile(instanceId: string, from: string, to: string): Promise<void> {
  await parseOptionalOk(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(renameFileBodySchema.parse({ from, to })),
    }),
  );
}

export async function createFolder(instanceId: string, path: string): Promise<void> {
  await parseOptionalOk(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/files/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(filePathBodySchema.parse({ path })),
    }),
  );
}

export async function createFile(instanceId: string, path: string): Promise<void> {
  await parseOptionalOk(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/files/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(filePathBodySchema.parse({ path })),
    }),
  );
}

// Encode bytes to base64 in chunks. A single String.fromCharCode(...bytes)
// blows the call stack on large files, so we fold a few KB at a time.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function uploadFile(
  instanceId: string,
  path: string,
  data: ArrayBuffer,
): Promise<void> {
  const content = bytesToBase64(new Uint8Array(data));
  await parseOptionalOk(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(uploadFileBodySchema.parse({ path, content })),
    }),
  );
}

// Terminals
export async function listTerminals(instanceId: string): Promise<Terminal[]> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/terminals`),
    terminalArraySchema,
  );
}

export async function createTerminal(instanceId: string): Promise<Terminal> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/terminals`, {
      method: "POST",
    }),
    terminalSchema,
  );
}

export async function listChats(): Promise<Chat[]> {
  return parseResponse(await apiFetch(`${API_BASE}/api/chats`), chatArraySchema);
}

// The full static catalog (Claude + Codex). Per-profile visibility/tier is
// layered on client-side via the profile's model overrides.
export async function listChatModels(): Promise<ChatModelsResponse> {
  return parseResponse(await apiFetch(`${API_BASE}/api/chat/models`), chatModelsResponseSchema);
}

export async function getProfileModelOverrides(id: string): Promise<ModelOverridesPayload> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/models`),
    modelOverridesSchema,
  );
}

export async function setProfileModelOverrides(
  id: string,
  overrides: ModelOverridesPayload,
): Promise<ModelOverridesPayload> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/profiles/${id}/models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(modelOverridesSchema.parse(overrides)),
    }),
    modelOverridesSchema,
  );
}

export async function createChat(instanceId: string, body: CreateChatBody): Promise<Chat> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createChatBodySchema.parse(body)),
    }),
    chatSchema,
  );
}

export async function updateChatModel(
  instanceId: string,
  chatId: string,
  body: UpdateChatBody,
): Promise<Chat> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updateChatBodySchema.parse(body)),
    }),
    chatSchema,
  );
}

// Switch the chat's visible branch (version navigation on an edited
// message). `leafId` may be any message on the target branch, and the server
// descends to that branch's tip and re-points the provider session. Returns
// the updated chat row (its activeLeafId is the resolved tip).
export async function setChatActiveLeaf(
  instanceId: string,
  chatId: string,
  leafId: string,
): Promise<Chat> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/chats/${chatId}/active-leaf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setActiveLeafBodySchema.parse({ leafId })),
    }),
    chatSchema,
  );
}

export async function deleteChat(instanceId: string, chatId: string): Promise<void> {
  await parseOptionalOk(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/chats/${chatId}`, {
      method: "DELETE",
    }),
  );
}

export async function listChatMessages(
  instanceId: string,
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/chats/${chatId}/messages`, { signal }),
    chatMessageArraySchema,
  );
}

// Returns every persisted SSE event for the chat, ordered by
// (messageId, seq). Used by the chat UI on mount to rebuild tool calls,
// thinking blocks, and per-turn usage snapshots for past assistant turns.
export async function listChatEvents(
  instanceId: string,
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatEvent[]> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/chats/${chatId}/events`, { signal }),
    chatEventArraySchema,
  );
}

export async function getChatContextBreakdown(
  instanceId: string,
  chatId: string,
): Promise<ContextBreakdown> {
  return parseResponse(
    await apiFetch(`${API_BASE}/api/instances/${instanceId}/chats/${chatId}/context`),
    contextBreakdownSchema,
  );
}
