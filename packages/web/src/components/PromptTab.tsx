import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getPromptConfig, setPromptConfig } from "../lib/api";
import type { PromptConfig } from "../lib/contracts";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Ordered best-default-first, then by who writes the prompt: the two where Isolade
// does come before the one where it does not, which is also the replace/append
// split in IsoladeSystemPrompt. One line each, since the hint is the only
// explanation an option gets and a reader is choosing between three of them.
const BASE_OPTIONS: { value: PromptConfig["base"]; label: string; hint: string }[] = [
  {
    value: "optimized",
    label: "Optimized",
    hint: "Designed to get the best out of agents working inside Isolade (recommended).",
  },
  {
    value: "minimal",
    label: "Minimal",
    hint: "Removes almost the entire system prompt, leaving only your own instructions behind.",
  },
  {
    value: "unmodified",
    label: "Unmodified",
    hint: "The default prompt that ships with Claude Code or Codex (not recommended).",
  },
];

// Prompt: which base prompt this profile's agents run on, plus the profile's own
// instructions layered below it. Saved to the `[prompt]` table of config.toml
// (see PromptConfigStore) and assembled per chat by buildSystemPrompt.
export default function PromptTab({ activeProfileId }: { activeProfileId: string | null }) {
  const [saved, setSaved] = useState<PromptConfig | null>(null);
  const [cfg, setCfg] = useState<PromptConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProfileId) return;
    setSaved(null);
    setCfg(null);
    setLoadError(null);
    void (async () => {
      try {
        const c = await getPromptConfig(activeProfileId);
        setSaved(c);
        setCfg(c);
      } catch (e) {
        setLoadError(msg(e));
      }
    })();
  }, [activeProfileId]);

  const dirty = useMemo(
    () => cfg !== null && saved !== null && JSON.stringify(cfg) !== JSON.stringify(saved),
    [cfg, saved],
  );

  const patch = useCallback((fields: Partial<PromptConfig>) => {
    setJustSaved(false);
    setCfg((prev) => (prev ? { ...prev, ...fields } : prev));
  }, []);

  const onSave = useCallback(async () => {
    if (!cfg || !activeProfileId) return;
    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      const result = await setPromptConfig(activeProfileId, cfg);
      setSaved(result);
      setCfg(result);
      setJustSaved(true);
    } catch (e) {
      setSaveError(msg(e));
    } finally {
      setSaving(false);
    }
  }, [cfg, activeProfileId]);

  if (!activeProfileId) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        <p className="text-sm text-muted-foreground">No profile selected.</p>
      </div>
    );
  }

  if (!cfg) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        {loadError ? (
          <p className="text-xs text-destructive max-w-2xl">
            Couldn’t load prompt settings: {loadError}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/60">Loading…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6 space-y-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Prompt</h2>
        <p className="text-xs text-muted-foreground">
          The system prompt every chat in this profile runs on.
        </p>
      </div>

      <div className="max-w-2xl space-y-2">
        <div className="space-y-0.5">
          <span className="text-sm font-medium">Base prompt</span>
          <p className="text-xs text-muted-foreground">
            What agents start from, before your own instructions.
          </p>
        </div>
        {BASE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex items-start gap-3 cursor-pointer select-none"
            title={option.value}
          >
            <input
              type="radio"
              name="prompt-base"
              className="accent-foreground mt-0.5"
              checked={cfg.base === option.value}
              onChange={() => patch({ base: option.value })}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="max-w-2xl space-y-1.5">
        <div className="space-y-0.5">
          <span className="text-sm font-medium">Your instructions</span>
          <p className="text-xs text-muted-foreground">
            Added below the base prompt, and in effect for the whole chat.
          </p>
        </div>
        <Textarea
          value={cfg.prelude}
          placeholder="Standing instructions for every agent in this profile…"
          spellCheck={false}
          onChange={(e) => patch({ prelude: e.target.value })}
          className="min-h-40 text-xs"
        />
      </div>

      {saveError && <p className="text-xs text-destructive max-w-2xl">{saveError}</p>}

      <div className="max-w-2xl flex items-center gap-3">
        <Button size="sm" className="h-8 text-xs" disabled={!dirty || saving} onClick={onSave}>
          {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
          Save changes
        </Button>
        {justSaved && !dirty && (
          <span className="text-xs text-emerald-600 flex items-center gap-1">
            <Check className="size-3.5" /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
