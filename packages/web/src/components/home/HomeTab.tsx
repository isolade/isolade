import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { TITLE_BAR_WITH_INSET_HEIGHT } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWindowDrag } from "@/lib/window-drag";
import { getClientId, resolveActiveProfileId } from "../../lib/activeProfile";
import {
  activateProfile,
  archiveInstance,
  beaconDeactivateProfile,
  clearArchive,
  createChat,
  detachInstancePr,
  getProfileModelOverrides,
  listChatModels,
  listChats,
  listInstances,
  listTerminals,
  markInstanceRead,
  pinInstance,
  deleteInstance as removeInstance,
  restartInstance,
  unarchiveInstance,
  unpinInstance,
  updateInstanceTitle,
} from "../../lib/api";
import type {
  AttachedPr,
  Chat,
  ChatEffort,
  ChatModelDefinition,
  Instance,
  ModelOverrides,
  Terminal,
} from "../../lib/contracts";
import { DEFAULT_CHAT_MODEL_ID } from "../../lib/contracts";
import SettingsPane, {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSection,
  type SettingsSection,
} from "../SettingsPane";
import UpdateBanner from "../UpdateBanner";
import InstancesSidebar from "./InstancesSidebar";
import NewInstancePane from "./NewInstancePane";
import RetainedInstancePane from "./RetainedInstancePane";
import WindowChrome from "./WindowChrome";

type View = { kind: "drafting" } | { kind: "instance"; id: string };

/**
 * A chat started from the empty-state composer, from the moment the user
 * presses send until they navigate away from it.
 *
 * Sending has to feel instant, but the instance behind it is a VM that takes
 * seconds to come up, so the workspace is rendered against client-side stand-in
 * rows first. It is the *real* workspace from the first frame — the same
 * retained pane, panel tree and tab strip an established chat gets — so there
 * is no chrome-less intermediate view to blink out of.
 *
 * When the server rows land they are adopted in place rather than swapped in:
 * the pane keeps its React key (see `paneKeysRef`) and the workspace remaps its
 * stand-in chat id onto the real one, so every tab, split, draft and scroll
 * position the user has already touched survives the hand-off untouched.
 */
interface Draft {
  standInInstanceId: string;
  standInChatId: string;
  // Rendered until the server's own rows arrive through the usual state.
  instance: Instance;
  chats: Chat[];
  // Null until the create round-trip lands.
  instanceId: string | null;
  chatId: string | null;
  firstMessage: string;
  uploadIds: string[];
  error: string | null;
}

function apiValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function apiRowEqual<T extends { id: string }>(left: T, right: T): boolean {
  const keys = Object.keys(left) as (keyof T)[];
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => apiValueEqual(left[key], right[key]));
}

function reconcileApiRows<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const reconciled = incoming.map((row) => {
    const existing = previousById.get(row.id);
    return existing && apiRowEqual(existing, row) ? existing : row;
  });
  return reconciled.length === previous.length &&
    reconciled.every((row, index) => row === previous[index])
    ? previous
    : reconciled;
}

// Chats grouped by instance, where a group keeps its identity as long as its
// members do. Every retained pane takes its group as a prop, so a rebuilt-from-
// scratch map would hand all of them a fresh array on each 3s chat poll and
// defeat their memoization. Only the instance whose chats actually moved gets a
// new array.
function reconcileChatGroups(
  previous: ReadonlyMap<string, Chat[]>,
  chats: Chat[],
): Map<string, Chat[]> {
  const grouped = new Map<string, Chat[]>();
  for (const chat of chats) {
    const existing = grouped.get(chat.instanceId);
    if (existing) existing.push(chat);
    else grouped.set(chat.instanceId, [chat]);
  }
  for (const [instanceId, group] of grouped) {
    const before = previous.get(instanceId);
    if (
      before &&
      before.length === group.length &&
      before.every((chat, index) => chat === group[index])
    ) {
      grouped.set(instanceId, before);
    }
  }
  return grouped;
}

const EMPTY_CHATS: Chat[] = [];
const EMPTY_TERMINALS: Terminal[] = [];
const EMPTY_REMAP: Record<string, string> = {};

// The stand-in row a draft renders `id` from, while it has no server row yet.
function draftInstance(draft: Draft | null, id: string): Instance | null {
  return draft && draft.instanceId === null && draft.standInInstanceId === id
    ? draft.instance
    : null;
}

// Pathname-based routing: /c/<id> deep-links to a specific instance. Relies
// on Vite's built-in SPA fallback in dev and Tauri's webview serving index.html
// for unknown paths in prod. In-app navigation uses history.pushState so no
// reload is involved on click.
function viewToPath(view: View): string {
  if (view.kind === "instance") return `/c/${view.id}`;
  return "/";
}

function pathToView(pathname: string): View | null {
  const m = pathname.match(/^\/c\/(.+)$/);
  if (m?.[1]) return { kind: "instance", id: decodeURIComponent(m[1]) };
  if (pathname === "/" || pathname === "" || pathname === "/new") return { kind: "drafting" };
  return null;
}

// Settings is an overlay layered over the background view, not a view of its
// own, so a /settings/<section> path is parsed independently and leaves the
// background view (and its mounted, state-bearing components: chat scroll,
// composer drafts, terminals) untouched.
function parseSettingsSection(pathname: string): SettingsSection | null {
  const s = pathname.match(/^\/settings(?:\/([^/]+))?$/);
  if (!s) return null;
  const section = s[1];
  return section && isSettingsSection(section) ? section : DEFAULT_SETTINGS_SECTION;
}

interface HomeTabProps {
  isTauri: boolean;
}

// Left-sidebar collapse lives here (not in InstancesSidebar) because the title
// bar now owns the toggle and the body decides whether to mount the sidebar at
// all. Key is unchanged so already-persisted state carries over.
const SIDEBAR_COLLAPSED_KEY = "isolade.sidebarCollapsed";

function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function HomeTab({ isTauri }: HomeTabProps) {
  const [instances, setInstances] = useState<Instance[]>([]);
  // Latest rows for handlers that only need to read one, so they can stay
  // referentially stable across the once-a-second poll.
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  const [renaming, setRenaming] = useState<{
    id: string;
    title: string;
  } | null>(null);
  // Set while the "Delete archived" confirmation dialog is open, and again while
  // the delete-all request is in flight (so the dialog's buttons disable).
  const [confirmingClearArchive, setConfirmingClearArchive] = useState(false);
  const [clearingArchive, setClearingArchive] = useState(false);
  // Id of the chat whose single-delete confirmation dialog is open (null when
  // closed), plus a flag set while that delete is in flight.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [chatModels, setChatModels] = useState<ChatModelDefinition[]>([]);
  const [modelOverrides, setModelOverrides] = useState<ModelOverrides>({});
  const [allChats, setAllChats] = useState<Chat[]>([]);
  const [terminalsByInstance, setTerminalsByInstance] = useState<Record<string, Terminal[]>>({});
  const [view, setView] = useState<View>(
    () => pathToView(window.location.pathname) ?? { kind: "drafting" },
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  // Instance id → the React key of the pane that renders it. A draft's pane is
  // created before the server row exists, so it is keyed by its stand-in id and
  // keeps that key once the real instance adopts it; anything else is keyed by
  // its own id. Session-lifetime, because a key that changes under a pane would
  // rebuild the very workspace the adoption exists to preserve.
  const paneKeysRef = useRef<Map<string, string>>(new Map());
  // Stable, append-only pane order. Panes are absolutely positioned so their
  // order is invisible, but reordering them would move their subtrees in the
  // DOM, which reloads any browser-preview <iframe> inside. The recency-sorted
  // instance list reorders constantly, and an adopted draft's pane would jump
  // from the end of the list to the front, so the order is pinned to when each
  // pane first appeared instead. (Same trick as the body layer in
  // PanelWorkspace, for the same reason.)
  const paneOrderRef = useRef<Map<string, number>>(new Map());
  const paneOrderSeqRef = useRef(0);
  // Settings overlay, orthogonal to `view`. Non-null while open. Kept separate
  // so opening settings never tears down the background workspace.
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(() =>
    parseSettingsSection(window.location.pathname),
  );
  // The active profile (server-owned) drives new chats and scopes the sidebar.
  // A profile IS the buildable unit, so its id is all we need. Switching
  // profiles happens in Settings and reloads the app, so this is fetched once.
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profileId = await resolveActiveProfileId();
        if (!cancelled) setActiveProfileId(profileId);
      } catch {
        // Profiles API unavailable (e.g. demo mock), so leave unscoped.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Tell the server this window is using the active profile so it keeps a warm
  // titling VM ready (titles then appear instantly instead of waiting on a new
  // instance's cold boot). Heartbeat so a still-open window is never reaped, and a
  // pagehide beacon releases the profile on close. On a profile switch the app
  // reloads: pagehide releases the old profile, and the remount re-activates the
  // new one, so this needs no special switch handling.
  useEffect(() => {
    if (!activeProfileId) return;
    const profileId = activeProfileId;
    const clientId = getClientId();
    const ping = () => void activateProfile(profileId, clientId).catch(() => {});
    ping();
    const heartbeat = setInterval(ping, 2 * 60_000);
    const onHide = () => beaconDeactivateProfile(profileId, clientId);
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("pagehide", onHide);
      beaconDeactivateProfile(profileId, clientId);
    };
  }, [activeProfileId]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(loadSidebarCollapsed);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  // The sidebar toggle sits in the window chrome, where, on the native build,
  // some clicks land on a spot whose mousedown the OS swallows before the
  // webview sees it. No mousedown means the browser never synthesises a `click`,
  // so an `onClick` handler silently misses those presses. The mouse*up* does
  // reach us, though, so WindowChrome fires the toggle from both `click` and
  // `mouseup`, deduped here so a normal press (which delivers both) toggles once.
  const lastToggleRef = useRef(0);
  const fireToggle = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleRef.current < 250) return;
    lastToggleRef.current = now;
    toggleSidebar();
  }, [toggleSidebar]);

  // Measured width of the floating window-chrome cluster, used to inset the
  // top-left panel's tab strip so its tabs clear the traffic lights / controls.
  const [chromeWidth, setChromeWidth] = useState(0);

  // Window-drag handlers reused by the sidebar's top strip and the settings
  // overlay's top strip (the panel tab strips get their own inside the workspace).
  const windowDrag = useWindowDrag(isTauri);

  const refreshInstances = useCallback(async () => {
    try {
      // The server returns instances in a total, deterministic recency order
      // (updatedAt desc, then createdAt desc, then id). See InstanceManager.list.
      // We render that order verbatim rather than re-sorting here, so there's a
      // single source of truth and the sidebar order can't disagree with itself.
      const incoming = await listInstances();
      setInstances((previous) => reconcileApiRows(previous, incoming));
    } catch {}
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      const incoming = await listChats();
      setAllChats((previous) => reconcileApiRows(previous, incoming));
    } catch {}
  }, []);

  const refreshTerminalsFor = useCallback(async (instanceId: string) => {
    try {
      const list = await listTerminals(instanceId);
      setTerminalsByInstance((prev) => ({ ...prev, [instanceId]: list }));
    } catch {}
  }, []);

  // Optimistic resource-set sync for the panel workspace: a tab's "+" creates a
  // chat/terminal and immediately registers it here, so it's in the live set
  // before the next poll and the workspace's reconcile can't drop its new tab.
  // Closing a tab unregisters it the same way.
  const registerChat = useCallback((chat: Chat) => {
    setAllChats((prev) => [...prev.filter((c) => c.id !== chat.id), chat]);
  }, []);
  const unregisterChat = useCallback((chatId: string) => {
    setAllChats((prev) => prev.filter((c) => c.id !== chatId));
  }, []);
  const registerTerminal = useCallback((terminal: Terminal) => {
    setTerminalsByInstance((prev) => ({
      ...prev,
      [terminal.instanceId]: [
        ...(prev[terminal.instanceId] ?? []).filter((t) => t.id !== terminal.id),
        terminal,
      ],
    }));
  }, []);
  const unregisterTerminal = useCallback((terminalId: string) => {
    setTerminalsByInstance((prev) => {
      const next: Record<string, Terminal[]> = {};
      for (const [key, list] of Object.entries(prev)) {
        next[key] = list.filter((t) => t.id !== terminalId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    refreshInstances();
    refreshChats();
    // Instances poll fast: they carry the per-VM diff stats, which the
    // server refreshes within ~1s of agent activity, and listing them is a
    // trivial DB read. Chats stay on the slower cadence, since what changes
    // about an open one arrives on its own stream rather than through here.
    const ti = setInterval(refreshInstances, 1000);
    const tc = setInterval(refreshChats, 3000);
    return () => {
      clearInterval(ti);
      clearInterval(tc);
    };
  }, [refreshInstances, refreshChats]);

  // Viewing an instance means its messages are seen, so clear the unread flag.
  // This fires both when you open an unread chat and when a turn completes in
  // the chat you're already viewing (the 1s poll flips `unread` true, and this
  // immediately clears it again). We clear local state optimistically so the
  // title never flashes bold for the chat you're looking at, then persist.
  useEffect(() => {
    if (view.kind !== "instance") return;
    const id = view.id;
    const target = instances.find((c) => c.id === id);
    if (!target?.unread) return;
    setInstances((prev) => prev.map((c) => (c.id === id ? { ...c, unread: false } : c)));
    void markInstanceRead(id).catch(() => {});
  }, [view, instances]);

  // The codex side of the chat-model catalog is environment-scoped: each
  // environment's image ships its own codex binary, and its `model/list` is
  // cached on the environments row after each rebuild. Effective scope: the
  // active instance's profile when one is open, else the active profile (where
  // new chats start).
  // A just-submitted draft has no server row yet, and its stand-in carries the
  // active profile, so it resolves to the same scope either way.
  const effectiveProfileId =
    view.kind === "instance"
      ? ((instances.find((c) => c.id === view.id) ?? draftInstance(draft, view.id))?.profileId ??
        null)
      : activeProfileId;
  // The model catalog is static (Claude + Codex), so fetch it once. Per-profile
  // visibility/tier overrides are layered on below.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { models } = await listChatModels();
        if (!cancelled) setChatModels(models);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The active profile's model overrides (visibility/tier deltas), re-fetched
  // when the effective profile changes and whenever the settings overlay
  // toggles, so edits made on the Models settings page are reflected in the
  // pickers as soon as settings closes.
  useEffect(() => {
    let cancelled = false;
    if (!effectiveProfileId) {
      setModelOverrides({});
      return;
    }
    void (async () => {
      try {
        const overrides = await getProfileModelOverrides(effectiveProfileId);
        if (!cancelled) setModelOverrides(overrides);
      } catch {
        if (!cancelled) setModelOverrides({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveProfileId, settingsSection]);

  // A draft whose server rows haven't landed. Its pane renders from stand-ins,
  // so anything that talks to the server about it has to wait.
  const draftPending = draft !== null && draft.instanceId === null;
  const viewingPendingDraft =
    draftPending && view.kind === "instance" && view.id === draft.standInInstanceId;

  // Whenever the active instance changes, refresh its terminal list.
  useEffect(() => {
    if (view.kind !== "instance" || viewingPendingDraft) return;
    void refreshTerminalsFor(view.id);
  }, [view, viewingPendingDraft, refreshTerminalsFor]);

  // Monotonic id for the in-flight draft submission. Bumped whenever the user
  // navigates away from a submitted draft so the still-resolving createInstance
  // + createChat chain can detect it's been orphaned and clean up.
  const submissionIdRef = useRef(0);

  // True while we're applying a popstate to view state, so the view→URL effect
  // doesn't push another history entry on top of the one the browser just
  // popped.
  const applyingPopRef = useRef(false);

  // view/settings → URL.
  useEffect(() => {
    if (applyingPopRef.current) {
      applyingPopRef.current = false;
      return;
    }
    // A submitted draft keeps the pre-submit URL until the real instance id
    // lands (a stand-in id is not a route), but the settings overlay is
    // orthogonal and must still sync.
    if (settingsSection === null && viewingPendingDraft) return;
    const target = settingsSection ? `/settings/${settingsSection}` : viewToPath(view);
    if (window.location.pathname === target) return;
    // Switching sections within settings replaces the entry rather than
    // stacking one per tab, so Back leaves settings instead of cycling tabs.
    const stayingInSettings =
      settingsSection !== null && window.location.pathname.startsWith("/settings");
    if (stayingInSettings) window.history.replaceState(null, "", target);
    else window.history.pushState(null, "", target);
  }, [view, viewingPendingDraft, settingsSection]);

  // URL → view/settings (browser back/forward). A /settings/* path only toggles
  // the overlay. pathToView returns null for it, so the background view (and its
  // mounted components) is left untouched and closing settings returns there.
  useEffect(() => {
    const sync = () => {
      const path = window.location.pathname;
      const nextView = pathToView(path);
      applyingPopRef.current = true;
      // Only orphan an in-flight draft when the background view actually
      // changes. A pure settings toggle leaves a submitted draft running.
      if (nextView) {
        submissionIdRef.current++;
        setDraft(null);
        setView(nextView);
      }
      setSettingsSection(parseSettingsSection(path));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Everything the sidebar is handed is a stable identity, so a poll that
  // touches one instance re-renders that one row rather than the whole list.
  // Navigating releases the current draft: one still being created is orphaned
  // by the submissionId bump, and one already adopted has nothing left to hand
  // over — its pane is an ordinary instance pane from here on.
  const handleNew = useCallback(() => {
    submissionIdRef.current++;
    setDraft(null);
    setView({ kind: "drafting" });
  }, []);

  const handleSelect = useCallback((id: string) => {
    submissionIdRef.current++;
    setDraft(null);
    setView({ kind: "instance", id });
  }, []);

  // Settings opens as an overlay over the current view, so we leave `view` (and
  // any in-flight draft submission) alone, with no submissionId bump.
  const handleOpenSettings = () => {
    setSettingsSection(DEFAULT_SETTINGS_SECTION);
  };

  const handleSubmitDraft = ({
    instancePromise,
    modelId,
    effort,
    fastMode = false,
    firstMessage,
    uploadIds = [],
  }: {
    instancePromise: Promise<Instance>;
    modelId: string;
    effort: ChatEffort;
    fastMode?: boolean;
    firstMessage: string;
    uploadIds?: string[];
  }) => {
    const sid = ++submissionIdRef.current;
    const now = new Date();
    const standIn: Instance = {
      id: `local-${crypto.randomUUID()}`,
      vmId: "",
      title: null,
      status: "running",
      lastError: null,
      image: "",
      profileId: activeProfileId,
      diffAdded: null,
      diffDeleted: null,
      working: false,
      unread: false,
      archived: false,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    const modelDef = chatModels.find((m) => m.id === modelId);
    const standInChat: Chat = {
      id: `local-${crypto.randomUUID()}`,
      instanceId: standIn.id,
      model: modelId,
      provider: modelDef?.provider ?? "anthropic",
      effort,
      // What the draft asked for, so the composer the user lands in shows the
      // same bolt they just lit rather than blinking off until the real row
      // arrives. The server drops it if the model has no fast rate card, and
      // that row replaces this one.
      fastMode: fastMode && modelDef?.fastPricing != null,
      claudeSessionId: null,
      codexThreadId: null,
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      costUsd: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastCacheCreationInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      modelContextWindow: null,
      compacted: null,
      createdAt: now,
    };
    // The pane that renders this draft is keyed by the stand-in's id (see the
    // pane list), and keeps that key when the real instance adopts it below.
    setDraft({
      standInInstanceId: standIn.id,
      standInChatId: standInChat.id,
      instance: standIn,
      chats: [standInChat],
      instanceId: null,
      chatId: null,
      firstMessage,
      uploadIds,
      error: null,
    });
    setView({ kind: "instance", id: standIn.id });

    const fail = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setDraft((d) => (d && d.standInInstanceId === standIn.id ? { ...d, error: msg } : d));
    };

    (async () => {
      let instance: Instance;
      try {
        instance = await instancePromise;
      } catch (err) {
        if (sid !== submissionIdRef.current) return;
        fail(err);
        return;
      }
      if (sid !== submissionIdRef.current) {
        void removeInstance(instance.id).catch(() => {});
        return;
      }
      let chat: Chat;
      try {
        chat = await createChat(instance.id, { model: modelId, effort, fastMode });
      } catch (err) {
        void removeInstance(instance.id).catch(() => {});
        if (sid !== submissionIdRef.current) return;
        fail(err);
        return;
      }
      if (sid !== submissionIdRef.current) {
        void removeInstance(instance.id).catch(() => {});
        return;
      }
      // The eager spawn may already have surfaced this instance through the
      // poll, in which case it has a pane of its own. Pointing its key at the
      // draft's pane hands the workspace the user is already in over to it and
      // discards the untouched one.
      paneKeysRef.current.set(instance.id, standIn.id);
      // Adoption, in one commit: the real rows, the id remap the workspace
      // applies to its tabs, and the view that follows the instance's route.
      setInstances((prev) => [instance, ...prev.filter((c) => c.id !== instance.id)]);
      setAllChats((prev) => [...prev.filter((c) => c.id !== chat.id), chat]);
      setDraft((d) =>
        d && d.standInInstanceId === standIn.id
          ? { ...d, instanceId: instance.id, chatId: chat.id }
          : d,
      );
      setView({ kind: "instance", id: instance.id });
      void refreshInstances();
    })();
  };

  const handleTitleAutoUpdated = useCallback((instanceId: string, title: string) => {
    setInstances((prev) => prev.map((c) => (c.id === instanceId ? { ...c, title } : c)));
  }, []);

  // Detach a PR badge from a chat. Optimistic: drop it locally so it disappears
  // at once, then persist. The 1s instance poll reconciles either way, so a
  // failed request just self-heals on the next round.
  const handleDetachPr = useCallback(
    (instanceId: string, pr: AttachedPr) => {
      setInstances((prev) =>
        prev.map((c) =>
          c.id === instanceId
            ? {
                ...c,
                prs: (c.prs ?? []).filter(
                  (p) =>
                    !(
                      p.host === pr.host &&
                      p.owner === pr.owner &&
                      p.repo === pr.repo &&
                      p.number === pr.number
                    ),
                ),
              }
            : c,
        ),
      );
      void detachInstancePr(instanceId, {
        host: pr.host,
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
      }).catch(() => void refreshInstances());
    },
    [refreshInstances],
  );

  const handleRename = useCallback((id: string) => {
    const current = instancesRef.current.find((c) => c.id === id);
    setRenaming({ id, title: current?.title ?? "" });
  }, []);

  const submitRename = async (title: string) => {
    if (!renaming) return;
    const id = renaming.id;
    setRenaming(null);
    try {
      const updated = await updateInstanceTitle(id, { title });
      setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      console.error("[home] rename failed", err);
    }
  };

  const handleRestart = useCallback(
    async (id: string) => {
      // Optimistic: flip to "restarting" so the badge appears immediately.
      setInstances((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: "restarting", lastError: null } : c)),
      );
      try {
        const updated = await restartInstance(id);
        setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch (err) {
        // Server side already persisted status=error + lastError, so pull the
        // canonical row so the UI reflects exactly what the server has.
        console.error("[home] restart failed", err);
        void refreshInstances();
      }
    },
    [refreshInstances],
  );

  // Archive a chat: stop its VM and move it into the sidebar's Archived
  // section. Optimistic: flip the row locally so it drops out of the active
  // list at once. The reconcile (and the 1s poll) settle the real state.
  const handleArchive = useCallback(
    async (id: string) => {
      setInstances((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                archived: true,
                status: "stopped",
                working: false,
                unread: false,
              }
            : c,
        ),
      );
      // The archived chat leaves the main list. If we were viewing it, fall back
      // to the draft view (same as the old delete flow).
      setView((v) => (v.kind === "instance" && v.id === id ? { kind: "drafting" } : v));
      try {
        const updated = await archiveInstance(id);
        setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch (err) {
        console.error("[home] archive failed", err);
        void refreshInstances();
      }
    },
    [refreshInstances],
  );

  // Unarchive a chat: clear the flag and boot its VM back up. Optimistic flip
  // to "restarting" so it rejoins the active list immediately.
  const handleUnarchive = useCallback(
    async (id: string) => {
      setInstances((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, archived: false, status: "restarting", lastError: null } : c,
        ),
      );
      try {
        const updated = await unarchiveInstance(id);
        setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch (err) {
        console.error("[home] unarchive failed", err);
        void refreshInstances();
      }
    },
    [refreshInstances],
  );

  // Pin a chat: lift it into the sidebar's Pinned section. Optimistic flip so
  // it jumps sections at once; the 1s poll settles the canonical row (and its
  // recency order). No VM lifecycle, so nothing else changes.
  const handlePin = useCallback(
    async (id: string) => {
      setInstances((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: true } : c)));
      try {
        const updated = await pinInstance(id);
        setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch (err) {
        console.error("[home] pin failed", err);
        void refreshInstances();
      }
    },
    [refreshInstances],
  );

  // Unpin a chat: drop it back into the main list. Optimistic, mirroring pin.
  const handleUnpin = useCallback(
    async (id: string) => {
      setInstances((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: false } : c)));
      try {
        const updated = await unpinInstance(id);
        setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch (err) {
        console.error("[home] unpin failed", err);
        void refreshInstances();
      }
    },
    [refreshInstances],
  );

  // Drop all client-side state tied to a set of just-deleted instances (chats
  // and terminals). Their panel layouts live in the DB and vanish with the
  // instance row.
  const forgetInstances = (ids: Set<string>) => {
    if (ids.size === 0) return;
    setInstances((prev) => prev.filter((c) => !ids.has(c.id)));
    setAllChats((prev) => prev.filter((c) => !ids.has(c.instanceId)));
    setTerminalsByInstance((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  };

  // Clear the archive: permanently delete every archived chat in the active
  // profile (the set the server deletes, mirrored here). Gated by a
  // confirmation dialog since it's destructive and irreversible.
  const handleClearArchive = async () => {
    // No resolved profile (still loading, or the profiles API is down) means
    // no scope to clear safely, so bail rather than guess at one.
    if (activeProfileId == null) {
      setConfirmingClearArchive(false);
      return;
    }
    setClearingArchive(true);
    const ids = new Set(
      instances
        .filter((c) => c.archived && (c.profileId ?? null) === activeProfileId)
        .map((c) => c.id),
    );
    try {
      await clearArchive(activeProfileId);
      forgetInstances(ids);
      if (view.kind === "instance" && ids.has(view.id)) setView({ kind: "drafting" });
    } catch (err) {
      console.error("[home] clear archive failed", err);
      void refreshInstances();
    } finally {
      setClearingArchive(false);
      setConfirmingClearArchive(false);
    }
  };

  // Permanently delete a single chat (active or archived) and its VM. Gated by
  // a confirmation dialog since it's destructive and irreversible, mirroring
  // the "Delete archived" flow.
  const handleDelete = async (id: string) => {
    setDeleting(true);
    try {
      await removeInstance(id);
      forgetInstances(new Set([id]));
      if (view.kind === "instance" && view.id === id) setView({ kind: "drafting" });
    } catch (err) {
      console.error("[home] delete failed", err);
      void refreshInstances();
    } finally {
      setDeleting(false);
      setConfirmingDelete(null);
    }
  };

  const activeInstanceId = view.kind === "instance" ? view.id : null;
  // Written during render on purpose: it only carries the previous grouping so
  // unchanged groups can keep their identity. A discarded render leaves behind
  // groups holding the same chat rows, so the next one still reconciles
  // correctly against them.
  const chatGroupsRef = useRef<ReadonlyMap<string, Chat[]>>(new Map());
  const chatsByInstance = useMemo(() => {
    const grouped = reconcileChatGroups(chatGroupsRef.current, allChats);
    chatGroupsRef.current = grouped;
    return grouped;
  }, [allChats]);
  // A live instance keeps its complete chat subtree and DOM. Sidebar
  // navigation only changes which retained pane is visible, so parsed
  // Markdown, disclosure state, drafts, and scroll position survive.
  // Archived instances are released unless one is currently being viewed.
  const retainedInstances = useMemo(
    () =>
      instances.filter(
        (instance) =>
          (!instance.archived && (instance.profileId ?? null) === activeProfileId) ||
          instance.id === activeInstanceId,
      ),
    [activeInstanceId, activeProfileId, instances],
  );
  // What actually gets rendered: one pane per retained instance, plus the pane
  // of a submitted draft the server hasn't caught up with yet. Once it has, the
  // draft's instance is retained like any other and simply keeps the pane it
  // already had (`paneKeysRef`), so the hand-off costs nothing on screen.
  const panes = useMemo(() => {
    const paneKeys = paneKeysRef.current;
    const rows = retainedInstances.map((instance) => ({
      key: paneKeys.get(instance.id) ?? instance.id,
      instance,
      pending: false,
      chats: chatsByInstance.get(instance.id) ?? EMPTY_CHATS,
      terminals: terminalsByInstance[instance.id] ?? EMPTY_TERMINALS,
    }));
    if (draft && draft.instanceId === null) {
      rows.push({
        key: draft.standInInstanceId,
        instance: draft.instance,
        pending: true,
        chats: draft.chats,
        terminals: EMPTY_TERMINALS,
      });
    }
    for (const row of rows) {
      if (!paneOrderRef.current.has(row.key)) {
        paneOrderRef.current.set(row.key, paneOrderSeqRef.current++);
      }
    }
    rows.sort(
      (a, b) => (paneOrderRef.current.get(a.key) ?? 0) - (paneOrderRef.current.get(b.key) ?? 0),
    );
    return rows;
  }, [retainedInstances, chatsByInstance, terminalsByInstance, draft]);

  // Retire the bookkeeping of panes that are gone, so neither map grows for the
  // lifetime of the window. After commit rather than during render, so a
  // discarded render can't drop a live pane's order slot and re-append it.
  useEffect(() => {
    const live = new Set(panes.map((pane) => pane.key));
    for (const key of paneOrderRef.current.keys()) {
      if (!live.has(key)) paneOrderRef.current.delete(key);
    }
    for (const [instanceId, key] of paneKeysRef.current) {
      if (!live.has(key)) paneKeysRef.current.delete(instanceId);
    }
  }, [panes]);

  const activePane = panes.find((pane) => pane.instance.id === activeInstanceId) ?? null;
  // The first message is handed to the chat tab that has to send it, under
  // whichever id that chat currently has.
  const draftFirstMessage = useMemo(
    () =>
      draft
        ? {
            chatId: draft.chatId ?? draft.standInChatId,
            content: draft.firstMessage,
            uploadIds: draft.uploadIds,
          }
        : null,
    [draft],
  );
  // Handed to the adopted workspace so its stand-in chat tab picks up the real
  // chat in place, instead of being dropped and re-added at the end of the strip.
  const draftRemap = useMemo(
    () => (draft?.chatId ? { [draft.standInChatId]: draft.chatId } : EMPTY_REMAP),
    [draft],
  );

  // Sidebar only shows instances whose title has landed (either the
  // auto-generated one or the server-side truncation fallback). Untitled
  // rows include pre-submit drafts and the brief window between submit and
  // first title event. Each remaining chat lands in exactly one section:
  // archived (its own collapsed disclosure), else pinned (the "Pinned" heading
  // at the top), else the main active list.
  const { archivedInstances, pinnedInstances, activeInstances } = useMemo(() => {
    const sidebarInstances = instances.filter(
      (c) => c.title !== null && c.title.trim() !== "" && (c.profileId ?? null) === activeProfileId,
    );
    return {
      archivedInstances: sidebarInstances.filter((c) => c.archived),
      pinnedInstances: sidebarInstances.filter((c) => !c.archived && c.pinned),
      activeInstances: sidebarInstances.filter((c) => !c.archived && !c.pinned),
    };
  }, [activeProfileId, instances]);

  const handleRequestDelete = useCallback((id: string) => setConfirmingDelete(id), []);
  const handleRequestClearArchive = useCallback(() => setConfirmingClearArchive(true), []);

  // Dropping the overlay reveals the untouched background view (same instance,
  // same scroll position), so there's nothing to restore here.
  const handleCloseSettings = () => {
    setSettingsSection(null);
  };

  const settingsOpen = settingsSection !== null;

  // Only draw an edge where the content meets another surface. Window edges
  // stay flush and unframed; internal panel boundaries are owned by the panel
  // tree itself.
  const contentFrame = !sidebarCollapsed ? "border-l border-border" : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <UpdateBanner />

      {/* Body region: the muted chrome field. The panel workspace floats on it,
          and the window-chrome cluster floats above everything at the top-left. */}
      <div className="relative flex-1 min-h-0 bg-muted/30">
        {/* The workspace stays mounted while settings is open so its transient
            UI state (chat scroll, composer drafts, terminal scrollback) survives
            the round-trip. `inert` while covered keeps it out of the tab order. */}
        <div className="flex h-full w-full min-w-0" inert={settingsOpen}>
          {!sidebarCollapsed && (
            <InstancesSidebar
              instances={activeInstances}
              pinnedInstances={pinnedInstances}
              archivedInstances={archivedInstances}
              selectedId={view.kind === "instance" ? view.id : null}
              isDrafting={view.kind === "drafting"}
              topInset={TITLE_BAR_WITH_INSET_HEIGHT}
              topDrag={windowDrag}
              onNew={handleNew}
              onSelect={handleSelect}
              onRename={handleRename}
              onRestart={handleRestart}
              onPin={handlePin}
              onUnpin={handleUnpin}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onDelete={handleRequestDelete}
              onClearArchive={handleRequestClearArchive}
            />
          )}

          <div
            className={cn(
              "flex-1 min-w-0 min-h-0 flex flex-col bg-background overflow-hidden",
              contentFrame,
            )}
          >
            <div className="relative min-h-0 flex-1">
              {view.kind === "drafting" && (
                <div className="absolute inset-0 flex min-h-0">
                  <div
                    data-demo="new-chat-window-drag"
                    className="absolute inset-x-0 top-0 z-10 flex-shrink-0 select-none"
                    style={{ height: TITLE_BAR_WITH_INSET_HEIGHT }}
                    aria-hidden
                    {...windowDrag}
                  />
                  <NewInstancePane
                    profileId={activeProfileId}
                    chatModels={chatModels}
                    modelOverrides={modelOverrides}
                    defaultModelId={DEFAULT_CHAT_MODEL_ID}
                    onSubmit={handleSubmitDraft}
                  />
                </div>
              )}

              {panes.map((pane) => {
                const isActive = pane.instance.id === activeInstanceId;
                const isDraft = pane.key === draft?.standInInstanceId;
                return (
                  <RetainedInstancePane
                    key={pane.key}
                    instance={pane.instance}
                    chats={pane.chats}
                    terminals={pane.terminals}
                    active={isActive}
                    pendingFirstMessage={isActive && isDraft ? draftFirstMessage : null}
                    pending={pane.pending}
                    creationError={isDraft ? (draft?.error ?? null) : null}
                    resourceIdRemap={isDraft ? draftRemap : EMPTY_REMAP}
                    chatModels={chatModels}
                    modelOverrides={modelOverrides}
                    sidebarCollapsed={sidebarCollapsed}
                    chromeInset={chromeWidth}
                    isTauri={isTauri}
                    onTitleAutoUpdated={handleTitleAutoUpdated}
                    onDetachPr={handleDetachPr}
                    onChatCreated={registerChat}
                    onChatDeleted={unregisterChat}
                    onTerminalCreated={registerTerminal}
                    onTerminalDeleted={unregisterTerminal}
                  />
                );
              })}

              {view.kind === "instance" && !activePane && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  Chat not found
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Settings overlay covers the whole body region, including behind the
            floating window controls. SettingsPane reserves its own top rows so
            the sidebar background reaches the window edge while content clears
            the controls. */}
        {settingsSection !== null && (
          <div className="absolute inset-0 z-40 flex bg-background">
            <SettingsPane
              isTauri={isTauri}
              section={settingsSection}
              activeProfileId={activeProfileId}
              chatModels={chatModels}
              onSectionChange={setSettingsSection}
              sidebarCollapsed={sidebarCollapsed}
              topInset={TITLE_BAR_WITH_INSET_HEIGHT}
              topDrag={windowDrag}
            />
          </div>
        )}

        {/* Window-chrome cluster: traffic lights, sidebar toggle, and settings
            toggle. Floats above both the workspace and settings overlay. */}
        <WindowChrome
          isTauri={isTauri}
          settingsOpen={settingsOpen}
          onToggleSidebar={fireToggle}
          onOpenSettings={handleOpenSettings}
          onCloseSettings={handleCloseSettings}
          onWidthChange={setChromeWidth}
        />
      </div>

      <PromptDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        title="Rename chat"
        initialValue={renaming?.title ?? ""}
        placeholder="Chat name…"
        confirmLabel="Rename"
        onSubmit={(title) => void submitRename(title)}
      />

      <ConfirmDialog
        open={confirmingClearArchive}
        onOpenChange={setConfirmingClearArchive}
        title="Delete archived?"
        description={
          archivedInstances.length === 1
            ? "This permanently deletes the 1 archived chat and its VM. This can't be undone."
            : `This permanently deletes all ${archivedInstances.length} archived chats and their VMs. This can't be undone.`
        }
        confirmLabel="Delete archived"
        destructive
        busy={clearingArchive}
        onConfirm={() => void handleClearArchive()}
      />

      <ConfirmDialog
        open={confirmingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(null);
        }}
        title="Delete chat?"
        description="This permanently deletes this chat and its VM. This can't be undone."
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={() => confirmingDelete && void handleDelete(confirmingDelete)}
      />
    </div>
  );
}
