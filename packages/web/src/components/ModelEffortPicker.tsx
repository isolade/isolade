import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatEffort, ChatModelDefinition, ModelOverrides } from "../lib/contracts";
import { effectiveModelTier, splitModelsByTier } from "../lib/contracts";
import { cn, effortLabel } from "../lib/utils";

interface ModelEffortPickerProps {
  /** The full catalog for this picker (Claude + Codex), before overrides. */
  models: ChatModelDefinition[];
  /** Per-profile visibility/tier overrides applied to `models`. */
  overrides: ModelOverrides;
  currentModelId: string;
  currentEffort: ChatEffort;
  onModelChange: (id: string) => void;
  onEffortChange: (effort: ChatEffort) => void;
  disabled?: boolean;
  /** Optional content rendered at the top of the dropdown (e.g. context usage detail). */
  prepend?: ReactNode;
  /** Optional content rendered inside the trigger button, below the label. */
  belowLabel?: ReactNode;
  align?: "start" | "center" | "end";
}

const TRIGGER_CLS =
  "group/trigger inline-flex flex-col items-stretch justify-center rounded-md min-h-8 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none w-auto";

export function ModelEffortPicker({
  models,
  overrides,
  currentModelId,
  currentEffort,
  onModelChange,
  onEffortChange,
  disabled,
  prepend,
  belowLabel,
  align = "end",
}: ModelEffortPickerProps) {
  const currentModel = models.find((m) => m.id === currentModelId);
  const supportedEfforts = currentModel?.supportedEfforts ?? [];
  // Keep the current model visible (under More…) even if it's been hidden, so
  // a chat already on a since-hidden model still shows and stays switchable.
  const { frontier, more: legacy } = splitModelsByTier(models, overrides, currentModelId);
  const [showLegacy, setShowLegacy] = useState(
    () => effectiveModelTier(currentModelId, overrides) !== "default",
  );
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger disabled={disabled} className={TRIGGER_CLS} data-demo="model-picker">
        <span className="inline-flex items-center justify-between gap-1">
          <span>
            {currentModel?.name ?? currentModelId}
            {supportedEfforts.length > 1 && <> {effortLabel(currentEffort)}</>}
          </span>
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </span>
        {belowLabel}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[16rem]" align={align} sideOffset={4}>
        {prepend && (
          <>
            {prepend}
            <DropdownMenuSeparator />
          </>
        )}
        <div role="radiogroup" aria-label="Model">
          {frontier.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              selected={m.id === currentModelId}
              onSelect={() => onModelChange(m.id)}
            />
          ))}
          {legacy.length > 0 &&
            showLegacy &&
            legacy.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                selected={m.id === currentModelId}
                onSelect={() => onModelChange(m.id)}
              />
            ))}
        </div>
        {legacy.length > 0 && !showLegacy && (
          <DropdownMenuItem
            className="text-muted-foreground"
            onSelect={(e) => {
              e.preventDefault();
              setShowLegacy(true);
            }}
          >
            More…
          </DropdownMenuItem>
        )}
        {supportedEfforts.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <div role="radiogroup" aria-label="Effort" className="px-2 pt-2.5 pb-1.5">
              <div className="flex items-start">
                {supportedEfforts.map((e, i) => {
                  const selected = e === currentEffort;
                  const isFirst = i === 0;
                  const isLast = i === supportedEfforts.length - 1;
                  return (
                    <button
                      key={e}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={(ev) => {
                        ev.preventDefault();
                        onEffortChange(e);
                        setOpen(false);
                      }}
                      className="group relative flex flex-1 cursor-pointer flex-col items-center gap-1.5 outline-none"
                    >
                      <div className="relative flex h-3 w-full items-center justify-center">
                        {!isFirst && (
                          <span className="absolute top-1/2 left-0 right-1/2 h-px -translate-y-1/2 bg-border" />
                        )}
                        {!isLast && (
                          <span className="absolute top-1/2 left-1/2 right-0 h-px -translate-y-1/2 bg-border" />
                        )}
                        <span
                          className={cn(
                            "relative z-10 size-2.5 rounded-full border transition-colors",
                            selected
                              ? "border-foreground bg-foreground"
                              : "border-muted-foreground/50 bg-background group-hover:border-foreground",
                          )}
                        />
                      </div>
                      <span
                        className={cn(
                          "text-[10px] leading-none whitespace-nowrap transition-colors",
                          selected
                            ? "font-medium text-foreground"
                            : "text-muted-foreground group-hover:text-foreground",
                        )}
                      >
                        {effortLabel(e)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: ChatModelDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      role="radio"
      aria-checked={selected}
      onSelect={onSelect}
      data-demo={`model-${model.id}`}
      className="justify-between"
    >
      <span>{model.name}</span>
      {selected && <CheckIcon className="size-3.5 opacity-80" />}
    </DropdownMenuItem>
  );
}
