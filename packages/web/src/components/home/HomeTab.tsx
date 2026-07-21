import { ChevronLeft, PanelLeft, PanelRight, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { TRAFFIC_LIGHT_GAP } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { getClientId, resolveActiveProfileId } from "../../lib/activeProfile";
import {
  activateProfile,
  archiveInstance,
  beaconDeactivateProfile,
  clearArchive,
  createChat,
  createTerminal,
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
import TitleBar from "../TitleBar";
import TitleBarPrs from "../TitleBarPrs";
import UpdateBanner from "../UpdateBanner";
import InstancesSidebar from "./InstancesSidebar";
import InstanceView from "./InstanceView";
import NewInstancePane from "./NewInstancePane";
import SidePanel, { type PanelMode } from "./SidePanel";

type View =
  | { kind: "drafting" }
  | {
      kind: "creating";
      // Stable client-side stand-ins for the instance + chat that haven't
      // landed on the server yet. They drive the same InstanceView/Chat
      // render path as a real instance. Once the real ones arrive we
      // transition to `instance` and the chat tab re-mounts seamlessly
      // (Chat's useState initializer rebuilds the same optimistic state).
      synth: Instance;
      synthChat: Chat;
      firstMessage: string;
      firstUploadIds: string[];
      error: string | null;
    }
  | {
      kind: "instance";
      id: string;
      pendingFirstMessage?: { chatId: string; content: string; uploadIds?: string[] };
    };

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

// Right-panel layout (collapsed + width + which body is shown) is remembered
// per chat instance, keyed by instance id. New instances start collapsed. The
// panel is opt-in, and opening it in terminal mode lazily spawns a shell in the
// VM, so we don't attach one on every instance. The storage key keeps its
// historical name for backward compatibility with already-persisted layouts.
const PANEL_LAYOUT_KEY = "isolade.terminalLayoutByInstance";

interface PanelLayout {
  collapsed: boolean;
  width: number;
  mode: PanelMode;
}

const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  collapsed: true,
  width: 380,
  mode: "terminal",
};

function loadPanelLayouts(): Record<string, Partial<PanelLayout>> {
  try {
    const raw = window.localStorage.getItem(PANEL_LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const layouts = parsed as Record<string, Partial<PanelLayout>>;
    // Migrate the legacy "preview" panel mode to its current name, so layouts
    // persisted before the rename still open onto the browser tab.
    for (const layout of Object.values(layouts)) {
      if ((layout.mode as string) === "preview") layout.mode = "browser";
    }
    return layouts;
  } catch {
    return {};
  }
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

  const [panelLayouts, setPanelLayouts] =
    useState<Record<string, Partial<PanelLayout>>>(loadPanelLayouts);

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

  // The sidebar toggle sits in the macOS title bar, where, on the native build,
  // some clicks land on a spot whose mousedown the OS swallows before the
  // webview sees it. No mousedown means the browser never synthesises a `click`,
  // so an `onClick` handler silently misses those presses. The mouse*up* does
  // reach us, though, so we fire the toggle from both `click` (normal presses +
  // keyboard) and `mouseup` (recovers the swallowed-mousedown presses), deduped
  // so a normal press (which delivers both) only toggles once.
  const lastToggleRef = useRef(0);
  const fireToggle = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleRef.current < 250) return;
    lastToggleRef.current = now;
    toggleSidebar();
  }, [toggleSidebar]);

  // TEMP DEBUG: remove once the sidebar-toggle click bug is diagnosed.
  // Capture-phase listeners on window: they fire for EVERY pointer/mouse event
  // before any React handler. If you click the toggle and see NO "[tb ...]" line
  // at all, the native macOS layer swallowed the event before the webview ever
  // saw it (a native window-controls / drag region on top). If lines DO appear,
  // compare `target` and `elementFromPoint`. If they aren't the toggle button,
  // something inside the page is intercepting.
  useEffect(() => {
    // Track whether a pointerdown was actually delivered to the webview for the
    // current press. If a pointerup arrives with no preceding pointerdown, macOS
    // swallowed the down (native title-bar), so that's a dead click.
    let sawDown = false;
    const onDown = (e: Event) => {
      const me = e as MouseEvent;
      if (typeof me.clientY !== "number" || me.clientY > 44) return;
      sawDown = true;
    };
    const onUp = (e: Event) => {
      const me = e as MouseEvent;
      if (typeof me.clientY !== "number" || me.clientY > 44) return;
      const x = Math.round(me.clientX),
        y = Math.round(me.clientY);
      const btn = (e.target as Element)?.closest?.("button")?.getAttribute("aria-label") ?? "none";
      const verdict = sawDown ? "OK       " : "SWALLOWED";
      // eslint-disable-next-line no-console
      console.log(`[verdict ${verdict}] x=${x} y=${y} over=${btn}`);
      sawDown = false;
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    // eslint-disable-next-line no-console
    console.log(
      "[tb] verdict logger active. Click around the white toggle box (left/right, top/bottom)",
    );
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
    };
  }, []);

  // Merge a patch into one instance's layout and persist the whole map.
  const updatePanelLayout = useCallback((instanceId: string, patch: Partial<PanelLayout>) => {
    setPanelLayouts((prev) => {
      const current = prev[instanceId] ?? DEFAULT_PANEL_LAYOUT;
      const next = { ...prev, [instanceId]: { ...current, ...patch } };
      try {
        window.localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const refreshInstances = useCallback(async () => {
    try {
      // The server returns instances in a total, deterministic recency order
      // (updatedAt desc, then createdAt desc, then id). See InstanceManager.list.
      // We render that order verbatim rather than re-sorting here, so there's a
      // single source of truth and the sidebar order can't disagree with itself.
      setInstances(await listInstances());
    } catch {}
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      setAllChats(await listChats());
    } catch {}
  }, []);

  const refreshTerminalsFor = useCallback(async (instanceId: string) => {
    try {
      const list = await listTerminals(instanceId);
      setTerminalsByInstance((prev) => ({ ...prev, [instanceId]: list }));
    } catch {}
  }, []);

  // Tracks per-instance shell creation so the panel's open-with-no-terminal
  // effect can fire repeatedly without spawning duplicate shells.
  const ensuringTerminalRef = useRef<Set<string>>(new Set());
  const ensureTerminalFor = useCallback(async (instanceId: string) => {
    if (ensuringTerminalRef.current.has(instanceId)) return;
    ensuringTerminalRef.current.add(instanceId);
    try {
      // List first so we don't create a duplicate when a shell already
      // exists server-side, e.g. reopening a remembered-open instance
      // before its terminals have loaded into client state.
      let list = await listTerminals(instanceId);
      if (list.length === 0) {
        await createTerminal(instanceId);
        list = await listTerminals(instanceId);
      }
      setTerminalsByInstance((prev) => ({ ...prev, [instanceId]: list }));
    } catch {
    } finally {
      ensuringTerminalRef.current.delete(instanceId);
    }
  }, []);

  useEffect(() => {
    refreshInstances();
    refreshChats();
    // Instances poll fast: they carry the per-VM diff stats, which the
    // server refreshes within ~1s of agent activity, and listing them is a
    // trivial DB read. Chats stay on the slower cadence, and their listing
    // does per-chat subscription-share math server-side.
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
  const effectiveProfileId =
    view.kind === "instance"
      ? (instances.find((c) => c.id === view.id)?.profileId ?? null)
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

  // Whenever the active instance changes, refresh its terminal list.
  useEffect(() => {
    if (view.kind !== "instance") return;
    void refreshTerminalsFor(view.id);
  }, [view, refreshTerminalsFor]);

  // Monotonic id for the in-flight draft submission. Bumped whenever the user
  // navigates away from a `creating` view so the still-resolving createInstance
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
    // During draft creation we keep the pre-submit URL until the real instance
    // id lands, but the settings overlay is orthogonal and must still sync.
    if (settingsSection === null && view.kind === "creating") return;
    const target = settingsSection ? `/settings/${settingsSection}` : viewToPath(view);
    if (window.location.pathname === target) return;
    // Switching sections within settings replaces the entry rather than
    // stacking one per tab, so Back leaves settings instead of cycling tabs.
    const stayingInSettings =
      settingsSection !== null && window.location.pathname.startsWith("/settings");
    if (stayingInSettings) window.history.replaceState(null, "", target);
    else window.history.pushState(null, "", target);
  }, [view, settingsSection]);

  // URL → view/settings (browser back/forward). A /settings/* path only toggles
  // the overlay. pathToView returns null for it, so the background view (and its
  // mounted components) is left untouched and closing settings returns there.
  useEffect(() => {
    const sync = () => {
      const path = window.location.pathname;
      const nextView = pathToView(path);
      applyingPopRef.current = true;
      // Only orphan an in-flight draft when the background view actually
      // changes. A pure settings toggle leaves a creating draft running.
      if (nextView) {
        submissionIdRef.current++;
        setView(nextView);
      }
      setSettingsSection(parseSettingsSection(path));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const handleNew = () => {
    submissionIdRef.current++;
    setView({ kind: "drafting" });
  };

  const handleSelect = (id: string) => {
    submissionIdRef.current++;
    setView({ kind: "instance", id });
  };

  // Settings opens as an overlay over the current view, so we leave `view` (and
  // any in-flight draft submission) alone, with no submissionId bump.
  const handleOpenSettings = () => {
    setSettingsSection(DEFAULT_SETTINGS_SECTION);
  };

  const handleSubmitDraft = ({
    instancePromise,
    modelId,
    effort,
    firstMessage,
    uploadIds = [],
  }: {
    instancePromise: Promise<Instance>;
    modelId: string;
    effort: ChatEffort;
    firstMessage: string;
    uploadIds?: string[];
  }) => {
    const sid = ++submissionIdRef.current;
    const now = new Date();
    const synth: Instance = {
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
    const synthChat: Chat = {
      id: `local-${crypto.randomUUID()}`,
      instanceId: synth.id,
      model: modelId,
      provider: modelDef?.provider ?? "anthropic",
      effort,
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
    setView({
      kind: "creating",
      synth,
      synthChat,
      firstMessage,
      firstUploadIds: uploadIds,
      error: null,
    });

    (async () => {
      let instance: Instance;
      try {
        instance = await instancePromise;
      } catch (err) {
        if (sid !== submissionIdRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setView((v) =>
          v.kind === "creating" && v.synth.id === synth.id ? { ...v, error: msg } : v,
        );
        return;
      }
      if (sid !== submissionIdRef.current) {
        void removeInstance(instance.id).catch(() => {});
        return;
      }
      let chat: Chat;
      try {
        chat = await createChat(instance.id, { model: modelId, effort });
      } catch (err) {
        void removeInstance(instance.id).catch(() => {});
        if (sid !== submissionIdRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setView((v) =>
          v.kind === "creating" && v.synth.id === synth.id ? { ...v, error: msg } : v,
        );
        return;
      }
      if (sid !== submissionIdRef.current) {
        void removeInstance(instance.id).catch(() => {});
        return;
      }
      setInstances((prev) => [instance, ...prev.filter((c) => c.id !== instance.id)]);
      setAllChats((prev) => [...prev.filter((c) => c.id !== chat.id), chat]);
      setView({
        kind: "instance",
        id: instance.id,
        pendingFirstMessage: { chatId: chat.id, content: firstMessage, uploadIds },
      });
      void refreshInstances();
    })();
  };

  const handleTitleAutoUpdated = (instanceId: string, title: string) => {
    setInstances((prev) => prev.map((c) => (c.id === instanceId ? { ...c, title } : c)));
  };

  // Detach a PR badge from a chat. Optimistic: drop it locally so it disappears
  // at once, then persist. The 1s instance poll reconciles either way, so a
  // failed request just self-heals on the next round.
  const handleDetachPr = (instanceId: string, pr: AttachedPr) => {
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
  };

  const handleRename = (id: string) => {
    const current = instances.find((c) => c.id === id);
    setRenaming({ id, title: current?.title ?? "" });
  };

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

  const handleRestart = async (id: string) => {
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
  };

  // Archive a chat: stop its VM and move it into the sidebar's Archived
  // section. Optimistic: flip the row locally so it drops out of the active
  // list at once. The reconcile (and the 1s poll) settle the real state.
  const handleArchive = async (id: string) => {
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
    if (view.kind === "instance" && view.id === id) setView({ kind: "drafting" });
    try {
      const updated = await archiveInstance(id);
      setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      console.error("[home] archive failed", err);
      void refreshInstances();
    }
  };

  // Unarchive a chat: clear the flag and boot its VM back up. Optimistic flip
  // to "restarting" so it rejoins the active list immediately.
  const handleUnarchive = async (id: string) => {
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
  };

  // Pin a chat: lift it into the sidebar's Pinned section. Optimistic flip so
  // it jumps sections at once; the 1s poll settles the canonical row (and its
  // recency order). No VM lifecycle, so nothing else changes.
  const handlePin = async (id: string) => {
    setInstances((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: true } : c)));
    try {
      const updated = await pinInstance(id);
      setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      console.error("[home] pin failed", err);
      void refreshInstances();
    }
  };

  // Unpin a chat: drop it back into the main list. Optimistic, mirroring pin.
  const handleUnpin = async (id: string) => {
    setInstances((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: false } : c)));
    try {
      const updated = await unpinInstance(id);
      setInstances((prev) => prev.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      console.error("[home] unpin failed", err);
      void refreshInstances();
    }
  };

  // Drop all client-side state tied to a set of just-deleted instances (chats,
  // terminals, and their remembered right-panel layouts).
  const forgetInstances = (ids: Set<string>) => {
    if (ids.size === 0) return;
    setInstances((prev) => prev.filter((c) => !ids.has(c.id)));
    setAllChats((prev) => prev.filter((c) => !ids.has(c.instanceId)));
    setTerminalsByInstance((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    setPanelLayouts((prev) => {
      if (![...ids].some((id) => id in prev)) return prev;
      const next = { ...prev };
      for (const id of ids) delete next[id];
      try {
        window.localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(next));
      } catch {}
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

  const instanceProps = useMemo(() => {
    if (view.kind === "creating") {
      return {
        instance: view.synth,
        chats: [view.synthChat],
        terminals: [] as Terminal[],
        pendingFirstMessage: {
          chatId: view.synthChat.id,
          content: view.firstMessage,
          uploadIds: view.firstUploadIds,
        },
        pending: true,
        creationError: view.error,
        onTitleAutoUpdated: () => {},
        onResourceChange: () => {},
      };
    }
    if (view.kind === "instance") {
      const active = instances.find((c) => c.id === view.id) ?? null;
      if (!active) return null;
      return {
        instance: active,
        chats: allChats.filter((c) => c.instanceId === active.id),
        pendingFirstMessage: view.pendingFirstMessage ?? null,
        pending: false,
        creationError: null,
        onTitleAutoUpdated: handleTitleAutoUpdated,
        onResourceChange: () => {
          void refreshChats();
          void refreshTerminalsFor(active.id);
        },
      };
    }
    return null;
  }, [view, instances, allChats, refreshChats, refreshTerminalsFor]);

  // Sidebar only shows instances whose title has landed (either the
  // auto-generated one or the server-side truncation fallback). Untitled
  // rows include pre-submit drafts and the brief window between submit and
  // first title event. Each remaining chat lands in exactly one section:
  // archived (its own collapsed disclosure), else pinned (the "Pinned" heading
  // at the top), else the main active list.
  const sidebarInstances = instances.filter(
    (c) => c.title !== null && c.title.trim() !== "" && (c.profileId ?? null) === activeProfileId,
  );
  const archivedInstances = sidebarInstances.filter((c) => c.archived);
  const pinnedInstances = sidebarInstances.filter((c) => !c.archived && c.pinned);
  const activeInstances = sidebarInstances.filter((c) => !c.archived && !c.pinned);

  // Dropping the overlay reveals the untouched background view (same instance,
  // same scroll position), so there's nothing to restore here.
  const handleCloseSettings = () => {
    setSettingsSection(null);
  };

  // The right panel only exists alongside a live instance. Its terminal needs
  // a running VM and its preview needs the VM's forwarded ports. The title bar
  // owns its toggle. The body mounts the panel only while it's open.
  const activeInstanceId = view.kind === "instance" ? view.id : null;
  const activeInstance =
    activeInstanceId != null ? (instances.find((c) => c.id === activeInstanceId) ?? null) : null;
  const showSidePanel = view.kind === "instance" && instanceProps != null;
  const sidebarTerminal =
    activeInstanceId != null ? ((terminalsByInstance[activeInstanceId] ?? [])[0] ?? null) : null;

  // Per-instance layout, spread over the default so partial (e.g. pre-`mode`)
  // persisted entries still resolve every field.
  const activeLayout: PanelLayout = {
    ...DEFAULT_PANEL_LAYOUT,
    ...(activeInstanceId != null ? panelLayouts[activeInstanceId] : null),
  };

  const settingsOpen = settingsSection !== null;
  const panelOpen = showSidePanel && !activeLayout.collapsed;

  // Border + rounding only along the edges that meet chrome: the title bar on
  // top (always), and a sidebar on the left/right when it's extended. A corner
  // rounds only where both of its edges are bordered.
  //
  // On the sides that meet the WINDOW edge (the bottom, plus any collapsed
  // side) we instead inset by 1px. The window paints a bright inset highlight
  // along its inner edge (the native chrome in Tauri, .mac-window::after in the
  // browser). Without the gap, the end of our border line would sit under it
  // and flare into a bright pip. The 1px gap keeps the border clear of it.
  const contentFrame = cn(
    "border-t border-border",
    !sidebarCollapsed ? "border-l rounded-tl-2xl" : "ml-px",
    panelOpen ? "border-r rounded-tr-2xl" : "mr-px",
    (!sidebarCollapsed || panelOpen) && "mb-px",
  );

  // Title-bar chrome. The sidebar toggle and the settings gear sit together in
  // the left cluster (gear right of the toggle). The history back/forward
  // arrows sit just left of the search field. The toggle and arrows are present
  // in both modes. Only the gear's slot swaps: the settings gear in the
  // workspace, the "Back" control that closes settings while it's open.
  //
  // These ghost buttons drop the default hover fill and focus ring: in the
  // window chrome a tinted rectangle on hover/click reads as a stray box, so we
  // signal interactivity with the icon colour shift (muted → foreground) alone.
  //
  // `transition-colors` (not the Button base's `transition-all`): the gear and
  // the settings "Back" share one DOM node across the mode swap, so animating
  // size/position would make Back appear to grow and slide in as it morphs from
  // the gear. We want only the hover colour to ease. The box change is instant.
  const chromeBase =
    "text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent transition-colors focus-visible:ring-0";
  const titleLeft = (
    <div className="inline-flex h-full items-center" style={{ gap: TRAFFIC_LIGHT_GAP }}>
      <button
        className={chromeBase}
        onMouseUp={(e) => {
          if (e.button === 0) fireToggle();
        }}
        onClick={fireToggle}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <PanelLeft size={17} />
      </button>
      {/* Immediately right of the sidebar toggle: the settings gear in the
          workspace, swapped for the "Back" control that closes the settings
          overlay while it's open. The two share one DOM node across the swap
          (see the chromeBase note above) so only the hover colour eases. */}
      {settingsOpen ? (
        <Button
          variant="ghost"
          size="xs"
          className={chromeBase}
          onClick={handleCloseSettings}
          aria-label="Back"
          data-demo="settings-back"
        >
          <ChevronLeft className="size-3.5" />
          Back
        </Button>
      ) : (
        <button
          style={{ marginLeft: -2, marginRight: -2 }}
          className={chromeBase}
          onClick={handleOpenSettings}
          aria-label="Settings"
        >
          <Settings size={17} />
        </button>
      )}
    </div>
  );
  // The active chat's attached PRs, centred in the title bar. Hidden while
  // settings is open (there's no chat in focus then).
  const titleCenter =
    !settingsOpen && activeInstance && (activeInstance.prs?.length ?? 0) > 0 ? (
      <TitleBarPrs
        prs={activeInstance.prs ?? []}
        onDetach={(pr) => handleDetachPr(activeInstance.id, pr)}
      />
    ) : null;
  const titleRight =
    !settingsOpen && showSidePanel && activeInstanceId ? (
      <button
        className={chromeBase}
        onClick={() =>
          updatePanelLayout(activeInstanceId, {
            collapsed: !activeLayout.collapsed,
          })
        }
        aria-label={activeLayout.collapsed ? "Show panel" : "Hide panel"}
      >
        <PanelRight size={17} />
      </button>
    ) : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TitleBar isTauri={isTauri} left={titleLeft} right={titleRight} center={titleCenter} />

      <UpdateBanner />

      {/* Body region: the muted chrome field. The content card floats on it and
          rounds against it on the sidebar-adjacent sides. */}
      <div className="relative flex-1 min-h-0 bg-muted/30">
        {/* The workspace stays mounted while settings is open so its transient
            UI state (chat scroll position, composer drafts, terminal
            scrollback) survives the round-trip. `inert` while covered keeps it
            out of the tab order and unfocusable. */}
        <div className="flex h-full w-full min-w-0" inert={settingsOpen}>
          {!sidebarCollapsed && (
            <InstancesSidebar
              instances={activeInstances}
              pinnedInstances={pinnedInstances}
              archivedInstances={archivedInstances}
              selectedId={view.kind === "instance" ? view.id : null}
              isDrafting={view.kind === "drafting"}
              onNew={handleNew}
              onSelect={handleSelect}
              onRename={handleRename}
              onRestart={handleRestart}
              onPin={handlePin}
              onUnpin={handleUnpin}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onDelete={(id) => setConfirmingDelete(id)}
              onClearArchive={() => setConfirmingClearArchive(true)}
            />
          )}

          <div
            className={cn(
              "flex-1 min-w-0 min-h-0 flex flex-col bg-background overflow-hidden",
              contentFrame,
            )}
          >
            {view.kind === "drafting" && (
              <NewInstancePane
                profileId={activeProfileId}
                chatModels={chatModels}
                modelOverrides={modelOverrides}
                defaultModelId={DEFAULT_CHAT_MODEL_ID}
                onSubmit={handleSubmitDraft}
              />
            )}

            {instanceProps && (
              <InstanceView
                instance={instanceProps.instance}
                chats={instanceProps.chats}
                chatModels={chatModels}
                modelOverrides={modelOverrides}
                pendingFirstMessage={instanceProps.pendingFirstMessage}
                pending={instanceProps.pending}
                creationError={instanceProps.creationError}
                onTitleAutoUpdated={instanceProps.onTitleAutoUpdated}
                onResourceChange={instanceProps.onResourceChange}
              />
            )}

            {view.kind === "instance" && !instanceProps && (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Chat not found
              </div>
            )}
          </div>

          {panelOpen && activeInstanceId && (
            <SidePanel
              instanceId={activeInstanceId}
              terminal={sidebarTerminal}
              ports={activeInstance?.ports ?? []}
              width={activeLayout.width}
              mode={activeLayout.mode}
              onModeChange={(mode) => updatePanelLayout(activeInstanceId, { mode })}
              onWidthChange={(w) => updatePanelLayout(activeInstanceId, { width: w })}
              onEnsureTerminal={() => void ensureTerminalFor(activeInstanceId)}
            />
          )}
        </div>

        {/* Settings overlay, covering the body region below the title bar (the
            bar stays put and swaps its left controls to Back). Opaque base so
            the inert workspace behind never shows through; the inner layer
            paints the same muted chrome field as the workspace. */}
        {settingsSection !== null && (
          <div className="absolute inset-0 z-40 bg-background">
            <div className="flex h-full w-full bg-muted/30">
              <SettingsPane
                isTauri={isTauri}
                section={settingsSection}
                activeProfileId={activeProfileId}
                chatModels={chatModels}
                onSectionChange={setSettingsSection}
                sidebarCollapsed={sidebarCollapsed}
              />
            </div>
          </div>
        )}
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
