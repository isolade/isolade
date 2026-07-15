import {
  AlertCircle,
  ChevronRight,
  Copy,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  PencilLine,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  createFile,
  createFolder,
  deleteFile,
  listFiles,
  renameFile,
  uploadFile,
} from "../../lib/api";
import { type FileEntry, WORKSPACE_ROOT } from "../../lib/contracts";
import {
  type DirState,
  EMPTY_DIR,
  flattenRows,
  formatSize,
  joinPath,
  parentOf,
  relativeToRoot,
} from "./file-tree-model";

interface FileTreeProps {
  instanceId: string;
  // True while the Files tab is the visible panel body. Becoming active
  // triggers a silent refresh so changes made elsewhere (terminal, agent) show.
  active: boolean;
}

type Prompt =
  | { kind: "rename"; entry: FileEntry }
  | { kind: "newFile"; dir: string }
  | { kind: "newFolder"; dir: string };

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // best effort, nothing more we can do in a locked-down webview
  }
  document.body.removeChild(ta);
}

// ---- drag-and-drop: snapshot the DataTransfer synchronously (the items list
// is cleared the moment the drop handler returns), then walk any directories
// asynchronously via the FileSystem entries API so dropping a folder uploads
// its whole tree. ----
interface DroppedFile {
  relativePath: string;
  file: File;
}

function snapshotDataTransfer(dt: DataTransfer): {
  entries: FileSystemEntry[];
  files: File[];
} {
  const entries: FileSystemEntry[] = [];
  const files: File[] = [];
  if (dt.items && dt.items.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
      else {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (entries.length === 0 && files.length === 0) files.push(...Array.from(dt.files));
  return { entries, files };
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDir(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await readFile(entry as FileSystemFileEntry);
    out.push({ relativePath: `${prefix}${entry.name}`, file });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // readEntries returns the directory in batches. An empty batch signals EOF.
    for (;;) {
      const batch = await readDir(reader);
      if (batch.length === 0) break;
      children.push(...batch);
    }
    await Promise.all(children.map((c) => walkEntry(c, `${prefix}${entry.name}/`, out)));
  }
}

async function gatherDropped(snapshot: {
  entries: FileSystemEntry[];
  files: File[];
}): Promise<DroppedFile[]> {
  const out: DroppedFile[] = snapshot.files.map((file) => ({
    relativePath: file.name,
    file,
  }));
  await Promise.all(snapshot.entries.map((e) => walkEntry(e, "", out)));
  return out;
}

export default function FileTree({ instanceId, active }: FileTreeProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([WORKSPACE_ROOT]));
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);

  // Latest snapshot of which dirs are loaded, for refreshAll without re-binding.
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  const load = useCallback(
    async (dir: string) => {
      setDirs((d) => ({
        ...d,
        [dir]: { ...(d[dir] ?? EMPTY_DIR), loading: true, error: null },
      }));
      try {
        const listing = await listFiles(instanceId, dir);
        setDirs((d) => ({
          ...d,
          [dir]: { entries: listing.entries, loading: false, error: null },
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDirs((d) => ({
          ...d,
          [dir]: { ...(d[dir] ?? EMPTY_DIR), loading: false, error: msg },
        }));
      }
    },
    [instanceId],
  );

  // Reset and load the root whenever the instance changes.
  useEffect(() => {
    setDirs({});
    setExpanded(new Set([WORKSPACE_ROOT]));
    setSelected(null);
    setError(null);
    void load(WORKSPACE_ROOT);
  }, [instanceId, load]);

  const refreshAll = useCallback(() => {
    const loaded = Object.keys(dirsRef.current);
    const targets = loaded.length ? loaded : [WORKSPACE_ROOT];
    for (const dir of targets) void load(dir);
  }, [load]);

  // Silent refresh when the panel becomes visible again.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refreshAll();
    wasActive.current = active;
  }, [active, refreshAll]);

  const toggleDir = useCallback(
    (dir: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) {
          next.delete(dir);
        } else {
          next.add(dir);
          if (!dirsRef.current[dir]?.entries && !dirsRef.current[dir]?.loading) void load(dir);
        }
        return next;
      });
    },
    [load],
  );

  const expandDir = useCallback(
    (dir: string) => {
      setExpanded((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
      if (!dirsRef.current[dir]?.entries) void load(dir);
    },
    [load],
  );

  const runAction = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const handleDelete = useCallback(
    (entry: FileEntry) => {
      void runAction(`Deleting ${entry.name}…`, async () => {
        await deleteFile(instanceId, entry.path);
        await load(parentOf(entry.path));
        setSelected((s) => (s === entry.path ? null : s));
      });
    },
    [instanceId, load, runAction],
  );

  // Process a drop of OS files/folders into a target directory.
  const handleDrop = useCallback(
    (targetDir: string, e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverDir(null);
      const snapshot = snapshotDataTransfer(e.dataTransfer);
      if (snapshot.entries.length === 0 && snapshot.files.length === 0) return;
      void runAction("Uploading…", async () => {
        const dropped = await gatherDropped(snapshot);
        if (dropped.length === 0) return;
        let done = 0;
        for (const item of dropped) {
          done += 1;
          setBusy(`Uploading ${done}/${dropped.length}…`);
          const buf = await item.file.arrayBuffer();
          await uploadFile(instanceId, joinPath(targetDir, item.relativePath), buf);
        }
        expandDir(targetDir);
        await load(targetDir);
      });
    },
    [instanceId, load, expandDir, runAction],
  );

  const rootState = dirs[WORKSPACE_ROOT] ?? EMPTY_DIR;
  const isRootDropTarget = dragOverDir === WORKSPACE_ROOT;

  // The visible tree, flattened to a linear list once per render.
  const rows = flattenRows(dirs, expanded);

  // Callbacks + cross-row state, shared by reference. Per-node data stays out of
  // here so a row can never inherit another row's identity.
  const ctx: TreeContext = {
    expanded,
    selected,
    dragOverDir,
    onToggle: toggleDir,
    onSelect: setSelected,
    onSetDragOver: setDragOverDir,
    onDropInto: handleDrop,
    onCopyPath: (p) => void copyText(p),
    onCopyRelative: (p) => void copyText(relativeToRoot(p)),
    onRename: (entry) => setPrompt({ kind: "rename", entry }),
    onDelete: (entry) => setConfirmDelete(entry),
    onNewFile: (d) => setPrompt({ kind: "newFile", dir: d }),
    onNewFolder: (d) => setPrompt({ kind: "newFolder", dir: d }),
  };

  return (
    <div className="flex h-full flex-col text-sm">
      {/* Toolbar: root label + new file/folder + refresh */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span
          className="flex-1 truncate font-mono text-xs text-muted-foreground"
          title={WORKSPACE_ROOT}
        >
          {WORKSPACE_ROOT}
        </span>
        <IconButton
          label="New file"
          onClick={() => setPrompt({ kind: "newFile", dir: WORKSPACE_ROOT })}
        >
          <FilePlus className="size-3.5" />
        </IconButton>
        <IconButton
          label="New folder"
          onClick={() => setPrompt({ kind: "newFolder", dir: WORKSPACE_ROOT })}
        >
          <FolderPlus className="size-3.5" />
        </IconButton>
        <IconButton label="Refresh" onClick={refreshAll}>
          <RefreshCw className={cn("size-3.5", rootState.loading && "animate-spin")} />
        </IconButton>
      </div>

      {(error || busy) && (
        <div
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-xs",
            error ? "bg-destructive/10 text-destructive" : "text-muted-foreground",
          )}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <AlertCircle className="size-3.5" />
          )}
          <span className="flex-1 truncate">{busy ?? error}</span>
          {error && !busy && (
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {/* The whole scroll body is a drop zone. Dropping on empty space targets
          the workspace root. */}
      <div
        className={cn(
          "flex-1 overflow-auto py-1",
          isRootDropTarget && "bg-primary/5 ring-1 ring-inset ring-primary/40",
        )}
        onDragOver={(e) => {
          // preventDefault unconditionally so `drop` fires across webviews.
          // handleDrop is the real guard (it ignores non-file drags).
          e.preventDefault();
          setDragOverDir(WORKSPACE_ROOT);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOverDir(null);
        }}
        onDrop={(e) => handleDrop(WORKSPACE_ROOT, e)}
      >
        {rows.map((row) =>
          row.kind === "entry" ? (
            <TreeRow key={row.entry.path} ctx={ctx} entry={row.entry} depth={row.depth} />
          ) : (
            <PlaceholderRow
              key={row.key}
              depth={row.depth}
              message={row.kind === "error" ? row.message : undefined}
            />
          ),
        )}
        {rootState.entries && rootState.entries.length === 0 && !rootState.loading && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            Empty. Drop files here to add them.
          </div>
        )}
      </div>

      {prompt && (
        <NameDialog
          prompt={prompt}
          onClose={() => setPrompt(null)}
          onSubmit={async (name) => {
            if (prompt.kind === "rename") {
              const dest = joinPath(parentOf(prompt.entry.path), name);
              await runAction(`Renaming…`, async () => {
                await renameFile(instanceId, prompt.entry.path, dest);
                await load(parentOf(prompt.entry.path));
                setSelected(dest);
              });
            } else if (prompt.kind === "newFile") {
              await runAction(`Creating ${name}…`, async () => {
                await createFile(instanceId, joinPath(prompt.dir, name));
                expandDir(prompt.dir);
                await load(prompt.dir);
              });
            } else {
              await runAction(`Creating ${name}…`, async () => {
                await createFolder(instanceId, joinPath(prompt.dir, name));
                expandDir(prompt.dir);
                await load(prompt.dir);
              });
            }
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteDialog
          entry={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            handleDelete(confirmDelete);
            setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// Shared, node-independent state + callbacks for the tree rows. Per-node data
// (entry/depth) is passed explicitly to each row, never bundled in here.
interface TreeContext {
  expanded: Set<string>;
  selected: string | null;
  dragOverDir: string | null;
  onToggle: (dir: string) => void;
  onSelect: (path: string) => void;
  onSetDragOver: (dir: string | null) => void;
  onDropInto: (dir: string, e: React.DragEvent) => void;
  onCopyPath: (path: string) => void;
  onCopyRelative: (path: string) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
}

function PlaceholderRow({ depth, message }: { depth: number; message?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 text-xs",
        message ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ paddingLeft: depth * 12 + 22 }}
    >
      {message ? (
        message
      ) : (
        <>
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </>
      )}
    </div>
  );
}

function TreeRow({ ctx, entry, depth }: { ctx: TreeContext; entry: FileEntry; depth: number }) {
  const isDir = entry.type === "dir";
  const isOpen = isDir && ctx.expanded.has(entry.path);
  // A drop onto a file targets its parent dir. Onto a dir, the dir itself.
  const dropTarget = isDir ? entry.path : parentOf(entry.path);
  const isDropOver = ctx.dragOverDir === dropTarget && isDir;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-selected={ctx.selected === entry.path}
            tabIndex={ctx.selected === entry.path ? 0 : -1}
            className={cn(
              "group flex cursor-pointer items-center gap-1 py-0.5 pr-2 hover:bg-muted/60",
              ctx.selected === entry.path && "bg-muted",
              isDropOver && "bg-primary/10 ring-1 ring-inset ring-primary/40",
            )}
            style={{ paddingLeft: depth * 12 + 6 }}
            onClick={() => {
              ctx.onSelect(entry.path);
              if (isDir) ctx.onToggle(entry.path);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                ctx.onSelect(entry.path);
                if (isDir) ctx.onToggle(entry.path);
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              ctx.onSetDragOver(dropTarget);
            }}
            onDrop={(e) => ctx.onDropInto(dropTarget, e)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              {isDir && (
                <ChevronRight
                  className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
                />
              )}
            </span>
            {isDir ? (
              isOpen ? (
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              )
            ) : (
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 truncate">{entry.name}</span>
            {!isDir && entry.size != null && (
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground opacity-0 group-hover:opacity-100">
                {formatSize(entry.size)}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => ctx.onCopyPath(entry.path)}>
            <Copy className="size-4" /> Copy path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ctx.onCopyRelative(entry.path)}>
            <Copy className="size-4" /> Copy relative path
          </ContextMenuItem>
          <ContextMenuSeparator />
          {isDir && (
            <>
              <ContextMenuItem onSelect={() => ctx.onNewFile(entry.path)}>
                <FilePlus className="size-4" /> New file…
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => ctx.onNewFolder(entry.path)}>
                <FolderPlus className="size-4" /> New folder…
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => ctx.onRename(entry)}>
            <PencilLine className="size-4" /> Rename…
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => ctx.onDelete(entry)}>
            <Trash2 className="size-4" /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}

function NameDialog({
  prompt,
  onClose,
  onSubmit,
}: {
  prompt: Prompt;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const initial = prompt.kind === "rename" ? prompt.entry.name : "";
  const [name, setName] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const title =
    prompt.kind === "rename" ? "Rename" : prompt.kind === "newFile" ? "New file" : "New folder";
  const trimmed = name.trim();
  const invalid =
    trimmed.length === 0 || trimmed.includes("/") || trimmed === "." || trimmed === "..";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {prompt.kind === "rename"
              ? "Enter a new name."
              : "Enter a name. It can't contain a slash."}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (invalid || submitting) return;
            setSubmitting(true);
            void onSubmit(trimmed)
              .then(() => onClose())
              .finally(() => setSubmitting(false));
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => {
              // Pre-select the basename (sans extension) for a quick rename.
              if (prompt.kind === "rename") {
                const dot = initial.lastIndexOf(".");
                e.target.setSelectionRange(0, dot > 0 ? dot : initial.length);
              }
            }}
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDeleteDialog({
  entry,
  onClose,
  onConfirm,
}: {
  entry: FileEntry;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {entry.type === "dir" ? "folder" : "file"}?</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{entry.name}</span>
            {entry.type === "dir" ? " and everything inside it" : ""} will be permanently removed
            from the workspace. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
