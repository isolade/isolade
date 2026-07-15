import { useCallback, useEffect, useState } from "react";
import { getUpdateStatus } from "./api";
import type { UpdateStatus } from "./contracts";

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
