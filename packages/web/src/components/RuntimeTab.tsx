import { Check, Info, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { getRuntimeConfig, setRuntimeConfig } from "../lib/api";
import type { RuntimeConfig } from "../lib/contracts";
import { Field, PhaseEditor, StringRows } from "./profile-form-controls";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Runtime: the per-instance posture applied when the profile's VMs boot —
// host-backed cache mounts and the setup/start lifecycle commands. Saved to the
// `[runtime]` table of the profile's config.toml (see RuntimeConfigStore). This
// is the runtime counterpart to the Configuration section's build definition.
export default function RuntimeTab({ activeProfileId }: { activeProfileId: string | null }) {
  // `saved` is the last-persisted config, `cfg` the working copy. Dirty when
  // they differ. Both null until the initial load resolves.
  const [saved, setSaved] = useState<RuntimeConfig | null>(null);
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
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
        const c = await getRuntimeConfig(activeProfileId);
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

  // Any edit clears the transient "Saved" tick so it doesn't linger over a
  // now-stale state.
  const patch = useCallback((next: Partial<RuntimeConfig>) => {
    setJustSaved(false);
    setCfg((prev) => (prev ? { ...prev, ...next } : prev));
  }, []);

  const onSave = useCallback(async () => {
    if (!cfg || !activeProfileId) return;
    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      const result = await setRuntimeConfig(activeProfileId, cfg);
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
            Couldn’t load runtime settings: {loadError}
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
        <h2 className="text-sm font-medium">Runtime</h2>
        <p className="text-xs text-muted-foreground">
          What happens inside the instance VM: host-backed caches and the commands run on setup and
          on every boot. Distinct from the build definition in Configuration.
        </p>
      </div>

      <div className="max-w-2xl flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3">
        <Info className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Changes apply to <span className="font-medium">newly created instances</span>. Restart an
          instance to re-run <code>start</code>; <code>setup</code> runs only on first create.
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        <Field
          label="Caches"
          description={
            <>
              Host-backed bind mounts, preserved across rebuilds. Must start with <code>~/</code> or{" "}
              <code>$HOME/</code>.
            </>
          }
        >
          <StringRows
            value={cfg.caches}
            onChange={(caches) => patch({ caches })}
            placeholder="~/.cache/ccache"
            addLabel="Add cache"
          />
        </Field>

        <Field
          label="Setup"
          description="Provisioning commands run once, the first time the instance VM is created."
        >
          <PhaseEditor value={cfg.setup} onChange={(setup) => patch({ setup })} />
        </Field>

        <Field
          label="Start"
          description="Commands run on every VM boot (create and restart): daemons, dev servers."
        >
          <PhaseEditor value={cfg.start} onChange={(start) => patch({ start })} />
        </Field>
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
