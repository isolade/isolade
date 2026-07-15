import { useEffect, useState } from "react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getResourceStats } from "../lib/api";
import type { ResourceStats } from "../lib/contracts";

const POLL_MS = 2000;

// One color per category, consistent across Memory / CPU / Disk so the eye
// can track e.g. "BuildKit builder" between bars.
// Picked for max hue separation around the color wheel: each adjacent pair
// in the legend should be visually distinct without relying on saturation.
const COLORS = {
  workspaceVMs: "bg-sky-500",
  builder: "bg-amber-500",
  registry: "bg-emerald-500",
  services: "bg-indigo-500",
  imageCache: "bg-violet-500",
  orphanedSandboxes: "bg-red-500",
  buildkitCache: "bg-lime-500",
  workspaceCheckouts: "bg-pink-500",
  workspaceCaches: "bg-fuchsia-500",
  database: "bg-cyan-500",
  other: "bg-zinc-600",
} as const;

// Base-10 (SI). Use for disk: vendors spec drives in decimal, so a "1 TB"
// SSD reads as ~931 GB in base-2.
function formatBytes(n: number): string {
  return formatBytesBase(n, 1000);
}

// Base-2 (binary). Use for memory: macOS Activity Monitor labels 64 GiB of
// physical RAM as "64 GB", so this matches what users see in AM.
function formatMemBytes(n: number): string {
  return formatBytesBase(n, 1024);
}

function formatBytesBase(n: number, base: 1000 | 1024): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

interface Segment {
  label: string;
  value: number;
  color: string;
  format: (n: number) => string;
}

function StackedBar({ segments, total }: { segments: Segment[]; total: number }) {
  if (total <= 0) {
    return <div className="h-3 bg-muted rounded overflow-hidden" />;
  }
  return (
    <div className="h-3 bg-muted rounded overflow-hidden flex">
      {segments.map((s, i) => {
        const pct = Math.max(0, Math.min(100, (s.value / total) * 100));
        if (pct <= 0) return null;
        return (
          <div
            key={i}
            className={`${s.color} h-full transition-all`}
            style={{ width: `${pct}%` }}
            title={`${s.label}: ${s.format(s.value)}`}
          />
        );
      })}
    </div>
  );
}

function Legend({ segments }: { segments: Segment[] }) {
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mt-3 text-xs">
      {segments.map((s, i) => (
        <li key={i} className="flex items-baseline gap-2 border-b border-border last:border-0 py-1">
          <span className={`${s.color} w-2.5 h-2.5 rounded-sm flex-shrink-0`} />
          <span className="text-foreground/80 flex-1 truncate">{s.label}</span>
          <span className="text-muted-foreground font-mono tabular-nums">{s.format(s.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 [.border-b]:pb-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {right && (
          <CardAction className="text-xs text-muted-foreground font-normal">{right}</CardAction>
        )}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

export default function ResourcesTab() {
  const [stats, setStats] = useState<ResourceStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Scoped to the effect so each mount gets a fresh flag. A useRef would
    // persist across React 18 StrictMode's mount→unmount→remount in dev,
    // causing the second mount's initial tick to bail on the first mount's
    // still-in-flight request and the first useful render to be delayed by
    // a full POLL_MS interval.
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getResourceStats();
        if (!cancelled) {
          setStats(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlight = false;
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error && !stats) {
    return (
      <div className="p-6 text-sm text-destructive">Failed to load resource stats: {error}</div>
    );
  }
  if (!stats) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const workspaceVms = stats.vms.filter((v) => v.role === "workspace");
  const builderVm = stats.vms.find((v) => v.role === "builder");

  // Memory. The OCI registry runs in-process inside the sandbox now, so its
  // memory share is already counted under "Isolade App" via the sandbox's
  // selfProcess sample, with no separate row.
  const wsMemSum = workspaceVms.reduce((a, v) => a + v.memoryBytes, 0);
  const builderMem = builderVm?.memoryBytes ?? 0;
  const servicesMemSum = stats.services.reduce((a, s) => a + s.memoryBytes, 0);
  const memoryUsed = stats.hostMemoryTotalBytes - stats.hostMemoryAvailableBytes;
  // Anything in "used" that isn't isolade: host OS, browser, your editor, etc.
  const otherMem = Math.max(0, memoryUsed - wsMemSum - builderMem - servicesMemSum);
  const memorySegments: Segment[] = [
    {
      label: "Workspace VMs",
      value: wsMemSum,
      color: COLORS.workspaceVMs,
      format: formatMemBytes,
    },
    {
      label: "BuildKit Builder VM",
      value: builderMem,
      color: COLORS.builder,
      format: formatMemBytes,
    },
    {
      label: "Isolade App",
      value: servicesMemSum,
      color: COLORS.services,
      format: formatMemBytes,
    },
    {
      label: "Other",
      value: otherMem,
      color: COLORS.other,
      format: formatMemBytes,
    },
  ];

  // CPU. vm.cpuPercent is the VM's host-process CPU cost (sampled from the
  // `msb` process, so it matches Activity Monitor, not the guest-only vCPU
  // figure, which omits virtualization and I/O overhead). Sum / (cores * 100)
  // is the visual fill. "Other" is whatever else is using the host: total
  // host usage minus our categories, floored at 0 in case our shares
  // momentarily exceed the host sample. The in-process registry's CPU folds
  // into "Isolade App" (selfProcess).
  const totalCpuCapacity = stats.hostCpuCount * 100;
  const wsCpuSum = workspaceVms.reduce((a, v) => a + v.cpuPercent, 0);
  const builderCpu = builderVm?.cpuPercent ?? 0;
  const servicesCpuSum = stats.services.reduce((a, s) => a + s.cpuPercent, 0);
  const otherCpu = Math.max(0, stats.hostCpuPercent - wsCpuSum - builderCpu - servicesCpuSum);
  const cpuSegments: Segment[] = [
    {
      label: "Workspace VMs",
      value: wsCpuSum,
      color: COLORS.workspaceVMs,
      format: formatPercent,
    },
    {
      label: "BuildKit Builder VM",
      value: builderCpu,
      color: COLORS.builder,
      format: formatPercent,
    },
    {
      label: "Isolade App",
      value: servicesCpuSum,
      color: COLORS.services,
      format: formatPercent,
    },
    {
      label: "Other",
      value: otherCpu,
      color: COLORS.other,
      format: formatPercent,
    },
  ];

  // Disk. Bar fills against the host filesystem capacity (the volume
  // holding $HOME). "Other" covers everything non-isolade on that volume,
  // computed as host-used minus the isolade categories.
  const wsUpperSum = workspaceVms.reduce((a, v) => a + v.upperDiskBytes, 0);
  const builderUpper = builderVm?.upperDiskBytes ?? 0;
  const registryDisk = stats.registryDiskBytes;
  const isoladeDiskUsed =
    wsUpperSum +
    builderUpper +
    registryDisk +
    stats.microsandboxImageCacheBytes +
    stats.microsandboxOrphanedSandboxBytes +
    stats.buildkitCacheDiskBytes +
    stats.workspaceCheckoutsBytes +
    stats.workspaceCachesBytes +
    stats.databaseBytes;
  const hostDiskUsed = stats.hostDiskTotalBytes - stats.hostDiskAvailableBytes;
  const otherDisk = Math.max(0, hostDiskUsed - isoladeDiskUsed);
  const diskSegments: Segment[] = [
    {
      label: "Workspace VM Upper Layers",
      value: wsUpperSum,
      color: COLORS.workspaceVMs,
      format: formatBytes,
    },
    {
      label: "BuildKit Builder Upper Layer",
      value: builderUpper,
      color: COLORS.builder,
      format: formatBytes,
    },
    {
      label: "OCI Registry Blobs",
      value: registryDisk,
      color: COLORS.registry,
      format: formatBytes,
    },
    {
      label: "Microsandbox Image Cache",
      value: stats.microsandboxImageCacheBytes,
      color: COLORS.imageCache,
      format: formatBytes,
    },
    {
      label: "Orphaned Sandbox Dirs",
      value: stats.microsandboxOrphanedSandboxBytes,
      color: COLORS.orphanedSandboxes,
      format: formatBytes,
    },
    {
      label: "BuildKit Cache Disk",
      value: stats.buildkitCacheDiskBytes,
      color: COLORS.buildkitCache,
      format: formatBytes,
    },
    {
      label: "Workspace Checkouts",
      value: stats.workspaceCheckoutsBytes,
      color: COLORS.workspaceCheckouts,
      format: formatBytes,
    },
    {
      label: "Workspace Caches",
      value: stats.workspaceCachesBytes,
      color: COLORS.workspaceCaches,
      format: formatBytes,
    },
    {
      label: "isolade.db",
      value: stats.databaseBytes,
      color: COLORS.database,
      format: formatBytes,
    },
    {
      label: "Other",
      value: otherDisk,
      color: COLORS.other,
      format: formatBytes,
    },
  ];

  return (
    <div className="h-full overflow-auto p-4 grid gap-4 grid-cols-1 lg:grid-cols-3">
      <Section
        title="Memory"
        right={`${formatMemBytes(memoryUsed)} / ${formatMemBytes(stats.hostMemoryTotalBytes)}`}
      >
        <StackedBar segments={memorySegments} total={stats.hostMemoryTotalBytes} />
        <Legend segments={memorySegments} />
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {stats.vms.map((vm) => (
            <li key={vm.id} className="flex justify-between border-b border-border py-1">
              <span>
                {vm.role === "builder"
                  ? "BuildKit builder VM"
                  : `Workspace VM · ${vm.id.slice(0, 8)}`}
                <span className="ml-2 text-muted-foreground/70">
                  limit {formatMemBytes(vm.memoryLimitBytes)} · up {formatUptime(vm.uptimeMs)}
                </span>
              </span>
              <span className="font-mono tabular-nums">{formatMemBytes(vm.memoryBytes)}</span>
            </li>
          ))}
          {stats.services.map((svc) => (
            <li
              key={`mem-${svc.name}`}
              className="flex justify-between border-b border-border py-1"
            >
              <span>
                {svc.name}
                <span className="ml-2 text-muted-foreground/70">pid {svc.pid}</span>
              </span>
              <span className="font-mono tabular-nums">{formatMemBytes(svc.memoryBytes)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="CPU" right={`${stats.hostCpuCount} cores`}>
        <StackedBar segments={cpuSegments} total={totalCpuCapacity} />
        <Legend segments={cpuSegments} />
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {stats.vms.map((vm) => (
            <li
              key={vm.id}
              className="flex justify-between border-b border-border py-1"
              title="Host CPU cost of the VM process (matches Activity Monitor). 'in-VM' is the guest vCPU busy time, which excludes virtualization and I/O overhead."
            >
              <span>
                {vm.role === "builder"
                  ? "BuildKit builder VM"
                  : `Workspace VM · ${vm.id.slice(0, 8)}`}
                <span className="ml-2 text-muted-foreground/70">
                  in-VM {formatPercent(vm.guestCpuPercent)}
                </span>
              </span>
              <span className="font-mono tabular-nums">{formatPercent(vm.cpuPercent)}</span>
            </li>
          ))}
          {stats.services.map((svc) => (
            <li
              key={`cpu-${svc.name}`}
              className="flex justify-between border-b border-border py-1"
            >
              <span>
                {svc.name}
                <span className="ml-2 text-muted-foreground/70">pid {svc.pid}</span>
              </span>
              <span className="font-mono tabular-nums">{formatPercent(svc.cpuPercent)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Disk"
        right={`${formatBytes(hostDiskUsed)} / ${formatBytes(stats.hostDiskTotalBytes)}`}
      >
        <StackedBar segments={diskSegments} total={stats.hostDiskTotalBytes} />
        <Legend segments={diskSegments} />
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {stats.vms.map((vm) => (
            <li key={vm.id} className="flex justify-between border-b border-border py-1">
              <span>
                {vm.role === "builder"
                  ? "BuildKit builder VM"
                  : `Workspace VM · ${vm.id.slice(0, 8)}`}
              </span>
              <span className="font-mono tabular-nums">{formatBytes(vm.upperDiskBytes)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
