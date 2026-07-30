import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ChevronRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Instance } from "../../lib/contracts";
import { formatAbsoluteTime, formatRelativeTime, useMinuteClock } from "../../lib/relative-time";
import {
  SIDEBAR_COLUMN_INSET,
  SidebarTitleBarInset,
  sidebarRowClass,
  useResizableSidebarWidth,
  type WindowDragHandlers,
} from "../../lib/sidebar";
import SidebarResizeHandle from "../SidebarResizeHandle";

interface InstancesSidebarProps {
  // Active (non-archived, non-pinned) chats, already filtered to titled rows of
  // the active profile by the parent, so anything here renders unconditionally.
  instances: Instance[];
  // Pinned chats (same filtering). Lifted above the active list under a "Pinned"
  // disclosure that only appears when this is non-empty.
  pinnedInstances: Instance[];
  // Archived chats (same filtering). Collapsed under an "Archived" disclosure
  // that only appears when this is non-empty.
  archivedInstances: Instance[];
  selectedId: string | null;
  isDrafting: boolean;
  // Top padding (px) that clears the floating window-chrome cluster, which sits
  // over the sidebar's top-left corner when the sidebar is extended. The strip
  // it reserves doubles as an OS window-drag surface via `topDrag`.
  topInset?: number;
  topDrag?: WindowDragHandlers;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onRestart: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onClearArchive: () => void;
}

function rowLabel(conv: Instance): string {
  return conv.title?.trim() || "Untitled";
}

interface RowActions {
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onRestart: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
}

// One chat row, with the context menu it owns. `activity` enables the
// working/unread treatments: on for the active list, off for archived rows
// (their VM is stopped, so they're quiescent). Archived rows get the
// unarchive/delete menu instead of the live one.
//
// Memoized, and given only stable props, because each row carries a Radix
// context menu (a Root, a Trigger and a portalled Content, several components
// deep). The once-a-second instance poll changes one row at a time, and
// re-rendering the whole list for it is a visible cost by the time a few dozen
// chats are open. `age` is the already-formatted label rather than a clock, for
// the same reason: the minute tick only re-renders the rows whose label text
// actually changed, which is a handful at the top of a long list.
const InstanceRow = memo(function InstanceRow({
  conv,
  isActive,
  activity,
  age,
  demo,
  actions,
}: {
  conv: Instance;
  isActive: boolean;
  activity: boolean;
  age: string;
  demo: string;
  actions: RowActions;
}) {
  const isRestarting = conv.status === "restarting";
  // `initializing`: the VM booted but the environment's sync initializers
  // (config.toml `[setup]`/`[start]`) are still running. Same spinner
  // treatment as a restart, and the first chat turn waits.
  const isInitializing = conv.status === "initializing";
  const isErrored = conv.status === "error";
  // The activity treatments only apply to rows you're NOT viewing. The
  // selected row keeps its solid active fill, since you can already see what
  // it's doing in the main pane. The three states stay mutually exclusive on
  // the unselected rows: working → shimmer, unread → bold, otherwise → plain.
  const showWorking = activity && conv.working && !isActive;
  const showUnread = activity && conv.unread && !isActive && !conv.working;
  // `activity` doubles as "this row's VM is live", which is exactly the set of
  // rows whose menu offers the VM-bound actions.
  const menu = activity ? (
    <>
      <ContextMenuItem onSelect={() => actions.onRename(conv.id)}>
        <Pencil className="size-3.5" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.onRestart(conv.id)}>
        <RotateCw className="size-3.5" />
        Restart
      </ContextMenuItem>
      {conv.pinned ? (
        <ContextMenuItem data-demo="ctx-unpin" onSelect={() => actions.onUnpin(conv.id)}>
          <PinOff className="size-3.5" />
          Unpin
        </ContextMenuItem>
      ) : (
        <ContextMenuItem data-demo="ctx-pin" onSelect={() => actions.onPin(conv.id)}>
          <Pin className="size-3.5" />
          Pin
        </ContextMenuItem>
      )}
      <ContextMenuItem data-demo="ctx-archive" onSelect={() => actions.onArchive(conv.id)}>
        <Archive className="size-3.5" />
        Archive
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        data-demo="ctx-delete"
        onSelect={() => actions.onDelete(conv.id)}
      >
        <Trash2 className="size-3.5" />
        Delete
      </ContextMenuItem>
    </>
  ) : (
    <>
      <ContextMenuItem onSelect={() => actions.onUnarchive(conv.id)}>
        <ArchiveRestore className="size-3.5" />
        Unarchive
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        data-demo="ctx-delete"
        onSelect={() => actions.onDelete(conv.id)}
      >
        <Trash2 className="size-3.5" />
        Delete
      </ContextMenuItem>
    </>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-demo={demo}
          onClick={() => actions.onSelect(conv.id)}
          // Two overrides on the shared row style, both because these rows are
          // two lines (title, then the metadata strip) where it is one:
          // `items-start` so the status icon aligns with the title rather than
          // with the middle of the pair (`mt-1` centres it on the title's 20px
          // line), and the split padding so the row looks evenly inset. The
          // shared py-1 measures from the line boxes, which leaves 7px of air
          // above the title's cap height but only 5px below the metadata line's
          // descenders; 3/5 evens the two out at 6px without making the row any
          // taller.
          className={cn(sidebarRowClass(isActive), "items-start pt-[3px] pb-[5px]")}
        >
          {(isRestarting || isInitializing) && (
            <RotateCw
              className="mt-1 size-3 shrink-0 animate-spin text-muted-foreground"
              aria-label={isInitializing ? "Preparing environment" : "Restarting"}
            />
          )}
          {isErrored && (
            <AlertTriangle
              className="mt-1 size-3 shrink-0 text-destructive"
              aria-label={conv.lastError ?? "VM error"}
            />
          )}
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate",
                // Working: a bright glint sweeps across the dimmed title (see
                // .text-shimmer, shared with in-flight tool verbs). Unread: bold,
                // full strength.
                showWorking && "text-shimmer",
                showUnread && "font-semibold",
              )}
              title={isErrored && conv.lastError ? conv.lastError : undefined}
            >
              {rowLabel(conv)}
            </span>
            {/* Metadata strip under the title: when this chat last did
                something, and the unpushed diff. Deliberately quiet (10px,
                muted) so a wall of rows still reads as a list of titles. */}
            <span className="flex items-center gap-1.5 text-[10px] leading-[14px] text-muted-foreground tabular-nums">
              <span className="truncate" title={formatAbsoluteTime(conv.updatedAt)}>
                {age}
              </span>
              {((conv.diffAdded ?? 0) > 0 || (conv.diffDeleted ?? 0) > 0) && (
                <span className="shrink-0 inline-flex gap-1">
                  <span className="text-emerald-600 dark:text-emerald-500">
                    +{conv.diffAdded ?? 0}
                  </span>
                  <span className="text-red-600 dark:text-red-500">
                    &minus;{conv.diffDeleted ?? 0}
                  </span>
                </span>
              )}
            </span>
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  );
});

// The instances list. The window chrome (traffic lights, sidebar-collapse /
// settings / history controls) lives in the title bar now, so this is purely
// the New-chat row plus the scrollable list. The parent (HomeTab) decides
// whether to mount it at all based on the collapsed state. Transparent so the
// muted title-bar/body chrome shows through. The content card to the right is
// what carries bg-background.
export default function InstancesSidebar({
  instances,
  pinnedInstances,
  archivedInstances,
  selectedId,
  isDrafting,
  topInset = 0,
  topDrag,
  onNew,
  onSelect,
  onRename,
  onRestart,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onDelete,
  onClearArchive,
}: InstancesSidebarProps) {
  const { width, beginResize } = useResizableSidebarWidth();
  // Pinned chats sit at the top under their own disclosure, open by default
  // (pinning is opt-in and meant to keep chats in view; collapsing is there for
  // a long pin list). Archived chats sit at the bottom, hidden by default.
  // Both are local state, so they reset to their defaults on remount.
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Ticks once a minute, so the rows' "when did this last move" labels age in
  // place instead of freezing at whatever they said when the row last changed.
  // `updatedAt` is the server's activity timestamp: it's bumped when a turn
  // finishes, on rename/pin, and across the VM lifecycle, and it's what the
  // list is already ordered by.
  const now = useMinuteClock();

  // One object holding every per-row action, so a row's props stay stable and
  // its memo holds. HomeTab already hands these down with stable identities.
  const actions = useMemo<RowActions>(
    () => ({ onSelect, onRename, onRestart, onPin, onUnpin, onArchive, onUnarchive, onDelete }),
    [onSelect, onRename, onRestart, onPin, onUnpin, onArchive, onUnarchive, onDelete],
  );

  return (
    <aside className="relative flex-shrink-0 flex flex-col min-h-0" style={{ width }}>
      <SidebarTitleBarInset height={topInset} drag={topDrag} />
      {/* The New-chat row, on the shared sidebar-row style and column inset, so
          its text lines up with the chat titles below and with the settings
          nav's first row, which is what it turns into. */}
      <div className={cn(SIDEBAR_COLUMN_INSET, "pb-0.5")}>
        {/* A plain <button> on the shared row style, not a shadcn <Button>: the
            Button base leaks rounded-md (6px) and has-[>svg]:px-2.5 that don't
            match the chat rows' rounded (4px) / px-2. sidebarRowClass makes it
            pixel-identical to the list rows and the settings nav; isDrafting is
            its active state. */}
        <button
          type="button"
          data-demo="new-chat"
          className={sidebarRowClass(isDrafting)}
          onClick={(e) => {
            e.currentTarget.blur();
            onNew();
          }}
        >
          <Plus className="size-4" />
          New chat
        </button>
      </div>
      {/* Radix ScrollArea wraps content in an inline-styled `display: table`
          div that grows to fit nowrap text instead of constraining it, which
          defeats `truncate` on the row titles and pushes the diff badge past
          the clipped right edge. Force it to block so rows are bounded by
          the viewport width (`!` because it's an inline style). */}
      <ScrollArea className="flex-1 min-h-0 [&_[data-radix-scroll-area-viewport]>div]:block!">
        <ul className={cn(SIDEBAR_COLUMN_INSET, "pb-2 space-y-0.5")}>
          {/* Pinned disclosure, only present when something is pinned. Sits
              above the active list; the header toggles the pinned rows. The
              rows are live chats, so they carry the same activity treatment and
              context menu as the active list. */}
          {pinnedInstances.length > 0 && (
            <li>
              <button
                type="button"
                data-demo="pinned-toggle"
                aria-expanded={pinnedOpen}
                onClick={() => setPinnedOpen((v) => !v)}
                className={cn(sidebarRowClass(false), "text-muted-foreground")}
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 transition-transform",
                    pinnedOpen && "rotate-90",
                  )}
                />
                <span className="flex-1">Pinned</span>
                <span className="shrink-0 text-[11px] tabular-nums">{pinnedInstances.length}</span>
              </button>
            </li>
          )}

          {pinnedOpen &&
            pinnedInstances.map((conv) => (
              <li key={conv.id}>
                <InstanceRow
                  conv={conv}
                  isActive={!isDrafting && selectedId === conv.id}
                  activity
                  age={formatRelativeTime(conv.updatedAt, now)}
                  demo="pinned-row"
                  actions={actions}
                />
              </li>
            ))}

          {/* A little breathing room between the pinned block and the active
              list so the two sections don't run together. */}
          {pinnedInstances.length > 0 && instances.length > 0 && <li className="h-1" aria-hidden />}

          {instances.map((conv) => (
            <li key={conv.id}>
              <InstanceRow
                conv={conv}
                isActive={!isDrafting && selectedId === conv.id}
                activity
                age={formatRelativeTime(conv.updatedAt, now)}
                demo="instance-row"
                actions={actions}
              />
            </li>
          ))}

          {/* Archived disclosure, only present when something is archived. The
              header toggles the list; a right-click clears the whole archive. */}
          {archivedInstances.length > 0 && (
            <li className="pt-1">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    data-demo="archived-toggle"
                    aria-expanded={archivedOpen}
                    onClick={() => setArchivedOpen((v) => !v)}
                    className={cn(sidebarRowClass(false), "text-muted-foreground")}
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 transition-transform",
                        archivedOpen && "rotate-90",
                      )}
                    />
                    <span className="flex-1">Archived</span>
                    <span className="shrink-0 text-[11px] tabular-nums">
                      {archivedInstances.length}
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    variant="destructive"
                    data-demo="ctx-clear-archive"
                    onSelect={onClearArchive}
                  >
                    <Trash2 className="size-3.5" />
                    Delete archived
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </li>
          )}

          {archivedOpen &&
            archivedInstances.map((conv) => (
              <li key={conv.id}>
                <InstanceRow
                  conv={conv}
                  isActive={!isDrafting && selectedId === conv.id}
                  activity={false}
                  age={formatRelativeTime(conv.updatedAt, now)}
                  demo="archived-row"
                  actions={actions}
                />
              </li>
            ))}
        </ul>
      </ScrollArea>
      <SidebarResizeHandle onMouseDown={beginResize} />
    </aside>
  );
}
