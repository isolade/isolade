import { AlertTriangle, Check, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  disableSigning,
  getGitConfig,
  listSigningKeys,
  setGitIdentity,
  setSigning,
} from "../lib/api";
import type { GitConfigStatus, SigningKeysResult } from "../lib/contracts";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function shortFp(fp: string | null): string {
  if (!fp) return "unknown fingerprint";
  return fp.length > 28 ? `${fp.slice(0, 28)}…` : fp;
}

export default function GitTab({ activeProfileId }: { activeProfileId: string | null }) {
  const [status, setStatus] = useState<GitConfigStatus | null>(null);
  const [keys, setKeys] = useState<SigningKeysResult | null>(null);

  // Identity section
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [savingId, setSavingId] = useState(false);
  const [savedId, setSavedId] = useState(false);

  // Signing section
  const [socketPath, setSocketPath] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [savingSign, setSavingSign] = useState(false);
  const [savedSign, setSavedSign] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);

  const detectKeys = useCallback(
    async (socket: string) => {
      if (!socket || !activeProfileId) return;
      setDetecting(true);
      setSignError(null);
      try {
        setKeys(await listSigningKeys(activeProfileId, socket));
      } catch (e) {
        setSignError(msg(e));
      } finally {
        setDetecting(false);
      }
    },
    [activeProfileId],
  );

  const refresh = useCallback(async () => {
    if (!activeProfileId) return;
    try {
      const s = await getGitConfig(activeProfileId);
      setStatus(s);
      setLoadError(null);
      // Prefill identity from the configured value, else the host default.
      const id = s.identity ?? s.hostIdentity;
      setName((p) => p || id?.name || "");
      setEmail((p) => p || id?.email || "");
      setSocketPath((p) => p || s.signing.socketPath || "");
      setSelectedKey((p) => p ?? s.signing.key?.pubkey ?? null);
      if (s.signing.socketPath) void detectKeys(s.signing.socketPath);
    } catch (e) {
      setLoadError(msg(e));
    }
  }, [detectKeys, activeProfileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSaveIdentity = useCallback(async () => {
    if (!activeProfileId) return;
    setSavingId(true);
    setIdError(null);
    setSavedId(false);
    try {
      setStatus(await setGitIdentity(activeProfileId, { name, email }));
      setSavedId(true);
    } catch (e) {
      setIdError(msg(e));
    } finally {
      setSavingId(false);
    }
  }, [name, email, activeProfileId]);

  const canSaveSigning = Boolean(socketPath && selectedKey) && !savingSign;
  const selectedInfo = keys?.keys.find((k) => k.pubkey === selectedKey) ?? null;

  const onSaveSigning = useCallback(async () => {
    if (!activeProfileId) return;
    if (!selectedKey) {
      setSignError("Pick a signing key first.");
      return;
    }
    setSavingSign(true);
    setSignError(null);
    setSavedSign(false);
    try {
      setStatus(
        await setSigning(activeProfileId, {
          enabled: true,
          socketPath,
          signingKey: selectedKey,
        }),
      );
      setSavedSign(true);
    } catch (e) {
      setSignError(msg(e));
    } finally {
      setSavingSign(false);
    }
  }, [selectedKey, socketPath, activeProfileId]);

  const onDisableSigning = useCallback(async () => {
    if (!activeProfileId) return;
    setSavingSign(true);
    setSignError(null);
    setSavedSign(false);
    try {
      setStatus(await disableSigning(activeProfileId));
    } catch (e) {
      setSignError(msg(e));
    } finally {
      setSavingSign(false);
    }
  }, [activeProfileId]);

  const usingHostIdentity = !status?.identity && !!status?.hostIdentity;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Git</h2>
        <p className="text-xs text-muted-foreground">
          Configure how agents commit. The committer identity applies to every agent commit. Signing
          is optional and goes through your SSH agent (e.g. Secretive), and the private key never
          enters the VM.
        </p>
      </div>

      {loadError && (
        <p className="text-xs text-destructive max-w-2xl">Couldn’t load status: {loadError}</p>
      )}

      {/* Committer identity */}
      <div className="max-w-2xl rounded-lg border border-border p-4 space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">Committer identity</h3>
          <p className="text-xs text-muted-foreground">
            Used as <code>user.name</code> / <code>user.email</code> in every agent VM.
            {usingHostIdentity && " Defaulted from your host git config. Edit to override."}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="git-name" className="text-xs font-medium">
              Name
            </label>
            <Input
              id="git-name"
              className="h-8"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="git-email" className="text-xs font-medium">
              Email
            </label>
            <Input
              id="git-email"
              className="h-8"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
            />
          </div>
        </div>
        {idError && <p className="text-xs text-destructive">{idError}</p>}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!name || !email || savingId}
            onClick={onSaveIdentity}
          >
            {savingId && <Loader2 className="size-3.5 animate-spin mr-1" />}
            Save identity
          </Button>
          {savedId && (
            <span className="text-xs text-emerald-600 flex items-center gap-1">
              <Check className="size-3.5" /> Saved
            </span>
          )}
        </div>
      </div>

      {/* Commit signing */}
      <div className="max-w-2xl rounded-lg border border-border p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            {status?.signing.enabled ? (
              <>
                <ShieldCheck className="size-4 text-emerald-500" /> Commit signing on
              </>
            ) : (
              "Commit signing"
            )}
          </h3>
          {status?.signing.enabled && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              disabled={savingSign}
              onClick={onDisableSigning}
            >
              Disable
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          Pick a <span className="font-medium">dedicated</span> key, not your personal one, and opt
          each workspace in with a <code>[signing]</code> block (<code>enabled = true</code>) in its{" "}
          <code>config.toml</code>.
        </p>

        {status && status.signing.configured && !status.signing.agentReachable && (
          <p className="text-xs text-amber-500 flex items-center gap-1.5">
            <AlertTriangle className="size-3.5" />
            Agent not reachable
            {status.signing.socketPath ? ` at ${status.signing.socketPath}` : ""}. Opted-in
            workspaces fall back to unsigned commits until it’s available.
          </p>
        )}

        <div className="space-y-1.5">
          <label htmlFor="ssh-agent-socket" className="text-xs font-medium">
            SSH agent socket
          </label>
          <div className="flex gap-2">
            <Input
              id="ssh-agent-socket"
              className="h-8"
              value={socketPath}
              placeholder="$SSH_AUTH_SOCK (e.g. Secretive’s socket)"
              onChange={(e) => setSocketPath(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs shrink-0"
              disabled={!socketPath || detecting}
              onClick={() => detectKeys(socketPath)}
            >
              {detecting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Detect keys
            </Button>
          </div>
          {status && status.signing.detectedSockets.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[11px] text-muted-foreground">Detected:</span>
              {status.signing.detectedSockets.map((s) => (
                <button
                  key={s.path}
                  type="button"
                  title={s.path}
                  onClick={() => {
                    setSocketPath(s.path);
                    void detectKeys(s.path);
                  }}
                  className={`text-[11px] rounded px-2 py-0.5 border ${
                    socketPath === s.path
                      ? "border-foreground/40 bg-muted"
                      : "border-border text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div id="signing-key-label" className="text-xs font-medium">
            Signing key
          </div>
          {keys && !keys.reachable && (
            <p className="text-xs text-amber-500 flex items-center gap-1.5">
              <AlertTriangle className="size-3.5" /> Couldn’t reach the agent at this socket.
            </p>
          )}
          {keys && keys.reachable && keys.keys.length === 0 && (
            <p className="text-xs text-muted-foreground">
              The agent holds no keys. Load one into it first.
            </p>
          )}
          <div className="space-y-1.5" role="radiogroup" aria-labelledby="signing-key-label">
            {keys?.keys.map((k) => (
              <label
                key={k.pubkey}
                className="flex items-start gap-2.5 rounded-md border border-border p-2.5 cursor-pointer hover:bg-muted/40"
              >
                <input
                  type="radio"
                  name="signing-key"
                  className="mt-0.5 accent-foreground"
                  checked={selectedKey === k.pubkey}
                  onChange={() => setSelectedKey(k.pubkey)}
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm flex items-center gap-1.5">
                    <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                    {k.comment || "(no comment)"}
                    {k.isHostSigningKey && (
                      <span className="text-[10px] rounded bg-amber-500/15 text-amber-600 px-1 py-0.5">
                        your personal key
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground break-all">
                    {shortFp(k.fingerprint)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {selectedInfo?.isHostSigningKey && (
            <p className="text-xs text-amber-500 flex items-center gap-1.5">
              <AlertTriangle className="size-3.5" />
              This is your personal git signing key. Prefer a separate, revocable agent key so agent
              commits stay distinct from yours.
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Signed commits are recorded with the committer identity above, so use an email verified on
          your GitHub account so they show “Verified”.
        </p>

        {signError && <p className="text-xs text-destructive">{signError}</p>}

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!canSaveSigning}
            onClick={onSaveSigning}
          >
            {savingSign && <Loader2 className="size-3.5 animate-spin mr-1" />}
            {status?.signing.enabled ? "Save changes" : "Enable signing"}
          </Button>
          {savedSign && (
            <span className="text-xs text-emerald-600 flex items-center gap-1">
              <Check className="size-3.5" /> Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
