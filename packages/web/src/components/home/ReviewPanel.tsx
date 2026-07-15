import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  FileDiff,
  Loader2,
  RefreshCw,
  UnfoldVertical,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getFileLines, getWorkspaceDiff } from "../../lib/api";
import type { DiffFile, WorkspaceDiff } from "../../lib/contracts";
import {
  type DiffRow,
  fileSegments,
  type GapRegion,
  hunkRows,
  languageForPath,
  nextContextRange,
  statusLabel,
} from "./review-model";
import { highlightLine } from "./syntax";

// How many context lines one expander click reveals (GitHub's default chunk).
const CONTEXT_CHUNK = 20;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface ReviewPanelProps {
  instanceId: string;
  // True while the Review tab is the visible panel body. Becoming active
  // triggers a silent refresh so changes made elsewhere (terminal, agent) show.
  active: boolean;
}

// Per-status accent for the file-header letter badge, mirroring GitHub's
// add/delete/modify/rename palette.
const STATUS_BADGE: Record<DiffFile["status"], string> = {
  added: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  deleted: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  modified: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  renamed: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
};

function ReviewPanel({ instanceId, active }: ReviewPanelProps) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Collapsed file paths. Default-expanded, so an empty set means "all open".
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Abort an in-flight fetch when a newer one starts or the instance changes,
  // so a slow response can't clobber fresher data.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const result = await getWorkspaceDiff(instanceId, ac.signal);
      if (ac.signal.aborted) return;
      setDiff(result);
    } catch (err) {
      if (ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [instanceId]);

  // Reset and load whenever the instance changes. Abort on unmount.
  useEffect(() => {
    setDiff(null);
    setCollapsed(new Set());
    void load();
    return () => abortRef.current?.abort();
  }, [instanceId, load]);

  // Silent refresh when the panel becomes visible again.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) void load();
    wasActive.current = active;
  }, [active, load]);

  const toggleFile = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const files = diff?.files ?? [];
  const allCollapsed = files.length > 0 && collapsed.size >= files.length;
  const toggleAll = useCallback(() => {
    const fs = diff?.files ?? [];
    setCollapsed((prev) => (prev.size >= fs.length ? new Set() : new Set(fs.map((f) => f.path))));
  }, [diff]);

  const totalAdds = files.reduce((n, f) => n + f.additions, 0);
  const totalDels = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="flex h-full flex-col text-sm">
      {/* Toolbar: summary + expand/collapse-all + refresh */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {files.length === 0
            ? "No changes"
            : `${files.length} file${files.length === 1 ? "" : "s"} changed`}
          {files.length > 0 && (
            <>
              {" · "}
              <span className="text-emerald-600 dark:text-emerald-400">+{totalAdds}</span>{" "}
              <span className="text-rose-600 dark:text-rose-400">&minus;{totalDels}</span>
            </>
          )}
        </span>
        {files.length > 0 && (
          <IconButton label={allCollapsed ? "Expand all" : "Collapse all"} onClick={toggleAll}>
            {allCollapsed ? (
              <ChevronsUpDown className="size-3.5" />
            ) : (
              <ChevronsDownUp className="size-3.5" />
            )}
          </IconButton>
        )}
        <IconButton label="Refresh" onClick={() => void load()}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </IconButton>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="flex-1 truncate" title={error}>
            {error}
          </span>
        </div>
      )}

      {diff?.truncated && (
        <div className="px-2 py-1 text-xs text-muted-foreground">
          Some large files were clipped to keep the view responsive.
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && !diff && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-1.5 size-3.5 animate-spin" /> Loading diff…
          </div>
        )}

        {!loading && !error && files.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <FileDiff className="size-6 opacity-40" />
            <span>No changes to review.</span>
          </div>
        )}

        {files.map((file) => (
          <FileDiffView
            key={file.path}
            instanceId={instanceId}
            file={file}
            collapsed={collapsed.has(file.path)}
            onToggle={() => toggleFile(file.path)}
          />
        ))}
      </div>
    </div>
  );
}

function FileDiffView({
  instanceId,
  file,
  collapsed,
  onToggle,
}: {
  instanceId: string;
  file: DiffFile;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-border">
      {/* File header. Click anywhere to expand/collapse, GitHub-style. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold",
            STATUS_BADGE[file.status],
          )}
          title={statusLabel(file)}
        >
          {statusLabel(file)[0]}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        >
          {file.oldPath && file.oldPath !== file.path && (
            <span className="text-muted-foreground">{file.oldPath} → </span>
          )}
          {file.path}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
          <span className="text-rose-600 dark:text-rose-400">&minus;{file.deletions}</span>
        </span>
      </button>

      {!collapsed &&
        (file.binary ? (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            Binary file not shown
          </div>
        ) : file.hunks.length === 0 ? (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            No content changes
          </div>
        ) : (
          <DiffBody instanceId={instanceId} file={file} />
        ))}
    </div>
  );
}

// Per-region reveal state for context expansion. Lines are keyed by new-file
// line number, and `topCount`/`bottomCount` track how many have been revealed from
// each boundary so the two halves grow toward each other. `eof` only applies to
// the trailing region (whose end isn't known until we read it).
interface RegionState {
  lines: Map<number, string>;
  topCount: number;
  bottomCount: number;
  eof: boolean;
  loading: boolean;
  error: string | null;
}

const FRESH_REGION: RegionState = {
  lines: new Map(),
  topCount: 0,
  bottomCount: 0,
  eof: false,
  loading: false,
  error: null,
};

// The unified diff body for one file. Mounted only while the file is expanded,
// so syntax highlighting and context fetches are lazy. Highlighted hunk rows
// are memoized so scrolling and parent re-renders don't re-tokenize. The
// language is inferred once from the path (e.g. `src/foo.ts` → typescript).
function DiffBody({ instanceId, file }: { instanceId: string; file: DiffFile }) {
  const language = useMemo(() => languageForPath(file.path), [file.path]);
  const segments = useMemo(() => fileSegments(file), [file]);
  const hunkRowCache = useMemo(
    () =>
      new Map(
        file.hunks.map((hunk) => [
          hunk,
          hunkRows(hunk).map((row) => ({
            row,
            content: row.type === "meta" ? null : highlightLine(row.text, language),
          })),
        ]),
      ),
    [file, language],
  );

  // Revealed context per gap region, reset whenever the file (i.e. the diff)
  // changes. A ref mirrors it so the async expander can read current counts
  // without re-subscribing.
  const [regions, setRegions] = useState<Map<number, RegionState>>(() => new Map());
  useEffect(() => setRegions(new Map()), [file]);
  const regionsRef = useRef(regions);
  regionsRef.current = regions;

  const patchRegion = useCallback((id: number, fn: (s: RegionState) => RegionState) => {
    setRegions((prev) => {
      const next = new Map(prev);
      next.set(id, fn(prev.get(id) ?? FRESH_REGION));
      return next;
    });
  }, []);

  // Reveal another chunk of a region from one side. "top" grows the block below
  // the upper boundary. "bottom" grows the block above the lower boundary. The
  // trailing region only grows from the top (its lower end is EOF).
  const expand = useCallback(
    async (region: GapRegion, side: "top" | "bottom") => {
      const cur = regionsRef.current.get(region.id) ?? FRESH_REGION;
      if (cur.loading) return;

      const range = nextContextRange(region, cur.topCount, cur.bottomCount, side, CONTEXT_CHUNK);
      if (!range) return;
      const { from, to } = range;

      patchRegion(region.id, (s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await getFileLines(instanceId, file.path, from, to);
        patchRegion(region.id, (s) => {
          const lines = new Map(s.lines);
          res.lines.forEach((text, i) => lines.set(from + i, text));
          const gained = res.lines.length;
          if (region.kind === "trailing" || region.nEnd === null) {
            return {
              ...s,
              lines,
              loading: false,
              topCount: s.topCount + gained,
              eof: res.eof,
            };
          }
          return side === "top"
            ? { ...s, lines, loading: false, topCount: s.topCount + gained }
            : {
                ...s,
                lines,
                loading: false,
                bottomCount: s.bottomCount + gained,
              };
        });
      } catch (err) {
        patchRegion(region.id, (s) => ({
          ...s,
          loading: false,
          error: errMsg(err),
        }));
      }
    },
    [instanceId, file.path, patchRegion],
  );

  return (
    <div className="overflow-x-auto border-t border-border font-mono text-xs leading-5">
      {segments.map((segment, i) =>
        segment.kind === "hunk" ? (
          <Hunk
            key={`h${i}`}
            header={segment.hunk.header}
            rows={hunkRowCache.get(segment.hunk) ?? []}
          />
        ) : (
          <ContextGap
            key={`g${segment.region.id}`}
            region={segment.region}
            state={regions.get(segment.region.id) ?? FRESH_REGION}
            language={language}
            onExpand={(side) => void expand(segment.region, side)}
          />
        ),
      )}
    </div>
  );
}

function Hunk({ header, rows }: { header: string; rows: { row: DiffRow; content: ReactNode }[] }) {
  return (
    <div>
      <div className="whitespace-pre bg-muted/40 px-2 py-0.5 text-muted-foreground">{header}</div>
      {rows.map(({ row, content }, ri) => (
        <DiffLine key={ri} row={row} content={content} />
      ))}
    </div>
  );
}

// An expandable run of unchanged lines. Revealed lines render above and below a
// central expander control (GitHub-style). Clicking grows the gap until it's
// fully shown (bounded regions) or hits EOF (the trailing region).
function ContextGap({
  region,
  state,
  language,
  onExpand,
}: {
  region: GapRegion;
  state: RegionState;
  language: string | null;
  onExpand: (side: "top" | "bottom") => void;
}) {
  const row = (newNo: number) => {
    const text = state.lines.get(newNo);
    if (text === undefined) return null;
    const diffRow: DiffRow = {
      type: "context",
      oldNo: newNo + region.delta,
      newNo,
      text,
    };
    return <DiffLine key={newNo} row={diffRow} content={highlightLine(text, language)} />;
  };

  const top: ReactNode[] = [];
  for (let k = 0; k < state.topCount; k++) top.push(row(region.nStart + k));

  const bottom: ReactNode[] = [];
  if (region.kind !== "trailing" && region.nEnd !== null) {
    for (let k = state.bottomCount - 1; k >= 0; k--) bottom.push(row(region.nEnd - k));
  }

  const remaining =
    region.kind === "trailing" || region.nEnd === null
      ? null
      : region.nEnd - region.nStart + 1 - state.topCount - state.bottomCount;
  const showExpander = region.kind === "trailing" ? !state.eof : (remaining ?? 0) > 0;

  return (
    <>
      {top}
      {showExpander && (
        <Expander
          region={region}
          remaining={remaining}
          loading={state.loading}
          error={state.error}
          onExpand={onExpand}
        />
      )}
      {bottom}
    </>
  );
}

function Expander({
  region,
  remaining,
  loading,
  error,
  onExpand,
}: {
  region: GapRegion;
  remaining: number | null;
  loading: boolean;
  error: string | null;
  onExpand: (side: "top" | "bottom") => void;
}) {
  const trailing = region.kind === "trailing" || region.nEnd === null;
  // A small bounded gap collapses fully in one click, so show a single control.
  // A larger one (or the open-ended trailing region) gets directional controls.
  const small = !trailing && remaining !== null && remaining <= CONTEXT_CHUNK;

  return (
    <div className="flex items-center gap-2 bg-sky-500/5 px-1 py-0.5 text-muted-foreground hover:bg-sky-500/10">
      <span className="flex w-[5.25rem] shrink-0 items-center justify-center gap-0.5">
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : small ? (
          <ExpandButton label="Expand all lines" onClick={() => onExpand("top")}>
            <UnfoldVertical className="size-3.5" />
          </ExpandButton>
        ) : trailing ? (
          <ExpandButton label="Expand down" onClick={() => onExpand("top")}>
            <ChevronDown className="size-3.5" />
          </ExpandButton>
        ) : (
          <>
            <ExpandButton label="Expand up" onClick={() => onExpand("top")}>
              <ChevronUp className="size-3.5" />
            </ExpandButton>
            <ExpandButton label="Expand down" onClick={() => onExpand("bottom")}>
              <ChevronDown className="size-3.5" />
            </ExpandButton>
          </>
        )}
      </span>
      <span className="truncate text-[11px]">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : remaining !== null ? (
          `${remaining} hidden lines`
        ) : (
          "Expand"
        )}
      </span>
    </div>
  );
}

function ExpandButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-0.5 hover:bg-sky-500/20 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function DiffLine({ row, content }: { row: DiffRow; content: ReactNode }) {
  if (row.type === "meta") {
    return (
      <div className="whitespace-pre px-2 py-0.5 italic text-muted-foreground/70">{row.text}</div>
    );
  }
  const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
  return (
    <div
      className={cn(
        "flex min-w-max",
        row.type === "add" && "bg-emerald-500/10",
        row.type === "del" && "bg-rose-500/10",
      )}
    >
      <Gutter n={row.oldNo} />
      <Gutter n={row.newNo} />
      <span
        className={cn(
          "w-3 shrink-0 select-none text-center",
          row.type === "add" && "text-emerald-600 dark:text-emerald-400",
          row.type === "del" && "text-rose-600 dark:text-rose-400",
        )}
      >
        {sign}
      </span>
      <span className="whitespace-pre pr-3">{content}</span>
    </div>
  );
}

function Gutter({ n }: { n: number | null }) {
  return (
    <span className="w-10 shrink-0 select-none px-1 text-right tabular-nums text-muted-foreground/60">
      {n ?? ""}
    </span>
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

// Memoized: its props (instanceId, active) are stable while the parent SidePanel
// re-renders for unrelated reasons, so a large diff isn't reconciled needlessly.
export default memo(ReviewPanel);
