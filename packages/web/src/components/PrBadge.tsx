import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AttachedPr } from "../lib/contracts";
import { openExternal } from "../lib/tauri";

// PR-state → icon + colour. Matches GitHub's own semantics so the badge reads at
// a glance: green open, purple merged, red closed, muted draft/unknown. A draft
// open PR shows the draft glyph regardless of colour.
function stateStyle(pr: AttachedPr): { Icon: LucideIcon; color: string } {
  if (pr.state === "merged") return { Icon: GitMerge, color: "text-purple-500" };
  if (pr.state === "closed") return { Icon: GitPullRequestClosed, color: "text-red-500" };
  if (pr.state === "open") {
    return pr.isDraft
      ? { Icon: GitPullRequestDraft, color: "text-muted-foreground" }
      : { Icon: GitPullRequest, color: "text-green-500" };
  }
  // "unknown": attached but not yet probed (or a non-GitHub host we can't read).
  return { Icon: GitPullRequest, color: "text-muted-foreground" };
}

// The one-word state, for the menu row (colour alone can't carry it).
function stateLabel(pr: AttachedPr): string {
  return pr.isDraft && pr.state === "open" ? "draft" : pr.state;
}

const prKey = (pr: AttachedPr) => `${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`;

// Which PR's glyph the collapsed chip wears: the liveliest one, since an open PR
// is the one still asking for something. Everything else is history, ordered
// newest-status-first so a merged PR beats a closed one.
function dominant(prs: AttachedPr[]): AttachedPr {
  return (
    prs.find((pr) => pr.state === "open" && !pr.isDraft) ??
    prs.find((pr) => pr.state === "open") ??
    prs.find((pr) => pr.state === "merged") ??
    prs.find((pr) => pr.state === "closed") ??
    (prs[0] as AttachedPr)
  );
}

// Pull requests attached to the active chat (via `isolade pr add`), collapsed
// into one chip that lives at the trailing end of the tab strip, so they cost no
// vertical space and don't repeat per panel. The chip carries the liveliest PR's
// glyph plus its number (or a count, once there are several); its menu lists
// them with title and state, opens one in the system browser, and detaches one.
// Empty renders nothing, so a chat with no attached PR leaves the strip as it
// was.
export default function PrBadge({
  prs,
  onDetach,
}: {
  prs: AttachedPr[];
  onDetach: (pr: AttachedPr) => void;
}) {
  if (prs.length === 0) return null;
  const { Icon, color } = stateStyle(dominant(prs));
  const single = prs.length === 1 ? (prs[0] as AttachedPr) : null;
  return (
    <DropdownMenu>
      {/* data-no-drag: on a top-edge panel the strip is the window's drag
          surface, and a chip in it has to stay clickable. */}
      <DropdownMenuTrigger
        data-no-drag
        data-demo="pr-badge"
        title={
          single
            ? `${prKey(single)} (${stateLabel(single)})`
            : `${prs.length} pull requests attached to this chat`
        }
        aria-label={
          single ? `Pull request #${single.number}` : `${prs.length} attached pull requests`
        }
        className="mr-1 flex h-6 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none data-[state=open]:bg-muted/50 data-[state=open]:text-foreground"
      >
        <Icon className={cn("size-3.5 flex-shrink-0", color)} aria-hidden />
        <span className="tabular-nums">{single ? `#${single.number}` : `${prs.length} PRs`}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-96 min-w-72">
        {prs.map((pr) => {
          const style = stateStyle(pr);
          return (
            <div key={prKey(pr)} className="flex items-center gap-0.5">
              <DropdownMenuItem
                className="min-w-0 flex-1 items-start"
                onSelect={() => void openExternal(pr.url)}
              >
                <style.Icon className={cn("mt-0.5 size-3.5", style.color)} aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-xs">
                      {pr.owner}/{pr.repo}
                      <span className="tabular-nums">#{pr.number}</span>
                    </span>
                    <span className="flex-shrink-0 text-[10px] text-muted-foreground">
                      {stateLabel(pr)}
                    </span>
                  </span>
                  {pr.title && (
                    <span className="truncate text-[10px] text-muted-foreground">{pr.title}</span>
                  )}
                </span>
              </DropdownMenuItem>
              {/* A menu item of its own rather than a hover-revealed button, so
                  detaching is reachable by keyboard and never hidden. Keeps the
                  menu open, so several PRs can go in one pass. */}
              <DropdownMenuItem
                className="flex-shrink-0 justify-center px-1.5"
                aria-label={`Detach PR #${pr.number}`}
                title="Detach"
                onSelect={(e) => {
                  e.preventDefault();
                  onDetach(pr);
                }}
              >
                <X className="size-3.5" />
              </DropdownMenuItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
