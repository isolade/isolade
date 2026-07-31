import { useCallback, useEffect, useState } from "react";
import { getUpdateStatus } from "./api";
import type { UpdateStatus } from "./contracts";

/**
 * Where the UI sends someone with an update waiting. The instructions rather than
 * the artifact, on purpose: how to update differs per platform (apt upgrades the
 * package, a tarball install replaces /opt/isolade), and on macOS a bundle
 * downloaded through a browser is quarantined and refuses to launch, so offering
 * the asset walks the user into the one route the docs tell them to avoid.
 * Updating is the same one-liner as installing, so the page covers both.
 */
export const HOW_TO_UPDATE = "https://isolade.com/docs/installation#updating";

/**
 * Update status for the UI. Fetches the warm/cached status once on mount (which
 * doesn't count), and exposes `recheck()` for the manual "Check for updates"
 * button, which forces a fresh check. Shared by the title-bar banner and the
 * About pane so the API interaction lives in one place.
 */
export function useUpdateStatus(): {
  status: UpdateStatus | null;
  checking: boolean;
  recheck: () => Promise<void>;
} {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getUpdateStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // Offline or no endpoint, so leave status null.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await getUpdateStatus(true));
    } catch {
      // Keep the previous status on failure.
    } finally {
      setChecking(false);
    }
  }, []);

  return { status, checking, recheck };
}
