import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getPromptConfig, setPromptConfig } from "../lib/api";
import type { PromptConfig } from "../lib/contracts";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Ordered best-default-first. Each hint has to stand on its own: it is the only
// explanation an option gets, so anything true of just that choice belongs here
// rather than in a separate note the reader has to connect back up.
const BASE_OPTIONS: {
  value: PromptConfig["base"];
  label: string;
  hint: string;
  /** How the instructions below relate to this base. */
  preludeNote: string;
}[] = [
  {
    value: "isolade",
    label: "Optimized",
    hint: "Written for the sandbox: what agents may do without asking, which model they are running, how to attribute commits.",
    preludeNote:
      "Added below the base prompt, and taking precedence over it wherever the two disagree.",
  },
  {
    value: "cli",
    label: "Agent default",
    hint: "Whatever prompt Claude Code or Codex ships with, untouched. Longer, and written for someone working on their own machine.",
    preludeNote: "Added below the base prompt.",
  },
  {
    value: "minimal",
    label: "Minimal",
    hint: "Almost nothing: your instructions below are the prompt. Codex chats also keep a short note about its patch format, without which its edits can land in the wrong place.",
    preludeNote: "These are the whole prompt.",
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
          The system prompt every agent in this profile runs on: a base prompt, then your own
          instructions on top.
        </p>
      </div>

      <div className="max-w-2xl space-y-2">
        <span className="text-sm font-medium">Base prompt</span>
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
        <span className="text-sm font-medium">Your instructions</span>
        <Textarea
          value={cfg.prelude}
          placeholder="Standing instructions for every agent in this profile…"
          spellCheck={false}
          onChange={(e) => patch({ prelude: e.target.value })}
          className="min-h-40 text-xs"
        />
        <p className="text-xs text-muted-foreground">
          {BASE_OPTIONS.find((option) => option.value === cfg.base)?.preludeNote}
        </p>
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
