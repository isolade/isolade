import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getProfileConfig, setDockerfile } from "../lib/api";
import type { ProfileConfigView } from "../lib/contracts";
import { CodeEditor } from "./CodeEditor";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Dockerfile: the highlighted editor for the profile's image recipe. Saving
// writes the file to disk; the image itself is rebuilt from the Build section.
export default function DockerfileTab({ activeProfileId }: { activeProfileId: string | null }) {
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

  // Local editor draft over the server's copy. The reseed effect only discards
  // the draft when upstream content genuinely changed, so the echo of our own
  // save (value becomes exactly what we sent) keeps the draft and "Saved" note.
  const value = view?.dockerfile ?? "";
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (value === draftRef.current) return;
    setDraft(value);
    setError(null);
    setSavedAt(null);
  }, [value]);

  const dirty = draft !== value;
  const save = async () => {
    if (!activeProfileId) return;
    setSaving(true);
    setError(null);
    try {
      await setDockerfile(activeProfileId, draft);
      setView((v) => (v ? { ...v, dockerfile: draft } : v));
      setSavedAt(Date.now());
    } catch (e) {
      setError(msg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-w-0 p-6 gap-3">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Dockerfile</h2>
        <p className="text-xs text-muted-foreground truncate">
          The image recipe built for this profile. {view?.dockerfilePath}
        </p>
      </div>

      {!activeProfileId ? (
        <p className="text-sm text-muted-foreground">No profile selected.</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <CodeEditor
            value={draft}
            onChange={setDraft}
            language="dockerfile"
            ariaLabel="Dockerfile"
            placeholder="FROM ubuntu:24.04…"
            className="flex-1 min-h-64"
          />
          {error && <p className="text-xs text-destructive whitespace-pre-wrap">{error}</p>}
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save Dockerfile"}
            </Button>
            {!dirty && savedAt && (
              <span className="text-xs text-muted-foreground">
                Saved. Rebuild the image to apply.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
