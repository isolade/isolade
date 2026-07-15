import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getPromptConfig, setPromptConfig } from "../lib/api";
import type { PromptConfig } from "../lib/contracts";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Prompt: the profile's chat augmentation. Its one field, the prelude, is
// prepended (invisibly) to the first user message of every new chat in this
// profile. Saved to the `[prompt]` table of config.toml (see PromptConfigStore).
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

  const setPrelude = useCallback((prelude: string) => {
    setJustSaved(false);
    setCfg({ prelude });
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
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <p className="text-sm text-muted-foreground">No profile selected.</p>
      </div>
    );
  }

  if (!cfg) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
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
    <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Prompt</h2>
        <p className="text-xs text-muted-foreground">
          Context prepended (invisibly) to the first message of every new chat in this profile. Your
          message is stored as you typed it; only what's sent to the agent is augmented.
        </p>
      </div>

      <div className="max-w-2xl space-y-1.5">
        <span className="text-sm font-medium">Prelude</span>
        <Textarea
          value={cfg.prelude}
          placeholder="Optional context prepended to the first chat message…"
          spellCheck={false}
          onChange={(e) => setPrelude(e.target.value)}
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
