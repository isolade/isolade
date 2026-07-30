import { memo, useCallback, useEffect, useRef, useState } from "react";
import type {
  AttachedPr,
  ChatModelDefinition,
  Chat as ChatT,
  Instance,
  ModelOverrides,
  PortForward,
  Terminal as TerminalT,
} from "../../lib/contracts";
import PanelWorkspace from "./PanelWorkspace";

const EMPTY_PORTS: PortForward[] = [];
const EMPTY_PRS: AttachedPr[] = [];

// Frames the outgoing pane keeps covering the switch, and the ceiling on how
// long the incoming one waits for its transcript height to stop moving. The
// first must exceed the second, or the hand-off shows a gap.
const SETTLE_MAX_FRAMES = 12;
const HIDE_DELAY_FRAMES = 16;

interface RetainedInstancePaneProps {
  instance: Instance;
  chats: ChatT[];
  terminals: TerminalT[];
  active: boolean;
  pendingFirstMessage: { chatId: string; content: string; uploadIds?: string[] } | null;
  chatModels: ChatModelDefinition[];
  modelOverrides: ModelOverrides;
  sidebarCollapsed: boolean;
  chromeInset: number;
  isTauri: boolean;
  onTitleAutoUpdated: (instanceId: string, title: string) => void;
  onDetachPr: (instanceId: string, pr: AttachedPr) => void;
  onChatCreated: (chat: ChatT) => void;
  onChatDeleted: (chatId: string) => void;
  onTerminalCreated: (terminal: TerminalT) => void;
  onTerminalDeleted: (terminalId: string) => void;
}

/**
 * One live instance's workspace, kept mounted whether or not it is on screen.
 *
 * Retention is what makes sidebar navigation instant: parsed Markdown,
 * disclosure state, drafts, terminals and scroll position all survive a switch.
 * The price is that every retained transcript stays in the document, and an
 * off-screen pane that is merely transparent is still styled, laid out and
 * painted on every frame. With a dozen long chats open that turns unrelated
 * interactions (opening a menu, typing in a new chat) into visibly slow ones.
 *
 * So an off-screen pane is taken out of the box tree with `display: none`.
 * `content-visibility: hidden` reads better on paper, because it is specified to
 * preserve the skipped subtree's rendering state, but measured against WebKit
 * (which is what the macOS app runs on) it barely helps: opening a menu over a
 * 245k node document cost 2198ms with it versus 118ms with `display: none`.
 * Chromium contains both well, so the stricter option is the one to take.
 *
 * `display: none` does discard the subtree's scroll offsets, but Chat does not
 * rely on the browser for those: it captures a reading anchor when it is hidden
 * and restores it when revealed, which is the behaviour the retention tests
 * pin down.
 */
function RetainedInstancePane({
  instance,
  chats,
  terminals,
  active,
  pendingFirstMessage,
  chatModels,
  modelOverrides,
  sidebarCollapsed,
  chromeInset,
  isTauri,
  onTitleAutoUpdated,
  onDetachPr,
  onChatCreated,
  onChatDeleted,
  onTerminalCreated,
  onTerminalDeleted,
}: RetainedInstancePaneProps) {
  // Taking a pane out of the box tree discards its layout, so both edges of a
  // switch need a grace period, measured in frames:
  //
  //  - Hiding waits, because the commit that hides a pane is also the commit
  //    where Chat captures its reading anchor, and a pane with no boxes measures
  //    as zero. The outgoing pane also stays *painted* through the wait, so it
  //    covers the incoming one while that settles.
  //  - Revealing puts the boxes back immediately, but keeps the pane unpainted
  //    until its transcript's height stops moving. Rebuilding the layout of a
  //    long transcript takes a few frames, and it would otherwise paint scrolled
  //    to the top and then a screen short of the tail before landing.
  const [skipped, setSkipped] = useState(!active);
  const [settled, setSettled] = useState(active);
  useEffect(() => {
    if (!active) {
      setSettled(false);
      // Outlast the incoming pane's settle, so the reader keeps seeing the chat
      // they are leaving instead of a gap. It sits above the incoming one until
      // it goes, so the two never both show.
      let raf = 0;
      let framesLeft = HIDE_DELAY_FRAMES;
      const step = () => {
        if (--framesLeft <= 0) {
          setSkipped(true);
          return;
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }
    setSkipped(false);
    // Wait for the transcript's height to stop changing, bounded so a chat that
    // never settles (a live stream) still appears promptly.
    let raf = 0;
    let lastHeight = -1;
    let stableFrames = 0;
    let framesLeft = SETTLE_MAX_FRAMES;
    const step = () => {
      const scroller = paneRef.current?.querySelector<HTMLElement>("[data-chat-scroll]");
      const height = scroller?.scrollHeight ?? 0;
      const stable = height > 0 && height === lastHeight;
      lastHeight = height;
      if ((stable && ++stableFrames >= 2) || --framesLeft <= 0) {
        setSettled(true);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  const paneRef = useRef<HTMLDivElement>(null);

  const detachPr = useCallback(
    (pr: AttachedPr) => onDetachPr(instance.id, pr),
    [onDetachPr, instance.id],
  );

  return (
    <div
      ref={paneRef}
      data-retained-instance={instance.id}
      className="absolute inset-0 flex min-h-0"
      aria-hidden={!active}
      inert={!active}
      style={{
        // Keep this mode stable across sidebar switches so a retained reading
        // position does not reflow. Full `strict` containment includes paint and
        // size containment, which can make an absolutely positioned panel body's
        // nested scroller inert in macOS WebKit.
        contain: "layout style",
        display: !active && skipped ? "none" : "flex",
        // The pane being left stays on top until it is dropped, so it covers the
        // incoming one for the frames that one spends rebuilding its layout.
        zIndex: active ? 0 : 1,
        visibility: active && !settled ? "hidden" : "visible",
        opacity: active || !skipped ? 1 : 0,
        pointerEvents: active ? "auto" : "none",
      }}
    >
      <PanelWorkspace
        instanceId={instance.id}
        chats={chats}
        terminals={terminals}
        ports={instance.ports ?? EMPTY_PORTS}
        prs={instance.prs ?? EMPTY_PRS}
        chatModels={chatModels}
        modelOverrides={modelOverrides}
        pendingFirstMessage={pendingFirstMessage}
        visible={active}
        sidebarCollapsed={sidebarCollapsed}
        chromeInset={chromeInset}
        isTauri={isTauri}
        onTitleAutoUpdated={onTitleAutoUpdated}
        onDetachPr={detachPr}
        onChatCreated={onChatCreated}
        onChatDeleted={onChatDeleted}
        onTerminalCreated={onTerminalCreated}
        onTerminalDeleted={onTerminalDeleted}
      />
    </div>
  );
}

// The instance row is polled once a second and most of it (diff stats, unread,
// working, updatedAt) drives the sidebar, not the workspace. Compare only what
// the pane actually renders from, so a busy agent's changing line counts don't
// re-render its workspace 60 times a minute. Ports and PRs arrive as fresh
// arrays on every changed row, so they are compared by value.
function sameList<T>(previous: T[] | undefined, next: T[] | undefined): boolean {
  if (previous === next) return true;
  if ((previous?.length ?? 0) !== (next?.length ?? 0)) return false;
  return JSON.stringify(previous ?? []) === JSON.stringify(next ?? []);
}

function paneEqual(previous: RetainedInstancePaneProps, next: RetainedInstancePaneProps): boolean {
  return (
    previous.instance.id === next.instance.id &&
    sameList(previous.instance.ports, next.instance.ports) &&
    sameList(previous.instance.prs, next.instance.prs) &&
    previous.chats === next.chats &&
    previous.terminals === next.terminals &&
    previous.active === next.active &&
    previous.pendingFirstMessage === next.pendingFirstMessage &&
    previous.chatModels === next.chatModels &&
    previous.modelOverrides === next.modelOverrides &&
    previous.sidebarCollapsed === next.sidebarCollapsed &&
    previous.chromeInset === next.chromeInset &&
    previous.isTauri === next.isTauri &&
    previous.onTitleAutoUpdated === next.onTitleAutoUpdated &&
    previous.onDetachPr === next.onDetachPr &&
    previous.onChatCreated === next.onChatCreated &&
    previous.onChatDeleted === next.onChatDeleted &&
    previous.onTerminalCreated === next.onTerminalCreated &&
    previous.onTerminalDeleted === next.onTerminalDeleted
  );
}

/**
 * Memoized so the once-a-second instance poll re-renders only what changed.
 * Without it a single updated diff stat walks every open chat's panel tree on
 * the main thread.
 */
export default memo(RetainedInstancePane, paneEqual);
