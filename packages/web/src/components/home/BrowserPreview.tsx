import { ExternalLink, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getPortProbe } from "../../lib/api";
import type { PortForward, PortStatus } from "../../lib/contracts";
import { portStatusDotClass, portStatusLabel } from "../../lib/ports";
import { onExternalLinkClick } from "../../lib/tauri";

interface BrowserPreviewProps {
  instanceId: string;
  // Forwarded ports for this instance (guest → host loopback). Empty until the
  // VM declares any.
  ports: PortForward[];
  // True while the preview is the visible panel mode. Gates status polling and
  // the deferred first paint, so we don't hammer the dev server while hidden.
  active: boolean;
}

// Leading slash, but leave an empty path empty so the URL is just the origin.
function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export default function BrowserPreview({ instanceId, ports, active }: BrowserPreviewProps) {
  const [selectedRemotePort, setSelectedRemotePort] = useState<number | null>(null);
  const [statuses, setStatuses] = useState<PortStatus[]>([]);
  // `pathDraft` is the controlled input. `committedPath` is what the iframe
  // actually loads (updated on submit, so we don't navigate on every keystroke).
  const [pathDraft, setPathDraft] = useState("");
  const [committedPath, setCommittedPath] = useState("");
  // Bumped to force the iframe to reload the same URL (changing src alone is a
  // no-op when it's unchanged, so we remount via key).
  const [reloadKey, setReloadKey] = useState(0);

  // Probe which guest ports are actually listening, but only while the preview
  // is the visible mode, since there's no point polling behind the terminal.
  useEffect(() => {
    if (!active || ports.length === 0) return;
    let cancelled = false;
    const probe = async () => {
      try {
        const { forwarded } = await getPortProbe(instanceId);
        if (!cancelled) setStatuses(forwarded);
      } catch {}
    };
    void probe();
    const t = setInterval(probe, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [active, instanceId, ports.length]);

  // Default the selection to a port that's actually listening (else the first
  // forwarded port), and keep it valid as the port set changes.
  useEffect(() => {
    if (selectedRemotePort != null && ports.some((p) => p.remotePort === selectedRemotePort)) {
      return;
    }
    const listening = statuses.find(
      (s) => s.status === "listening" && ports.some((p) => p.remotePort === s.remotePort),
    );
    setSelectedRemotePort(listening?.remotePort ?? ports[0]?.remotePort ?? null);
  }, [ports, statuses, selectedRemotePort]);

  if (ports.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        No forwarded ports yet. Start a server in the VM and forward its port from the Ports panel
        to preview it here.
      </div>
    );
  }

  const selected = ports.find((p) => p.remotePort === selectedRemotePort) ?? null;
  const selectedStatus = statuses.find((s) => s.remotePort === selectedRemotePort)?.status;
  const url = selected
    ? `http://localhost:${selected.localPort}${normalizePath(committedPath)}`
    : null;

  const submitPath = (e: React.FormEvent) => {
    e.preventDefault();
    setCommittedPath(pathDraft);
  };

  return (
    <div className="flex h-full flex-col">
      <form
        onSubmit={submitPath}
        className="flex items-center gap-1 border-b border-border px-1.5 py-1.5"
      >
        <Select
          value={selectedRemotePort != null ? String(selectedRemotePort) : ""}
          onValueChange={(v) => setSelectedRemotePort(Number(v))}
        >
          <SelectTrigger size="sm" className="w-auto gap-1 font-mono text-xs" aria-label="Port">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ports.map((p) => {
              const status = statuses.find((s) => s.remotePort === p.remotePort)?.status;
              return (
                <SelectItem key={p.remotePort} value={String(p.remotePort)}>
                  <span className="inline-flex items-center gap-1.5 font-mono">
                    <span
                      className={cn("size-1.5 rounded-full", portStatusDotClass(status))}
                      aria-hidden
                    />
                    {p.remotePort}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Input
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          placeholder="/"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          aria-label="Path"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          onClick={() => setReloadKey((k) => k + 1)}
          title="Reload"
          aria-label="Reload"
        >
          <RotateCw className="size-3.5" />
        </Button>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          title="Open in browser"
        >
          <a
            href={url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in browser"
            onClick={(e) => onExternalLinkClick(e, url)}
          >
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </form>

      {selectedStatus === "not-listening" && (
        <div className="flex items-center gap-1.5 border-b border-border bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", portStatusDotClass(selectedStatus))}
            aria-hidden
          />
          {portStatusLabel(selectedStatus)}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {url && (
          <iframe
            // Remount on port change or manual reload. Path changes navigate the
            // existing frame via the src attribute.
            key={`${selected?.localPort}-${reloadKey}`}
            src={url}
            className="h-full w-full border-0"
            title="Browser preview"
            allow="clipboard-read; clipboard-write"
            // Withhold `allow-top-navigation*` so a framebusting page can't
            // yank the whole app to another URL (window.top.location =, target
            // _top). This does NOT stop the embedded page's own history.back()/
            // go() from stepping the parent: an iframe shares the window's joint
            // session history and traversal isn't gated by sandbox
            // (whatwg/html#880). Fully isolating that would need a separate
            // browsing context, not an iframe. Accepted limitation for now. The
            // toolbar's open-in-browser button is the escape hatch. The other
            // tokens keep ordinary web apps working, and allow-same-origin is safe
            // because the preview is a different origin than the app.
            // oxlint-disable-next-line react/iframe-missing-sandbox -- the allow-scripts + allow-same-origin combo is deliberate for this trusted, cross-origin preview (see above). Dropping either breaks rendering.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          />
        )}
      </div>
    </div>
  );
}
