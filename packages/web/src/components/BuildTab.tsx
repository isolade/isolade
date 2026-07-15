import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { API_BASE, getProfile, rebuildProfile, withAuthToken } from "../lib/api";
import type { ProfileSummary } from "../lib/contracts";

function statusDot(status: ProfileSummary["status"]) {
  if (status === "ready") return "bg-emerald-500";
  if (status === "building") return "bg-amber-500 animate-pulse";
  if (status === "pending") return "bg-muted-foreground";
  return "bg-destructive";
}

// Build: the profile's build status and streamed logs, plus the Rebuild control
// (the one place a build is kicked off). A profile IS the build unit (one
// image), so this acts on the active profile.
export default function BuildTab({ activeProfileId }: { activeProfileId: string | null }) {
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!activeProfileId) {
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      setProfile(await getProfile(activeProfileId));
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [activeProfileId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const building = profile?.status === "building";
  const [rebuildKey, setRebuildKey] = useState(0);

  const rebuild = async () => {
    if (!activeProfileId) return;
    await rebuildProfile(activeProfileId);
    setRebuildKey((k) => k + 1);
    await refresh();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No profile selected.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("w-2 h-2 rounded-full", statusDot(profile.status))} />
            <span className="font-medium truncate">{profile.name}</span>
            <span className="text-xs text-muted-foreground capitalize">{profile.status}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">{profile.configPath}</div>
          {profile.status === "error" && profile.errorMessage && (
            <div className="text-xs text-destructive mt-1 line-clamp-2">{profile.errorMessage}</div>
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void rebuild()}
          disabled={building || !profile.hasConfig}
        >
          {profile.status === "pending" ? "Build" : "Rebuild"}
        </Button>
      </header>

      <div className="flex-1 min-h-0">
        <BuildLogs
          profileId={profile.id}
          building={building}
          runKey={rebuildKey}
          onDone={() => void refresh()}
        />
      </div>
    </div>
  );
}

// Streams the build log. The same endpoint replays a finished build's persisted
// log (then `done`) and follows a live one, so we connect regardless of state.
// `runKey` bumps to reconnect after a rebuild is kicked off.
function BuildLogs({
  profileId,
  building,
  runKey,
  onDone,
}: {
  profileId: string;
  building: boolean;
  runKey: number;
  onDone: () => void;
}) {
  const [logs, setLogs] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  // The `done` listener must see the *current* build state, not the one
  // captured when the stream connected: after a rebuild kicks off, the
  // connection outlives the refresh that flips the profile to "building".
  const buildingRef = useRef(building);
  buildingRef.current = building;

  useEffect(() => {
    setLogs([]);
    // EventSource can't set an Authorization header, so the token rides on the URL.
    const es = new EventSource(withAuthToken(`${API_BASE}/api/profiles/${profileId}/logs`));
    es.addEventListener("log", (e: MessageEvent) => setLogs((prev) => [...prev, e.data]));
    es.addEventListener("done", () => {
      if (buildingRef.current) onDone();
      es.close();
    });
    es.onerror = () => es.close();
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, runKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="h-full overflow-y-auto bg-background p-4 font-mono text-xs">
      {logs.length === 0 ? (
        <span className="text-muted-foreground/60">
          {building ? "Waiting for output…" : "Build logs appear here while building."}
        </span>
      ) : (
        logs.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap leading-5 text-foreground/80">
            {line}
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
