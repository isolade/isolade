import { Check, Info, KeyRound, Loader2, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  clearProfileSecret,
  getProfile,
  listProfileSecrets,
  setProfileSecret,
  setSecretDeclarations,
} from "../lib/api";
import type { ProfileSecret, SecretDeclaration, SecretInjectMode } from "../lib/contracts";

// Trim a user-typed host down to a bare host[:port] / wildcard pattern: drop
// scheme and path, lowercase, but keep any `*` (the sandbox routes hosts
// containing `*` to microsandbox's `allowHostPattern`). Returns "" when there's
// nothing usable left.
function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (!h) return "";
  h = h.replace(/^[a-z]+:\/\//, ""); // scheme
  h = h.split("/")[0] ?? ""; // path
  return h.trim();
}

const parseHosts = (raw: string): string[] => {
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const h = normalizeHost(part);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
};

// Copy for each injection mode, shown under the per-secret selector.
const INJECT_LABELS: Record<SecretInjectMode, string> = {
  headers: "Request headers (secretless)",
  full: "Whole request (secretless)",
  env: "VM environment variable",
};
const INJECT_DESCRIPTIONS: Record<SecretInjectMode, string> = {
  headers:
    "The proxy substitutes the value into request headers (and the Basic-Auth credential) for the allowed hosts. The real value never enters the VM.",
  full: "The proxy substitutes the value anywhere in the request (headers, query string, and body) for the allowed hosts. The real value never enters the VM.",
  env: "The real value is set as an environment variable inside the VM. No proxy, no host scoping, so any process in the VM can read it.",
};

// Secrets for the active profile. Two layers:
//   - declarations (env var name, injection mode, and, for the proxy modes,
//     host scoping) live in the profile's config.toml. This tab can add / edit /
//     remove them, writing config back via the replace-all declarations endpoint.
//   - values live in a per-profile file on the server, scoped to the profile,
//     write-only.
export default function SecretsTab({ activeProfileId }: { activeProfileId: string | null }) {
  const [hasConfig, setHasConfig] = useState<boolean | null>(null);
  const [secrets, setSecrets] = useState<ProfileSecret[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // value drafts
  const [hostInputs, setHostInputs] = useState<Record<string, string>>({}); // add-host inputs
  const [busy, setBusy] = useState<Record<string, boolean>>({}); // per-secret value ops
  const [savingDecls, setSavingDecls] = useState(false);
  const [newEnv, setNewEnv] = useState("");
  const [newHosts, setNewHosts] = useState("");
  // A proxy mode picked for an env-injected secret can't be saved until it has a
  // host, so we stash the intended mode and commit it when the first host lands.
  const [pendingInject, setPendingInject] = useState<Record<string, SecretInjectMode>>({});

  const refresh = useCallback(async () => {
    if (!activeProfileId) {
      setHasConfig(null);
      setSecrets(null);
      return;
    }
    setError(null);
    try {
      const profile = await getProfile(activeProfileId);
      setHasConfig(profile.hasConfig);
      setSecrets(profile.hasConfig ? await listProfileSecrets(activeProfileId) : []);
    } catch (err) {
      setHasConfig(false);
      setSecrets([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeProfileId]);

  useEffect(() => {
    setDrafts({});
    setHostInputs({});
    void refresh();
  }, [refresh]);

  const declarationsFrom = (list: ProfileSecret[]): SecretDeclaration[] =>
    list.map((s) => ({ env: s.env, hosts: s.hosts, inject: s.inject }));

  // Replace-all write of the declaration set. On success the server returns the
  // canonical list (re-parsed from config.toml), which becomes our state.
  const applyDeclarations = async (next: SecretDeclaration[]): Promise<boolean> => {
    if (!activeProfileId) return false;
    setSavingDecls(true);
    setError(null);
    try {
      setSecrets(await setSecretDeclarations(activeProfileId, next));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSavingDecls(false);
    }
  };

  // Edit one secret's declaration in place, leaving the others untouched.
  const patchSecret = (env: string, patch: Partial<SecretDeclaration>): Promise<boolean> => {
    if (!secrets) return Promise.resolve(false);
    return applyDeclarations(
      declarationsFrom(secrets).map((d) => (d.env === env ? { ...d, ...patch } : d)),
    );
  };

  const addSecret = async () => {
    const env = newEnv.trim();
    const hosts = parseHosts(newHosts);
    if (!env || !secrets) return;
    // Hosts present → a secretless, header-only proxy secret (the safe default).
    // No hosts → inject the value straight into the VM env. Either is tweakable
    // per-card afterward.
    const decl: SecretDeclaration =
      hosts.length > 0 ? { env, hosts, inject: "headers" } : { env, hosts: [], inject: "env" };
    if (await applyDeclarations([...declarationsFrom(secrets), decl])) {
      setNewEnv("");
      setNewHosts("");
    }
  };

  // Switch a secret's injection mode. `env` clears hosts (they don't apply). A
  // proxy mode needs at least one host, so when there's none yet we stash the
  // choice and let addHost commit it once a host is entered.
  const changeInject = async (s: ProfileSecret, inject: SecretInjectMode) => {
    if (inject === s.inject) return;
    if (inject === "env") {
      setPendingInject((m) => {
        const next = { ...m };
        delete next[s.env];
        return next;
      });
      await patchSecret(s.env, { inject, hosts: [] });
    } else if (s.hosts.length > 0) {
      await patchSecret(s.env, { inject });
    } else {
      setPendingInject((m) => ({ ...m, [s.env]: inject }));
    }
  };

  const removeSecret = async (env: string) => {
    if (!secrets) return;
    await applyDeclarations(declarationsFrom(secrets).filter((d) => d.env !== env));
  };

  const addHost = async (env: string) => {
    const secret = secrets?.find((s) => s.env === env);
    if (!secret) return;
    const host = normalizeHost(hostInputs[env] ?? "");
    if (!host || secret.hosts.includes(host)) {
      setHostInputs((m) => ({ ...m, [env]: "" }));
      return;
    }
    // Commit a mode that was pending on the first host (a proxy mode picked
    // while the secret had no hosts) together with the host itself.
    const pend = pendingInject[env];
    const patch: Partial<SecretDeclaration> = {
      hosts: [...secret.hosts, host],
    };
    if (pend) patch.inject = pend;
    if (await patchSecret(env, patch)) {
      setHostInputs((m) => ({ ...m, [env]: "" }));
      if (pend)
        setPendingInject((m) => {
          const next = { ...m };
          delete next[env];
          return next;
        });
    }
  };

  const removeHost = async (env: string, host: string) => {
    const secret = secrets?.find((s) => s.env === env);
    if (!secret || secret.hosts.length <= 1) return; // at least one host required
    await patchSecret(env, { hosts: secret.hosts.filter((h) => h !== host) });
  };

  const saveValue = async (env: string) => {
    const value = drafts[env] ?? "";
    if (!value || !activeProfileId) return;
    setBusy((b) => ({ ...b, [env]: true }));
    setError(null);
    try {
      await setProfileSecret(activeProfileId, env, value);
      setDrafts((d) => {
        const next = { ...d };
        delete next[env];
        return next;
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, [env]: false }));
    }
  };

  const clearValue = async (env: string) => {
    if (!activeProfileId) return;
    setBusy((b) => ({ ...b, [env]: true }));
    setError(null);
    try {
      await clearProfileSecret(activeProfileId, env);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, [env]: false }));
    }
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6 space-y-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Secrets</h2>
        <p className="text-xs text-muted-foreground">
          Expose API tokens to the agent. By default the value never enters the VM, and the proxy
          substitutes it into requests bound for the hosts you allow. For secrets the agent must use
          locally, you can instead inject the real value as a VM environment variable.
        </p>
      </div>

      {error && <p className="max-w-2xl text-xs text-destructive">{error}</p>}

      {hasConfig === null ? (
        <p className="text-xs text-muted-foreground/60">Loading…</p>
      ) : !hasConfig ? (
        <p className="max-w-2xl text-xs text-muted-foreground/60">
          This profile has no image yet, so there's nowhere to declare secrets. Add a{" "}
          <code>config.toml</code> to the profile first (see the Environment section).
        </p>
      ) : (
        <>
          <div className="max-w-2xl flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3">
            <Info className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Values are stored on the server, scoped to this profile:{" "}
              <span className="font-medium">write-only, never read back</span>. Names and host
              scoping are saved to this profile's <code>config.toml</code>. Changes apply to{" "}
              <span className="font-medium">newly created instances</span>.
            </p>
          </div>

          <ul className="max-w-2xl space-y-3">
            {(secrets ?? []).map((s) => {
              const valueInFlight = busy[s.env] ?? false;
              const draftValue = drafts[s.env] ?? "";
              const hostInput = hostInputs[s.env] ?? "";
              // A proxy mode picked while the secret had no hosts is shown
              // selected but isn't persisted until a host is added.
              const mode = pendingInject[s.env] ?? s.inject;
              return (
                <li key={s.env} className="rounded-lg border border-border p-4 space-y-3">
                  {/* Identity + value status + delete */}
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                    <code className="text-sm font-medium">{s.env}</code>
                    {s.hasValue ? (
                      <Badge variant="secondary" className="gap-1">
                        <Check className="size-3" /> Value set
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        No value, not injected
                      </Badge>
                    )}
                    <span className="flex-1" />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title="Remove secret"
                      disabled={savingDecls}
                      onClick={() => void removeSecret(s.env)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>

                  {/* Allowed hosts: editable chips (proxy modes only) */}
                  {mode !== "env" && (
                    <div className="space-y-1.5">
                      <span className="text-xs font-medium">Allowed hosts</span>
                      {s.hosts.length === 0 && pendingInject[s.env] && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-500">
                          Add a host to switch to “{INJECT_LABELS[pendingInject[s.env]!]}”.
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Input
                          value={hostInput}
                          disabled={savingDecls}
                          placeholder="api.example.com or *.example.com"
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                          onChange={(e) =>
                            setHostInputs((m) => ({
                              ...m,
                              [s.env]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void addHost(s.env);
                            }
                          }}
                          className="h-8 text-xs"
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-8 gap-1 text-xs shrink-0"
                          disabled={savingDecls || !normalizeHost(hostInput)}
                          onClick={() => void addHost(s.env)}
                        >
                          <Plus className="size-3.5" /> Add
                        </Button>
                      </div>
                      <ul className="flex flex-wrap gap-1.5 pt-0.5">
                        {s.hosts.map((h) => {
                          const last = s.hosts.length <= 1;
                          return (
                            <li
                              key={h}
                              className="flex items-center gap-1 rounded border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-[11px] font-mono"
                            >
                              {h}
                              <button
                                type="button"
                                aria-label={`Remove ${h}`}
                                title={last ? "At least one host is required" : `Remove ${h}`}
                                disabled={savingDecls || last}
                                className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                                onClick={() => void removeHost(s.env, h)}
                              >
                                <X className="size-3" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      <p className="text-[11px] text-muted-foreground">
                        Exact host by default. Use <code>*.example.com</code> to match a domain and
                        all its subdomains.
                      </p>
                    </div>
                  )}

                  {/* Injection mode */}
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium">Injection</span>
                    <select
                      value={mode}
                      disabled={savingDecls}
                      onChange={(e) => void changeInject(s, e.target.value as SecretInjectMode)}
                      className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                    >
                      <option value="headers">{INJECT_LABELS.headers}</option>
                      <option value="full">{INJECT_LABELS.full}</option>
                      <option value="env">{INJECT_LABELS.env}</option>
                    </select>
                    {mode === "env" ? (
                      <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-500">
                        <TriangleAlert className="size-3 mt-0.5 shrink-0" />
                        <span>{INJECT_DESCRIPTIONS.env}</span>
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        {INJECT_DESCRIPTIONS[mode]}
                      </p>
                    )}
                  </div>

                  {/* Value: write-only, stored server-side per profile */}
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium">Value</span>
                    <div className="flex items-center gap-2">
                      <Input
                        type="password"
                        autoComplete="off"
                        placeholder={
                          s.hasValue ? "Type a new value to replace it" : "Paste the secret value"
                        }
                        value={draftValue}
                        disabled={valueInFlight}
                        onChange={(e) => setDrafts((d) => ({ ...d, [s.env]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveValue(s.env);
                        }}
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-8 text-xs shrink-0"
                        disabled={valueInFlight || !draftValue}
                        onClick={() => void saveValue(s.env)}
                      >
                        {valueInFlight && <Loader2 className="size-3.5 animate-spin mr-1" />}
                        {s.hasValue ? "Replace" : "Save value"}
                      </Button>
                      {s.hasValue && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-xs shrink-0 text-muted-foreground hover:text-destructive"
                          disabled={valueInFlight}
                          onClick={() => void clearValue(s.env)}
                        >
                          Delete value
                        </Button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Held write-only on the server. It can be replaced or deleted here, but never
                      read back.
                    </p>
                  </div>
                </li>
              );
            })}
            {(secrets ?? []).length === 0 && (
              <li className="text-xs text-muted-foreground/60">No secrets declared yet.</li>
            )}
          </ul>

          <form
            className={cn(
              "max-w-2xl space-y-2 rounded-lg border border-dashed border-border p-3",
              savingDecls && "opacity-60",
            )}
            onSubmit={(e) => {
              e.preventDefault();
              void addSecret();
            }}
          >
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Declare a new variable
            </h3>
            <div className="flex items-center gap-2">
              <Input
                value={newEnv}
                onChange={(e) => setNewEnv(e.target.value)}
                placeholder="ENV_VAR_NAME"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="h-8 text-xs font-mono w-56"
              />
              <Input
                value={newHosts}
                onChange={(e) => setNewHosts(e.target.value)}
                placeholder="hosts: api.example.com, *.example.com (blank → VM env var)"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="h-8 text-xs flex-1"
              />
              <Button
                type="submit"
                size="sm"
                className="h-8 gap-1 text-xs shrink-0"
                disabled={savingDecls || !newEnv.trim()}
              >
                <Plus className="size-3.5" /> Declare
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Name the variable (e.g. <code>GH_TOKEN</code>) and the hosts its value may be sent to.
              The value is kept out of the VM, substituted by the proxy. Leave hosts blank to inject
              the real value into the VM as an environment variable instead. You'll set the value
              afterward, on the card that appears above.
            </p>
          </form>
        </>
      )}
    </div>
  );
}
