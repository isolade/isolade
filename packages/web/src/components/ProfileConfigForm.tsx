import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setProfileConfigForm } from "../lib/api";
import type { ProfileConfigForm as ConfigForm, ProfileConfigView } from "../lib/contracts";
import { Field, StringRows } from "./profile-form-controls";

// A blank definition for a profile that has no config.toml yet: one empty repo
// row and the conventional Dockerfile path, ready to fill in and save.
export const BLANK_FORM: ConfigForm = {
  repos: [{ name: "", source: "" }],
  dockerfile: "./Dockerfile",
  skills: [],
};

// The structured config.toml editor for a profile's build definition: the image
// inputs (source repos, the Dockerfile path, and the agent-layer skills). The
// per-instance runtime, network, chat prelude, and secrets each have their own
// section. Holds a local draft, saves the whole form through the
// comment-preserving server writer, and reports the fresh view up so the
// Configuration section re-syncs.
export default function ProfileConfigForm({
  profileId,
  initial,
  onSaved,
}: {
  profileId: string;
  initial: ConfigForm;
  onSaved: (view: ProfileConfigView) => void;
}) {
  const [draft, setDraft] = useState<ConfigForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-seed only when the upstream definition genuinely changes (profile
  // switch / raw or external save). The echo of our own save (the server
  // returning exactly what we sent) keeps the draft and the "Saved" note.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (JSON.stringify(initial) === JSON.stringify(draftRef.current)) return;
    setDraft(initial);
    setError(null);
    setSavedAt(null);
  }, [initial]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const patch = (p: Partial<ConfigForm>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const view = await setProfileConfigForm(profileId, draft);
      setSavedAt(Date.now());
      onSaved(view);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const setRepo = (i: number, p: Partial<ConfigForm["repos"][number]>) =>
    patch({ repos: draft.repos.map((r, j) => (j === i ? { ...r, ...p } : r)) });

  return (
    <div className="max-w-2xl space-y-6">
      {/* Repos */}
      <Field
        label="Repositories"
        description="Each becomes the BuildKit context your Dockerfile COPYs from. Optional — leave empty for a Dockerfile-only environment."
      >
        <div className="space-y-2">
          {draft.repos.map((repo, i) => (
            <div key={i} className="rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={repo.name}
                  placeholder="name (e.g. app)"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => setRepo(i, { name: e.target.value })}
                  className="h-8 text-xs font-mono w-48"
                />
                <span className="flex-1" />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="Remove repo"
                  onClick={() => patch({ repos: draft.repos.filter((_, j) => j !== i) })}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Input
                value={repo.source}
                placeholder="github.com/owner/repo, file:///abs/path, or a local path"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setRepo(i, { source: e.target.value })}
                className="h-8 text-xs font-mono"
              />
              <Input
                value={repo.branch ?? ""}
                placeholder="branch (optional; git sources only)"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setRepo(i, { branch: e.target.value || undefined })}
                className="h-8 text-xs font-mono"
              />
            </div>
          ))}
          <Button
            size="xs"
            variant="secondary"
            onClick={() => patch({ repos: [...draft.repos, { name: "", source: "" }] })}
          >
            <Plus className="size-3.5" /> Add repository
          </Button>
        </div>
      </Field>

      <Field
        label="Dockerfile path"
        description="Resolved relative to the profile directory. Its contents are edited on the Dockerfile tab."
      >
        <Input
          value={draft.dockerfile}
          placeholder="./Dockerfile"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => patch({ dockerfile: e.target.value })}
          className="h-8 text-xs font-mono w-72"
        />
      </Field>

      <Field
        label="Skills"
        description={
          <>
            Skill packages installed into the agent layer via <code>npx skills add</code> (e.g.{" "}
            <code>owner/repo</code>).
          </>
        }
      >
        <StringRows
          value={draft.skills}
          onChange={(skills) => patch({ skills })}
          placeholder="owner/skills"
          addLabel="Add skill"
        />
      </Field>

      {error && <p className="text-xs text-destructive whitespace-pre-wrap">{error}</p>}

      <div className="flex items-center gap-3 sticky bottom-0 bg-background/95 py-3 -mx-1 px-1 border-t border-border">
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save configuration"}
        </Button>
        {dirty && !saving && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(initial)}>
            Reset
          </Button>
        )}
        {!dirty && savedAt && (
          <span className="text-xs text-muted-foreground">Saved. Rebuild the image to apply.</span>
        )}
      </div>
    </div>
  );
}
