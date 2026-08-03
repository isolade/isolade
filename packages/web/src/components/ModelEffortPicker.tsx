import { AlertTriangle, CheckIcon, ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  availableModels,
  CHAT_PROVIDER_LABELS,
  isProviderAvailable,
  signedOutProviders,
  useAgentAuth,
} from "../lib/agent-auth";
import type { ChatEffort, ChatModelDefinition, ModelOverrides } from "../lib/contracts";
import { effectiveModelTier, splitModelsByTier } from "../lib/contracts";
import { cn, effortLabel } from "../lib/utils";

interface ModelEffortPickerProps {
  /** The full catalog for this picker (Claude + Codex), before overrides and
   *  before the signed-out providers are dropped. */
  models: ChatModelDefinition[];
  /** Per-profile visibility/tier overrides applied to `models`. */
  overrides: ModelOverrides;
  currentModelId: string;
  currentEffort: ChatEffort;
  onModelChange: (id: string) => void;
  onEffortChange: (effort: ChatEffort) => void;
  disabled?: boolean;
  align?: "start" | "center" | "end";
}

// `min-w-0 max-w-full` lets the trigger give way inside a composer row too
// narrow to hold everything, at which point the model name truncates rather than
// the row growing past the composer's border.
const TRIGGER_CLS =
  "inline-flex h-8 w-auto min-w-0 max-w-full items-center justify-between gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none";

export function ModelEffortPicker({
  models,
  overrides,
  currentModelId,
  currentEffort,
  onModelChange,
  onEffortChange,
  disabled,
  align = "end",
}: ModelEffortPickerProps) {
  const currentModel = models.find((m) => m.id === currentModelId);
  const supportedEfforts = currentModel?.supportedEfforts ?? [];
  // A model whose provider this profile isn't signed in to can't run, so it is
  // not offered at all rather than listed as a choice that fails on send. The
  // chat's own model stays listed either way (see availableModels).
  const { available, openSignIn } = useAgentAuth();
  const offered = useMemo(
    () => availableModels(models, available, currentModelId),
    [models, available, currentModelId],
  );
  const signedOut = useMemo(() => signedOutProviders(models, available), [models, available]);
  // A chat can already be on a model whose provider has since been signed out.
  // That is a fact about the model, so the picker is where it is said: the
  // trigger flags it in place, and the menu behind it holds both ways out (the
  // other provider's models, and the row that opens the login). Nothing in the
  // composer grows a row for it.
  const unavailable =
    currentModel != null && !isProviderAvailable(currentModel.provider, available);
  const unavailableReason = unavailable
    ? `Not signed in to ${CHAT_PROVIDER_LABELS[currentModel.provider]}. Pick another model, or sign in.`
    : undefined;
  // Keep the current model visible (under More…) even if it's been hidden, so
  // a chat already on a since-hidden model still shows and stays switchable.
  const { frontier, more: legacy } = splitModelsByTier(offered, overrides, currentModelId);
  const [showLegacy, setShowLegacy] = useState(
    () => effectiveModelTier(currentModelId, overrides) !== "default",
  );
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        // Amber, not red: the chat is fine, its model is just out of reach until
        // one of the two things behind this trigger is done.
        className={cn(TRIGGER_CLS, unavailable && "text-amber-500 hover:text-amber-500")}
        title={unavailableReason}
        data-demo="model-picker"
      >
        {unavailable && <AlertTriangle className="size-3.5 shrink-0" />}
        <span className="truncate">
          {currentModel?.name ?? currentModelId}
          {supportedEfforts.length > 1 && <> {effortLabel(currentEffort)}</>}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[16rem]" align={align} sideOffset={4}>
        <div role="radiogroup" aria-label="Model">
          {frontier.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              selected={m.id === currentModelId}
              unavailable={unavailable && m.id === currentModelId}
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
                unavailable={unavailable && m.id === currentModelId}
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
        {/* Where a signed-out provider's models would have been. Hiding them
            without this would leave no trace of half the catalog, so the way
            back sits in the menu they went missing from — below a rule, because
            it opens Settings rather than picking anything. */}
        {signedOut.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {signedOut.map((provider) => (
              <DropdownMenuItem
                key={provider}
                className="text-muted-foreground"
                onSelect={openSignIn}
              >
                Sign in to {CHAT_PROVIDER_LABELS[provider]}…
              </DropdownMenuItem>
            ))}
          </>
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
                            "relative z-10 size-2.5 rounded-full border",
                            selected
                              ? "border-foreground bg-foreground"
                              : "border-muted-foreground/50 bg-background group-hover:border-foreground",
                          )}
                        />
                      </div>
                      <span
                        className={cn(
                          "text-[10px] leading-none whitespace-nowrap",
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
  unavailable,
  onSelect,
}: {
  model: ChatModelDefinition;
  selected: boolean;
  // The chat's own model, kept in the list although its provider is signed out.
  // Flagged here as well as on the trigger, so the row the tick is on and the
  // row that can't run are visibly the same one.
  unavailable?: boolean;
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
      <span className={cn("flex min-w-0 items-center gap-1.5", unavailable && "text-amber-500")}>
        {unavailable && <AlertTriangle className="size-3.5 shrink-0" />}
        <span className="truncate">{model.name}</span>
      </span>
      {selected && <CheckIcon className="size-3.5 opacity-80" />}
    </DropdownMenuItem>
  );
}
