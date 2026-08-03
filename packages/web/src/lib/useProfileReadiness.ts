import { useCallback, useEffect, useState } from "react";
import { getProfile } from "./api";
import type { ProfileSummary } from "./contracts";

// Whether the active profile can actually run a chat, which is not the same
// question as whether it exists.
//
// A profile has to have produced an image before an instance can be created
// from it, and between creating one and that first build finishing there is a
// window — minutes wide on a first install, and exactly the window someone
// lands in by closing guided setup while it builds — where the composer takes a
// message and the server answers "profile <id> has no built image yet". The
// workspace uses this to say what is actually happening instead.
//
// Polls only while the answer can still change: an image, once built, is never
// taken away, so the polling stops the first time one shows up and costs
// nothing for the rest of the session.

const POLL_MS = 2000;

/**
 * The profile to say something about instead of offering a composer, or null
 * when chats can start.
 *
 * The question is the image, deliberately not the status. A profile that has
 * built before keeps its image through a rebuild — `building` while one runs,
 * `error` if it fails — and the server goes on creating instances from that
 * last good image throughout (see `InstanceManager.create`). Refreshing an
 * environment must not stop you starting chats in the one you already have, so
 * only a profile that has never produced an image blocks anything.
 */
export function profileBlockingChats(profile: ProfileSummary | null): ProfileSummary | null {
  return profile && !profile.image ? profile : null;
}

export interface ProfileReadiness {
  /** The profile, once read. Null while unknown, or when it can't be read. */
  profile: ProfileSummary | null;
  /** Re-read now, for a caller that just started a build. */
  refresh: () => void;
}

export function useProfileReadiness(profileId: string | null): ProfileReadiness {
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [tick, setTick] = useState(0);

  // Never leave a stale profile on screen after a switch: the id it describes
  // is no longer the one being asked about.
  useEffect(() => setProfile(null), [profileId]);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      try {
        const next = await getProfile(profileId);
        if (cancelled) return;
        setProfile(next);
        // Done: an image, once built, is never taken away.
        if (next.image) return;
      } catch {
        // A failed read (server restarting, profile deleted under us) changes
        // nothing. Keep polling, since the next one may succeed.
      }
      if (!cancelled) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [profileId, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { profile, refresh };
}
