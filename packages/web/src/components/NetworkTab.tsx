import { Check, Globe, Info, Loader2, Lock, Plus, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getNetworkConfig, setNetworkConfig } from "../lib/api";
import {
  ESSENTIAL_NETWORK_DOMAINS,
  type InternetAccess,
  type NetworkConfig,
} from "../lib/contracts";
import { Field, NumberChips } from "./profile-form-controls";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Trim user input down to a bare host (drop scheme, path, surrounding
// whitespace, lowercase), preserving a leading "*." as the wildcard marker the
// sandbox turns into a suffix rule. Returns "" for input with no usable host.
function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  if (!d) return "";
  const wildcard = d.startsWith("*.");
  if (wildcard) d = d.slice(2);
  d = d.replace(/^[a-z]+:\/\//, ""); // scheme
  d = d.split("/")[0] ?? ""; // path
  d = d.replace(/^\*\./, "").replace(/^\.+/, ""); // stray wildcard / leading dots
  if (!d) return "";
  return wildcard ? `*.${d}` : d;
}

const INTERNET_OPTIONS: {
  value: InternetAccess;
  label: string;
  description: string;
  Icon: typeof Globe;
}[] = [
  {
    value: "open",
    label: "Open",
    description: "Agents can reach any public site on the internet.",
    Icon: Globe,
  },
  {
    value: "allowlist",
    label: "Allowlist",
    description: "Agents can only reach the domains you approve below.",
    Icon: ShieldCheck,
  },
];

export default function NetworkTab({ activeProfileId }: { activeProfileId: string | null }) {
  // `saved` is the last-persisted config. `cfg` is the working copy. Dirty when
  // they differ. Both null until the initial load resolves.
  const [saved, setSaved] = useState<NetworkConfig | null>(null);
  const [cfg, setCfg] = useState<NetworkConfig | null>(null);
  const [domainDraft, setDomainDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProfileId) return;
    void (async () => {
      try {
        const c = await getNetworkConfig(activeProfileId);
        setSaved(c);
        setCfg(c);
      } catch (e) {
        setLoadError(msg(e));
      }
    })();
  }, [activeProfileId]);

  const dirty = useMemo(
    () => cfg !== null && saved !== null && JSON.stringify(cfg) !== JSON.stringify(saved),
    [cfg, saved],
  );

  // Any edit clears the transient "Saved" tick so it doesn't linger over a
  // now-stale state.
  const patch = useCallback((next: Partial<NetworkConfig>) => {
    setJustSaved(false);
    setCfg((prev) => (prev ? { ...prev, ...next } : prev));
  }, []);

  const addDomain = useCallback(() => {
    const d = normalizeDomain(domainDraft);
    if (!d) return;
    setDomainDraft("");
    setJustSaved(false);
    setCfg((prev) =>
      prev && !prev.allowedDomains.includes(d)
        ? { ...prev, allowedDomains: [...prev.allowedDomains, d] }
        : prev,
    );
  }, [domainDraft]);

  const removeDomain = useCallback((d: string) => {
    setJustSaved(false);
    setCfg((prev) =>
      prev
        ? {
            ...prev,
            allowedDomains: prev.allowedDomains.filter((x) => x !== d),
          }
        : prev,
    );
  }, []);

  const onSave = useCallback(async () => {
    if (!cfg || !activeProfileId) return;
    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      const result = await setNetworkConfig(activeProfileId, cfg);
      setSaved(result);
      setCfg(result);
      setJustSaved(true);
    } catch (e) {
      setSaveError(msg(e));
    } finally {
      setSaving(false);
    }
  }, [cfg, activeProfileId]);

  if (!cfg) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        {loadError ? (
          <p className="text-xs text-destructive max-w-2xl">
            Couldn’t load network settings: {loadError}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/60">Loading…</p>
        )}
      </div>
    );
  }

  const allowlist = cfg.internet === "allowlist";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-sm font-medium">Network</h2>
        <p className="text-xs text-muted-foreground">
          Control what the sandboxed agents can reach over the network. Applies to every workspace.
        </p>
      </div>

      <div className="max-w-2xl flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3">
        <Info className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Changes apply to <span className="font-medium">newly created instances</span>. Restart an
          instance to apply a new policy to it.
        </p>
      </div>

      {/* Axis 1: internet (public) egress */}
      <div className="max-w-2xl rounded-lg border border-border p-4 space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">Internet access</h3>
          <p className="text-xs text-muted-foreground">How agents reach public sites.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {INTERNET_OPTIONS.map(({ value, label, description, Icon }) => {
            const selected = cfg.internet === value;
            return (
              <label
                key={value}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors",
                  selected
                    ? "border-primary ring-2 ring-ring/40"
                    : "border-border hover:bg-accent/40",
                )}
              >
                <input
                  type="radio"
                  name="internet-access"
                  className="mt-0.5 accent-foreground"
                  checked={selected}
                  onChange={() => patch({ internet: value })}
                />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium flex items-center gap-1.5">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    {label}
                  </span>
                  <span className="text-xs text-muted-foreground">{description}</span>
                </span>
              </label>
            );
          })}
        </div>

        {allowlist && (
          <div className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <span className="text-xs font-medium flex items-center gap-1.5">
                <Lock className="size-3 text-muted-foreground" /> Always allowed
              </span>
              <p className="text-[11px] text-muted-foreground">
                Required for the agents themselves to run: Claude and ChatGPT (and their subdomains)
                stay reachable regardless.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ESSENTIAL_NETWORK_DOMAINS.map((d) => (
                  <Badge key={d} variant="secondary" className="font-mono text-[11px]">
                    *.{d}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-medium">Allowed domains</span>
              <div className="flex gap-2">
                <Input
                  className="h-8 text-xs"
                  placeholder="e.g. api.github.com or *.github.com"
                  value={domainDraft}
                  onChange={(e) => setDomainDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addDomain();
                    }
                  }}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8 gap-1 text-xs shrink-0"
                  disabled={!normalizeDomain(domainDraft)}
                  onClick={addDomain}
                >
                  <Plus className="size-3.5" /> Add
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Exact host by default. <code>api.github.com</code> matches only that host. Use{" "}
                <code>*.github.com</code> to allow <code>github.com</code> and all its subdomains.
                Everything else is blocked, including connections to raw IP addresses.
              </p>
              {cfg.allowedDomains.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 pt-0.5">
                  {cfg.allowedDomains.map((d) => (
                    <li
                      key={d}
                      className="flex items-center gap-1 rounded border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-[11px] font-mono"
                    >
                      {d}
                      <button
                        type="button"
                        aria-label={`Remove ${d}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => removeDomain(d)}
                      >
                        <X className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Axis 2: reachable zones (destination groups), independent of axis 1 */}
      <div className="max-w-2xl rounded-lg border border-border p-4 space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">Reachable zones</h3>
          <p className="text-xs text-muted-foreground">
            Beyond the public internet, choose whether agents may reach your own machine and
            network. Both are off by default to keep the sandbox isolated.
          </p>
        </div>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            className="accent-foreground mt-0.5"
            checked={cfg.allowLocalNetwork}
            onChange={(e) => patch({ allowLocalNetwork: e.target.checked })}
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm">Local network</span>
            <span className="text-xs text-muted-foreground">
              Reach private IPs and other devices on your LAN (RFC 1918).
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            className="accent-foreground mt-0.5"
            checked={cfg.allowHost}
            onChange={(e) => patch({ allowHost: e.target.checked })}
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm">Host machine</span>
            <span className="text-xs text-muted-foreground">
              Reach services running on your computer. Workspace-declared host ports always work
              regardless.
            </span>
          </span>
        </label>
      </div>

      {/* Axis 3: port forwarding — what the VM exposes to the host and what
          host ports it may reach. Workspace-declared, independent of the egress
          policy above. */}
      <div className="max-w-2xl rounded-lg border border-border p-4 space-y-4">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">Ports</h3>
          <p className="text-xs text-muted-foreground">
            Forward ports between the instance VM and your machine. Applied when an instance is
            created; restart an instance to pick up a change.
          </p>
        </div>
        <Field
          label="Forwarded ports"
          description="Guest TCP ports forwarded to the host on instance create (e.g. a dev server)."
        >
          <NumberChips
            value={cfg.ports}
            onChange={(ports) => patch({ ports })}
            placeholder="5173"
          />
        </Field>
        <Field
          label="Host ports"
          description="Host bridge ports the VM may reach (egress). Allowed regardless of the host-machine zone above; by default the VM can reach none."
        >
          <NumberChips
            value={cfg.hostPorts}
            onChange={(hostPorts) => patch({ hostPorts })}
            placeholder="5432"
          />
        </Field>
      </div>

      {saveError && <p className="text-xs text-destructive max-w-2xl">{saveError}</p>}

      <div className="max-w-2xl flex items-center gap-3">
        <Button size="sm" className="h-8 text-xs" disabled={!dirty || saving} onClick={onSave}>
          {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
          Save changes
        </Button>
        {justSaved && !dirty && (
          <span className="text-xs text-emerald-600 flex items-center gap-1">
            <Check className="size-3.5" /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
