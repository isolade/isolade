import { Check, ExternalLink, Loader2, LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cancelLogin, getAuthStatus, getLoginStatus, logoutProvider, startLogin } from "../lib/api";
import type { AuthProvider, AuthStatus, LoginSession, ProviderAuthStatus } from "../lib/contracts";
import { onExternalLinkClick, openExternal } from "../lib/tauri";

const PROVIDERS: { id: AuthProvider; label: string; blurb: string }[] = [
  {
    id: "claude",
    label: "Claude",
    blurb: "Anthropic subscription (Claude Code)",
  },
  { id: "codex", label: "Codex", blurb: "OpenAI ChatGPT (Codex)" },
];

function expiryLabel(s: ProviderAuthStatus): string {
  if (!s.loggedIn) return "Not signed in";
  if (s.expiresAt == null) return "Signed in";
  const mins = Math.round((s.expiresAt - Date.now()) / 60000);
  if (mins <= 0) return "Signed in · token expired (will refresh)";
  if (mins < 90) return `Signed in · token valid ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Signed in · token valid ${hours}h`;
  return `Signed in · token valid ${Math.round(hours / 24)}d`;
}

export default function ProvidersTab({ activeProfileId }: { activeProfileId: string | null }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // At most one login is in flight at a time.
  const [session, setSession] = useState<LoginSession | null>(null);
  const [busy, setBusy] = useState<AuthProvider | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!activeProfileId) return;
    try {
      setStatus(await getAuthStatus(activeProfileId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [activeProfileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const beginLogin = useCallback(
    async (provider: AuthProvider) => {
      if (!activeProfileId) return;
      setActionError(null);
      setBusy(provider);
      try {
        const s = await startLogin(provider, activeProfileId);
        setSession(s);
        // Open the authorize URL in the system browser. In the Tauri app this
        // routes through the native host. window.open wouldn't reach a real
        // browser there (see lib/tauri.ts).
        if (s.url) void openExternal(s.url);
        stopPolling();
        pollRef.current = setInterval(async () => {
          try {
            const next = await getLoginStatus(s.sessionId);
            setSession(next);
            if (next.state === "completed") {
              stopPolling();
              setSession(null);
              await refresh();
            } else if (next.state === "error") {
              stopPolling();
              setActionError(next.error ?? "Login failed");
              setSession(null);
            }
          } catch (err) {
            stopPolling();
            setActionError(err instanceof Error ? err.message : String(err));
            setSession(null);
          }
        }, 2000);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh, stopPolling, activeProfileId],
  );

  const onCancel = useCallback(async () => {
    stopPolling();
    if (session) await cancelLogin(session.sessionId);
    setSession(null);
  }, [session, stopPolling]);

  const onLogout = useCallback(
    async (provider: AuthProvider) => {
      if (!activeProfileId) return;
      setBusy(provider);
      setActionError(null);
      try {
        await logoutProvider(provider, activeProfileId);
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh, activeProfileId],
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Agent providers</h2>
        <p className="text-xs text-muted-foreground">
          Sign in to Claude and Codex once here. Credentials are stored by isolade and injected into
          every agent VM, with no need to install or log into the CLIs on this machine.
        </p>
      </div>

      {loadError && (
        <p className="text-xs text-destructive max-w-2xl">Couldn’t load status: {loadError}</p>
      )}
      {actionError && <p className="text-xs text-destructive max-w-2xl">{actionError}</p>}

      <div className="max-w-2xl space-y-3">
        {PROVIDERS.map((p) => {
          const st = status?.[p.id];
          const active = session?.provider === p.id ? session : null;
          const isBusy = busy === p.id;
          return (
            <div key={p.id} className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium flex items-center gap-1.5">
                    {p.label}
                    {st?.loggedIn && <Check className="size-3.5 text-emerald-500" />}
                  </span>
                  <span className="text-xs text-muted-foreground">{p.blurb}</span>
                  <span className="text-xs text-muted-foreground">
                    {st ? expiryLabel(st) : "…"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {st?.loggedIn && !active && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs text-muted-foreground"
                      disabled={isBusy}
                      onClick={() => onLogout(p.id)}
                    >
                      <LogOut className="size-3.5" />
                      Sign out
                    </Button>
                  )}
                  {!active && (
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={isBusy || (!!session && session.provider !== p.id)}
                      onClick={() => beginLogin(p.id)}
                    >
                      {isBusy && <Loader2 className="size-3.5 animate-spin mr-1" />}
                      {st?.loggedIn ? "Re-sign in" : "Sign in"}
                    </Button>
                  )}
                </div>
              </div>

              {active && (
                <div className="rounded-md bg-muted/50 p-3 space-y-2 text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Open the link and sign in, and this completes automatically.
                  </div>
                  {active.url && (
                    <a
                      href={active.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline break-all"
                      onClick={(e) => onExternalLinkClick(e, active.url)}
                    >
                      <ExternalLink className="size-3.5 shrink-0" />
                      {active.url}
                    </a>
                  )}
                  <button
                    className="text-muted-foreground hover:text-foreground underline"
                    onClick={onCancel}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
