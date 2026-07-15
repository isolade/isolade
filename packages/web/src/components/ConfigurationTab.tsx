import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getProfileConfig } from "../lib/api";
import type { ProfileConfigView } from "../lib/contracts";
import ProfileConfigForm, { BLANK_FORM } from "./ProfileConfigForm";

// Configuration: the structured editor for a profile's build definition, saved
// to config.toml. A profile IS the build unit (one image), so this acts on the
// active profile; changes take effect on the next build, which is kicked off
// from the Build section.
export default function ConfigurationTab({ activeProfileId }: { activeProfileId: string | null }) {
  const [view, setView] = useState<ProfileConfigView | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!activeProfileId) {
      setView(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setView(await getProfileConfig(activeProfileId));
    } catch {
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [activeProfileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Configuration</h2>
        <p className="text-xs text-muted-foreground">
          The profile's build definition — source repos, the Dockerfile path, and agent-layer skills
          — saved to <code>config.toml</code>. Ports live in Network, caches and lifecycle commands
          in Runtime. Rebuild from the Build section to apply.
        </p>
      </div>

      {!activeProfileId ? (
        <p className="text-sm text-muted-foreground">No profile selected.</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : view?.form ? (
        <ProfileConfigForm profileId={activeProfileId} initial={view.form} onSaved={setView} />
      ) : view?.parseError ? (
        <ParseErrorNotice error={view.parseError} />
      ) : (
        <>
          <p className="max-w-2xl text-xs text-muted-foreground">
            This profile has no build definition yet. Fill it in below and save to make the profile
            buildable.
          </p>
          <ProfileConfigForm profileId={activeProfileId} initial={BLANK_FORM} onSaved={setView} />
        </>
      )}
    </div>
  );
}

function ParseErrorNotice({ error }: { error: string }) {
  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
        <AlertTriangle className="size-4 mt-0.5 shrink-0 text-destructive" />
        <div className="space-y-1 min-w-0">
          <p className="text-sm font-medium text-destructive">config.toml can't be parsed</p>
          <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{error}</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The form is unavailable until the file parses. Fix <code>config.toml</code> directly, then
        reopen this section.
      </p>
    </div>
  );
}
