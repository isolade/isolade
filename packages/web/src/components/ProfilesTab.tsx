import { Check, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { getStoredProfileId, setStoredProfileId } from "../lib/activeProfile";
import {
  cloneProfile,
  createProfile,
  deleteProfile,
  listProfiles,
  renameProfile,
} from "../lib/api";
import type { ProfileSummary } from "../lib/contracts";

// A profile bundles auth, appearance, git identity, network policy, secrets and
// its environment(s). Switching the active profile re-skins the whole app, so a
// switch reloads the webview, and the boot path re-reads everything for the new
// profile.
export default function ProfilesTab({ activeProfileId }: { activeProfileId: string | null }) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(activeProfileId);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ProfileSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProfiles(await listProfiles());
    setActiveId(getStoredProfileId());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Switching re-skins everything (auth, appearance, instance list) for THIS
  // window. The active profile is a per-window client concern (sessionStorage),
  // so we store it and reload, and the boot path re-reads everything for it.
  const switchTo = (id: string) => {
    setStoredProfileId(id);
    window.location.reload();
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6 space-y-6">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Profiles</h2>
        <p className="text-xs text-muted-foreground">
          Each profile has its own Claude/Codex sign-in, appearance, git identity, network policy,
          secrets, and environment. Switching profiles re-skins the entire app.
        </p>
      </div>

      {error && <p className="max-w-2xl text-xs text-destructive">{error}</p>}

      <ScrollArea className="max-w-2xl rounded-lg border border-border">
        {profiles.map((p) => {
          const isActive = p.id === activeId;
          return (
            <div
              key={p.id}
              className="flex items-center gap-2 px-3 py-2.5 border-b border-border last:border-b-0"
            >
              <span
                className={cn(
                  "w-2 h-2 rounded-full flex-shrink-0",
                  isActive ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
              />
              {editingId === p.id ? (
                <form
                  className="flex-1 flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = editName.trim();
                    if (name)
                      void run(() => renameProfile(p.id, name)).then(() => setEditingId(null));
                  }}
                >
                  <Input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-7"
                  />
                  <Button type="submit" size="xs" disabled={busy}>
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="flex-1 text-sm truncate">
                    {p.name}
                    {isActive && (
                      <span className="ml-2 text-xs text-muted-foreground">(active)</span>
                    )}
                  </span>
                  {!isActive && (
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void switchTo(p.id)}
                    >
                      <Check className="size-3.5" />
                      Use
                    </Button>
                  )}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title="Rename"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(p.id);
                      setEditName(p.name);
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title="Clone"
                    disabled={busy}
                    onClick={() => void run(() => cloneProfile(p.id, `${p.name} copy`))}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title="Delete"
                    disabled={busy || profiles.length <= 1}
                    onClick={() => setPendingDelete(p)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </div>
          );
        })}
        {profiles.length === 0 && (
          <p className="px-3 py-3 text-muted-foreground text-xs">No profiles yet.</p>
        )}
      </ScrollArea>

      <form
        className="max-w-2xl flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newName.trim();
          if (name) void run(() => createProfile(name)).then(() => setNewName(""));
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New profile name…"
          className="h-8"
        />
        <Button type="submit" size="sm" disabled={busy || !newName.trim()}>
          <Plus className="size-3.5" />
          Create
        </Button>
      </form>
      <p className="max-w-2xl text-xs text-muted-foreground">
        A new profile starts empty and signed-out. Clone an existing profile to copy its environment
        and appearance (sign-in and secrets are never copied).
      </p>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={`Delete profile "${pendingDelete?.name ?? ""}"?`}
        description="Its environments and stored secrets are removed. This cannot be undone."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => {
          const target = pendingDelete;
          if (!target) return;
          void run(() => deleteProfile(target.id)).then(() => setPendingDelete(null));
        }}
      />
    </div>
  );
}
