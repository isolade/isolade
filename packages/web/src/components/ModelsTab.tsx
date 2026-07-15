import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getProfileModelOverrides, setProfileModelOverrides } from "../lib/api";
import type {
  ChatModelDefinition,
  ChatProvider,
  ModelOverrides,
  ModelTier,
} from "../lib/contracts";
import { defaultModelTier, effectiveModelTier, setModelTierOverride } from "../lib/contracts";

interface ModelsTabProps {
  activeProfileId: string | null;
  chatModels: ChatModelDefinition[];
}

const TIERS: { value: ModelTier; label: string }[] = [
  { value: "default", label: "Shown" },
  { value: "more", label: "More…" },
  { value: "hidden", label: "Hidden" },
];

const PROVIDER_LABELS: Record<ChatProvider, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
};

// The catalog is small and provider order is stable (Claude, then Codex), so a
// simple ordered group-by preserving first-seen provider order reads cleanly.
function groupByProvider(
  models: ChatModelDefinition[],
): { provider: ChatProvider; models: ChatModelDefinition[] }[] {
  const groups: { provider: ChatProvider; models: ChatModelDefinition[] }[] = [];
  for (const model of models) {
    let group = groups.find((g) => g.provider === model.provider);
    if (!group) {
      group = { provider: model.provider, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

export default function ModelsTab({ activeProfileId, chatModels }: ModelsTabProps) {
  // Overrides are authoritative for the active profile, fetched here (rather
  // than reused from the pickers, which may be scoped to a different instance's
  // profile). Saved on every change; the pickers re-sync when settings closes.
  const [overrides, setOverrides] = useState<ModelOverrides>({});

  useEffect(() => {
    let cancelled = false;
    if (!activeProfileId) {
      setOverrides({});
      return;
    }
    void (async () => {
      try {
        const next = await getProfileModelOverrides(activeProfileId);
        if (!cancelled) setOverrides(next);
      } catch {
        if (!cancelled) setOverrides({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId]);

  const groups = useMemo(() => groupByProvider(chatModels), [chatModels]);
  const hasOverrides = Object.keys(overrides).length > 0;

  const persist = (next: ModelOverrides) => {
    setOverrides(next);
    if (activeProfileId) void setProfileModelOverrides(activeProfileId, next).catch(() => {});
  };

  const chooseTier = (id: string, tier: ModelTier) => {
    persist(setModelTierOverride(overrides, id, tier));
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 max-w-2xl">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">Models</span>
          <span className="text-xs text-muted-foreground">
            Choose which models appear in the picker and where. “Shown” sits at the top level,
            “More…” tucks it behind the picker’s More… menu, and “Hidden” removes it. Changes only
            store what you customize, so new or updated models still come through.
          </span>
        </div>
        <Button
          variant="outline"
          size="xs"
          disabled={!hasOverrides}
          onClick={() => persist({})}
          className="flex-shrink-0"
        >
          <RotateCcw />
          Reset
        </Button>
      </div>

      {groups.map((group) => (
        <div key={group.provider} className="space-y-2 max-w-2xl">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {PROVIDER_LABELS[group.provider]}
          </span>
          <div className="rounded-lg border border-border divide-y divide-border">
            {group.models.map((model) => {
              const tier = effectiveModelTier(model.id, overrides);
              const customized = tier !== defaultModelTier(model.id);
              return (
                <div key={model.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-sm truncate">{model.name}</span>
                    {customized && (
                      <span className="text-[10px] text-muted-foreground">(customized)</span>
                    )}
                  </span>
                  <div
                    role="radiogroup"
                    aria-label={`Visibility for ${model.name}`}
                    className="flex flex-shrink-0 rounded-md border border-border p-0.5 gap-0.5"
                  >
                    {TIERS.map((t) => {
                      const selected = t.value === tier;
                      return (
                        <button
                          key={t.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={!activeProfileId}
                          onClick={() => chooseTier(model.id, t.value)}
                          className={cn(
                            "rounded px-2 py-1 text-xs transition-colors outline-none disabled:opacity-50",
                            selected
                              ? "bg-foreground text-background"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                          )}
                        >
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
