import { Zap } from "lucide-react";
import type { ChatModelDefinition } from "../lib/contracts";
import { cn } from "../lib/utils";

// Fast mode, as a bolt in the composer's bottom row rather than as an item
// buried in the model picker. It is per chat and costs a premium, so it wants to
// be visible while the chat runs rather than only while the picker is open: off
// it is an outline the eye skips, on it fills in and says so in words.
//
// Only the models that offer it get one (Claude's fast mode, Codex's priority
// tier), which the catalog reports as a second rate card. Surfaces with nowhere
// to store the choice, the new-chat draft, pass no handler and get no bolt.
export function FastModeToggle({
  model,
  fastMode = false,
  onFastModeChange,
  disabled,
}: {
  model?: ChatModelDefinition;
  fastMode?: boolean;
  onFastModeChange?: (fast: boolean) => void;
  disabled?: boolean;
}) {
  if (!onFastModeChange || !model?.fastPricing) return null;
  // The multiplier, not the raw rate: what it costs relative to what this model
  // already costs is the decision being made.
  const label = fastMode
    ? `Fast mode on, at ${fastRateLabel(model)} the usual rate. Click to turn it off`
    : `Fast mode off. Click to run this chat at ${fastRateLabel(model)} the usual rate`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={fastMode}
      disabled={disabled}
      onClick={() => onFastModeChange(!fastMode)}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-1.5 text-xs disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        fastMode ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Zap className={cn("size-3.5 shrink-0", fastMode && "fill-current")} aria-hidden />
      {/* The word arrives with the fill rather than appearing at once, so
          switching it on reads as one motion. A grid track is what makes that
          animatable: `auto` and `width` are not interpolable, but 0fr to 1fr is,
          and it measures the word itself rather than a guessed width. The label
          stays mounted through both states so the row it sits in never reflows
          from a node appearing. */}
      <span
        className={cn(
          "grid transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none",
          fastMode ? "grid-cols-[1fr]" : "grid-cols-[0fr]",
        )}
      >
        <span className="overflow-hidden">
          <span className="pl-1">Fast</span>
        </span>
      </span>
    </button>
  );
}

// How much dearer fast mode is for this model, from the two rate cards rather
// than a hardcoded number, so it tracks the catalog.
export function fastRateLabel(model: ChatModelDefinition): string {
  const base = model.pricing?.inputPerMTok;
  const fast = model.fastPricing?.inputPerMTok;
  if (!base || !fast) return "a premium on";
  const ratio = fast / base;
  return `${Number.isInteger(ratio) ? ratio : ratio.toFixed(1)}×`;
}
