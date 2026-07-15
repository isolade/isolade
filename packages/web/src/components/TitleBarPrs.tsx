import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AttachedPr } from "../lib/contracts";
import { openExternal } from "../lib/tauri";

// PR-state → icon + colour. Matches GitHub's own semantics so the badge reads at
// a glance: green open, purple merged, red closed, muted draft/unknown. A draft
// open PR shows the draft glyph regardless of colour.
function stateStyle(pr: AttachedPr): { Icon: typeof GitPullRequest; color: string } {
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

// A human summary for the badge's tooltip: repo#number, title, and state.
function tooltip(pr: AttachedPr): string {
  const head = `${pr.owner}/${pr.repo}#${pr.number}`;
  const state = pr.isDraft && pr.state === "open" ? "draft" : pr.state;
  return pr.title ? `${head} · ${pr.title} (${state})` : `${head} (${state})`;
}

// Pull requests attached to the active chat (via `isolade pr add`), rendered as
// a row of compact badges hanging off the right of the title-bar search field.
// Clicking a badge opens the PR in the system browser; the hover-revealed ×
// detaches it. Empty renders nothing so the title bar is untouched when no chat
// (or no PR) is in view.
export default function TitleBarPrs({
  prs,
  onDetach,
}: {
  prs: AttachedPr[];
  onDetach: (pr: AttachedPr) => void;
}) {
  if (prs.length === 0) return null;
  return (
    <div data-no-drag className="flex items-center gap-1">
      {prs.map((pr) => {
        const { Icon, color } = stateStyle(pr);
        return (
          <div
            key={`${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`}
            className="group/pr flex h-6 items-center rounded-md border border-border/60 bg-accent pr-0.5 shadow-xs"
          >
            <button
              type="button"
              title={tooltip(pr)}
              onClick={() => void openExternal(pr.url)}
              className="flex h-full items-center gap-1 rounded-md pl-1.5 pr-1 text-xs text-foreground transition-colors hover:text-foreground/80"
            >
              <Icon className={cn("size-3.5 flex-shrink-0", color)} aria-hidden />
              <span className="tabular-nums">#{pr.number}</span>
            </button>
            <button
              type="button"
              aria-label={`Detach PR #${pr.number}`}
              title="Detach"
              onClick={() => onDetach(pr)}
              className="grid size-4 flex-shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover/pr:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
