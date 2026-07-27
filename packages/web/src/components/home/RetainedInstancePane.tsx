import { memo, useCallback, useEffect, useState } from "react";
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
 * So an off-screen pane has its rendering skipped instead. `content-visibility`
 * is the right tool rather than `display: none`, because it preserves the
 * subtree's rendering state, including the scroll offsets retention exists to
 * keep. Browsers without it simply fall back to today's behaviour.
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
  // Skipping is deferred by a frame on the way out, because the commit that
  // hides a pane is also the commit where Chat captures its reading anchor in a
  // layout effect, and a skipped subtree measures as zero. It is NOT deferred on
  // the way in: `skipped` is only ever consulted while inactive, so a reveal
  // un-skips during the same render, before any layout effect looks at the DOM.
  const [skipped, setSkipped] = useState(!active);
  useEffect(() => {
    if (active) {
      setSkipped(false);
      return;
    }
    const raf = requestAnimationFrame(() => setSkipped(true));
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const detachPr = useCallback(
    (pr: AttachedPr) => onDetachPr(instance.id, pr),
    [onDetachPr, instance.id],
  );

  return (
    <div
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
        contentVisibility: !active && skipped ? "hidden" : "visible",
        opacity: active ? 1 : 0,
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
