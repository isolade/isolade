import { ExternalLink, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { addPortForward, getPortProbe, listPorts, removePortForward } from "../../lib/api";
import type { PortForward, PortStatus } from "../../lib/contracts";
import { portStatusDotClass, portStatusLabel } from "../../lib/ports";
import { onExternalLinkClick } from "../../lib/tauri";

interface PortsPanelProps {
  instanceId: string;
  // Gates polling, since there's no point probing /proc/net/tcp while the panel is hidden.
  active: boolean;
}

// Manage this instance's port forwards: the ports currently forwarded to host
// loopback (with live listening status), plus guest ports detected listening
// but not yet forwarded (one-click "Forward"). A forward reaches the guest's
// 127.0.0.1, so a loopback-bound dev server works without binding 0.0.0.0.
export default function PortsPanel({ instanceId, active }: PortsPanelProps) {
  const [forwarded, setForwarded] = useState<PortForward[]>([]);
  const [statuses, setStatuses] = useState<PortStatus[]>([]);
  const [detected, setDetected] = useState<number[]>([]);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Ports with an in-flight add/remove, so their row can show a disabled state
  // and a second click can't double-fire.
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [ports, probe] = await Promise.all([listPorts(instanceId), getPortProbe(instanceId)]);
      setForwarded(ports);
      setStatuses(probe.forwarded);
      setDetected(probe.detected);
    } catch {
      // Transient (VM restarting, probe raced a teardown), so keep the last view.
    }
  }, [instanceId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [active, refresh]);

  const withBusy = useCallback(
    async (port: number, fn: () => Promise<unknown>) => {
      setBusy((b) => new Set(b).add(port));
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(port);
          return next;
        });
      }
    },
    [refresh],
  );

  const forward = (port: number) => withBusy(port, () => addPortForward(instanceId, port));
  const unforward = (port: number) => withBusy(port, () => removePortForward(instanceId, port));

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    const port = Number(manual.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("Enter a port between 1 and 65535");
      return;
    }
    setManual("");
    void forward(port);
  };

  const statusFor = useMemo(() => {
    const m = new Map(statuses.map((s) => [s.remotePort, s.status]));
    return (port: number) => m.get(port);
  }, [statuses]);

  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-2 text-sm">
      <Section title="Forwarded">
        {forwarded.length === 0 ? (
          <Empty>No ports forwarded yet.</Empty>
        ) : (
          forwarded.map((p) => {
            const status = statusFor(p.remotePort);
            const url = `http://localhost:${p.localPort}`;
            return (
              <div key={p.remotePort} className="flex items-center gap-2 py-1">
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", portStatusDotClass(status))}
                  title={portStatusLabel(status)}
                  aria-label={portStatusLabel(status)}
                />
                <span className="font-mono text-xs">
                  {p.remotePort}
                  <span className="text-muted-foreground"> → localhost:{p.localPort}</span>
                </span>
                <div className="ml-auto flex items-center">
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    title="Open in browser"
                  >
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open localhost:${p.localPort}`}
                      onClick={(e) => onExternalLinkClick(e, url)}
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    disabled={busy.has(p.remotePort)}
                    onClick={() => void unforward(p.remotePort)}
                    title="Stop forwarding"
                    aria-label={`Stop forwarding ${p.remotePort}`}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </Section>

      {detected.length > 0 && (
        <Section title="Detected">
          {detected.map((port) => (
            <div key={port} className="flex items-center gap-2 py-1">
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
              <span className="font-mono text-xs">{port}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 gap-1 text-xs text-muted-foreground"
                disabled={busy.has(port)}
                onClick={() => void forward(port)}
              >
                <Plus className="size-3.5" />
                Forward
              </Button>
            </div>
          ))}
        </Section>
      )}

      <form onSubmit={submitManual} className="mt-2 flex items-center gap-1">
        <Input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Forward a port…"
          inputMode="numeric"
          spellCheck={false}
          className="h-8 flex-1 font-mono text-xs"
          aria-label="Port to forward"
        />
        <Button type="submit" variant="outline" size="sm" className="h-8 gap-1 text-xs">
          <Plus className="size-3.5" />
          Forward
        </Button>
      </form>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <h3 className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-xs text-muted-foreground">{children}</p>;
}
