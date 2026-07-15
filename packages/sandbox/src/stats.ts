import { execFile } from "node:child_process";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { dirAllocatedBytes, fileAllocatedBytes } from "@isolade/shared/node";
import { cacheDir } from "@isolade/shared/node/xdg";
import type { Sandbox } from "microsandbox";
import type { BuilderManager } from "./builder";
import { msbStateHome } from "./msb-home";
import { defaultDataDir as registryDataDir } from "./registry";
import type { VmManager } from "./vms";

const execFileAsync = promisify(execFile);

export interface VmStat {
  id: string;
  role: "workspace" | "builder";
  // Host-visible CPU cost of this VM's `msb` process (see VmProcessCpuSampler),
  // on the same 0..(hostCpuCount * 100) scale as hostCpuPercent. Falls back to
  // `guestCpuPercent` when the process can't be sampled.
  cpuPercent: number;
  // Guest-only vCPU busy time straight from microsandbox's metrics. Always ≤
  // cpuPercent: it omits the host-side virtualization / device-emulation / I/O
  // overhead that Activity Monitor attributes to the VMM process.
  guestCpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  uptimeMs: number;
  upperDiskBytes: number;
}

export interface ProcessStat {
  name: string;
  pid: number;
  cpuPercent: number;
  memoryBytes: number;
}

export interface SandboxStats {
  vms: VmStat[];
  hostMemoryTotalBytes: number;
  hostMemoryFreeBytes: number;
  // Free + reclaimable file cache (Linux MemAvailable, macOS vm_stat-derived).
  // This is what the UI should base "memory pressure" on. `freemem()` alone
  // looks alarmingly low because it excludes the page cache that the kernel
  // would happily evict under demand.
  hostMemoryAvailableBytes: number;
  hostCpuCount: number;
  // Total host CPU usage on a 0..(hostCpuCount * 100) scale, the same units as
  // VmStat.cpuPercent, so segments and totals are directly comparable.
  // Sampled from os.cpus() time deltas between collections.
  hostCpuPercent: number;
  // Filesystem stats for the volume holding $HOME, where every isolade
  // path lives. Used as the 100% reference for the Disk bar.
  hostDiskTotalBytes: number;
  hostDiskAvailableBytes: number;
  // The sandbox's own process. Server-side merges in its own and proxies as
  // a `services` array, but the sandbox can only see itself, so it reports
  // a single ProcessStat here.
  selfProcess: ProcessStat;
  // ~/.microsandbox/cache: OCI image cache (extracted layer blobs, fsmeta,
  // manifests). Shared base-image data, since every VM with the same image
  // reads from this once.
  microsandboxImageCacheBytes: number;
  // ~/.microsandbox/sandboxes minus the upper.ext4 of currently running VMs.
  // Per-VM rootfs deltas left behind by VMs that didn't clean up. Each is
  // usually a several-GiB upper.ext4. Live VMs' uppers are reported in the
  // VmStat array.
  microsandboxOrphanedSandboxBytes: number;
  buildkitCacheDiskBytes: number;
  // Disk used by the in-process OCI registry's content + manifest store.
  // No separate CPU/memory: the registry shares the sandbox process now,
  // so its share of those resources is already counted in `selfProcess`.
  registryDiskBytes: number;
  collectedAtMs: number;
}

function upperExt4Path(vmName: string): string {
  return join(msbStateHome(), "sandboxes", vmName, "upper.ext4");
}

function buildkitCacheDiskPath(): string {
  return process.env.ISOLADE_BUILDKIT_CACHE_DISK || join(cacheDir(), "buildkit.ext4");
}

interface VmHandle {
  id: string;
  role: "workspace" | "builder";
  sandbox: Sandbox;
}

// Tracks user+system CPU time between samples to derive a percent. Bun's
// process.cpuUsage() returns absolute microseconds since process start. The
// percent is just `(deltaCpuUs / deltaWallUs) × 100`. Can exceed 100 when
// using multiple cores. First sample after process start returns ~0 because
// there's no baseline yet.
class SelfProcessSampler {
  private prevCpu = process.cpuUsage();
  private prevAtMs = Date.now();

  constructor(private name: string) {}

  sample(): ProcessStat {
    const cpu = process.cpuUsage();
    const nowMs = Date.now();
    const cpuDeltaUs = cpu.user + cpu.system - (this.prevCpu.user + this.prevCpu.system);
    const wallDeltaMs = nowMs - this.prevAtMs;
    this.prevCpu = cpu;
    this.prevAtMs = nowMs;
    const cpuPercent = wallDeltaMs > 0 ? (cpuDeltaUs / 1000 / wallDeltaMs) * 100 : 0;
    return {
      name: this.name,
      pid: process.pid,
      cpuPercent,
      memoryBytes: process.memoryUsage().rss,
    };
  }
}

const sandboxSelfSampler = new SelfProcessSampler("sandbox");

// Host-wide CPU usage from os.cpus() time counters. Each core exposes
// cumulative ticks in {user, nice, sys, idle, irq}. Busy% over the interval
// is (busyDelta / totalDelta), and multiplying by cores × 100 puts it on the
// same 0..(cores*100) scale as VmStat.cpuPercent so segments add up
// meaningfully. First sample after construction returns 0 (no prior baseline).
class HostCpuSampler {
  private prev = cpus();

  sample(): number {
    const curr = cpus();
    const n = Math.min(curr.length, this.prev.length);
    let busyDelta = 0;
    let totalDelta = 0;
    for (let i = 0; i < n; i++) {
      const prevCpu = this.prev[i];
      const currCpu = curr[i];
      if (prevCpu === undefined || currCpu === undefined) continue;
      const a = prevCpu.times;
      const b = currCpu.times;
      const idle = b.idle - a.idle;
      const total =
        b.user - a.user + b.nice - a.nice + b.sys - a.sys + b.idle - a.idle + b.irq - a.irq;
      busyDelta += total - idle;
      totalDelta += total;
    }
    this.prev = curr;
    return totalDelta > 0 ? (busyDelta / totalDelta) * curr.length * 100 : 0;
  }
}

// Parse a `ps` cumulative CPU-time field into milliseconds. Formats vary by
// platform and magnitude: "MM:SS.ss", "HH:MM:SS", "D-HH:MM:SS" (and the
// leading component may have more than two digits). Anything unparseable
// yields 0 so a malformed row degrades to "no reading" rather than throwing.
export function parseCpuTimeMs(field: string): number {
  let days = 0;
  let rest = field;
  const dash = field.indexOf("-");
  if (dash >= 0) {
    days = Number(field.slice(0, dash)) || 0;
    rest = field.slice(dash + 1);
  }
  let seconds = 0;
  for (const part of rest.split(":")) {
    seconds = seconds * 60 + (Number(part) || 0);
  }
  return (days * 86_400 + seconds) * 1000;
}

// True per-VM CPU usage, sampled from the host process table rather than from
// inside the guest.
//
// Each microsandbox VM runs as its own `msb sandbox --name <id> …` child
// process. libkrun does device emulation, virtio-fs/net/block and all I/O
// in-process, so that process's CPU time (exactly what Activity Monitor
// shows) is the VM's full host cost. microsandbox's own cpuPercent only
// counts guest vCPU execution (hv_vcpu_get_exec_time) and therefore reads
// systematically lower, especially under I/O-heavy workloads. This sampler
// recovers the host-visible number by diffing each process's cumulative CPU
// time over wall-clock, yielding the same 0..(cores*100) scale as
// HostCpuSampler so VM segments and the host total stay comparable.
//
// The `--name <id>` flag carries the VM's sandbox name, which is exactly the
// id VmManager/BuilderManager use, giving a clean pid↔VM mapping with no
// dependency on microsandbox internals.
export interface VmProcessSample {
  pid: number;
  cpuMs: number;
}

export class VmProcessCpuSampler {
  private prev = new Map<string, { pid: number; cpuMs: number; atMs: number }>();

  // Returns sandbox-name → host CPU percent for every `msb` VM process we
  // could both locate and diff against a prior sample. Names absent from the
  // result have no reliable reading yet (first sample after start, or a
  // restarted pid). Callers should fall back to the guest figure. Scans the
  // whole table rather than a caller-supplied id set so it can run on a
  // background tick that has no view of the current VM list. The request
  // path looks up its VMs by name.
  async sample(): Promise<Map<string, number>> {
    let current: Map<string, VmProcessSample>;
    try {
      current = await this.scanProcesses();
    } catch {
      // ps unavailable/failed, so keep prior baselines (a transient failure
      // doesn't force a full re-warm) and report nothing this tick.
      return new Map();
    }
    return this.account(current, Date.now());
  }

  // Pure accounting step: diff `current` against the stored baseline, advance
  // the baseline, and drop entries whose process has vanished. Split out from
  // the `ps` scan so the delta / pid-reset logic is deterministically testable.
  account(current: Map<string, VmProcessSample>, nowMs: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const [name, { pid, cpuMs }] of current) {
      const prev = this.prev.get(name);
      if (prev && prev.pid === pid && nowMs > prev.atMs) {
        const cpuDeltaMs = cpuMs - prev.cpuMs;
        const wallDeltaMs = nowMs - prev.atMs;
        // A backwards counter (shouldn't happen for a stable pid) reads as 0
        // rather than a negative percent.
        out.set(name, cpuDeltaMs > 0 ? (cpuDeltaMs / wallDeltaMs) * 100 : 0);
      }
      this.prev.set(name, { pid, cpuMs, atMs: nowMs });
    }

    // Drop baselines for processes that are gone so the map can't grow
    // unbounded and a future reused name starts from a clean slate.
    for (const name of this.prev.keys()) {
      if (!current.has(name)) this.prev.delete(name);
    }
    return out;
  }

  protected async scanProcesses(): Promise<Map<string, VmProcessSample>> {
    // -A: every process. -ww: don't truncate argv (the VM's argv is long).
    // empty-header -o fields give plain "<pid> <cputime> <argv…>" lines.
    const { stdout } = await execFileAsync("ps", ["-A", "-ww", "-o", "pid=,cputime=,args="], {
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const found = new Map<string, VmProcessSample>();
    for (const line of stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const [, pidStr, cpuStr, argv] = m;
      if (pidStr === undefined || cpuStr === undefined || argv === undefined) continue;
      // Cheap reject before the regex: only the msb VMM launchers qualify.
      if (!argv.includes("/msb ") || !argv.includes(" sandbox ")) continue;
      const vmName = argv.match(/--name\s+(\S+)/)?.[1];
      if (vmName === undefined) continue;
      found.set(vmName, { pid: Number(pidStr), cpuMs: parseCpuTimeMs(cpuStr) });
    }
    return found;
  }
}

export interface CpuSnapshot {
  // Host-wide CPU on a 0..(hostCpuCount * 100) scale (os.cpus() deltas).
  hostCpuPercent: number;
  // Per-VM host-process CPU keyed by sandbox name, same scale. Absent names
  // have no reading yet, so the request path falls back to the guest figure.
  vmHostCpuByName: Map<string, number>;
}

// Background CPU sampler.
//
// Every CPU figure on the resources tab is a delta-over-time measurement, so
// the result depends on the window it's taken over. Sampling on a fixed
// interval, rather than lazily whenever /stats is requested, gives every
// figure a constant ~1s window regardless of poll cadence, tab visibility, or
// how many clients are watching, and lines the host VM number up with
// microsandbox's own 1s guest sampler so `host ≥ guest` holds rather than
// flickering when the two are measured over different spans. It also keeps the
// `ps` scan off the /stats hot path. The request handler just reads snapshot().
//
// Host total and per-VM CPU share one tick so they're measured over the same
// window and subtract cleanly in the "Other" bucket. The os.cpus() delta in
// particular must advance exactly once per tick. A second consumer sampling
// it would corrupt the delta. That is the reason collectSandboxStats reads
// the snapshot instead of sampling inline.
export class CpuSampler {
  private hostSampler = new HostCpuSampler();
  private vmSampler = new VmProcessCpuSampler();
  private value: CpuSnapshot = {
    hostCpuPercent: 0,
    vmHostCpuByName: new Map(),
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly intervalMs: number = 1000) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Latest values, non-blocking. Returns zeros/empties until the sampler has
  // warmed up (host after the first tick, VMs after the second), during which
  // collectSandboxStats falls back to guest CPU for VMs and reports 0 host.
  snapshot(): CpuSnapshot {
    return this.value;
  }

  private async tick(): Promise<void> {
    const hostCpuPercent = this.hostSampler.sample();
    // sample() never throws (it catches ps failures and returns empty). On an
    // empty result the VMs simply fall back to guest CPU for this tick.
    const vmHostCpuByName = await this.vmSampler.sample();
    this.value = { hostCpuPercent, vmHostCpuByName };
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }
}

// Filesystem usage for the volume that holds $HOME. statfs is portable
// (POSIX) and Node exposes it as fs.statfs in 18.15+. blocks/bavail are
// reported in `bsize` units. We report:
//   - total: blocks * bsize
//   - available: bavail * bsize  (excludes the root-reserved blocks, matching
//     `df`'s "Avail" column rather than `bfree`)
async function collectHostDiskStats(): Promise<{
  total: number;
  available: number;
}> {
  try {
    const { statfs } = await import("node:fs/promises");
    const s = await statfs(homedir());
    return {
      total: Number(s.blocks) * Number(s.bsize),
      available: Number(s.bavail) * Number(s.bsize),
    };
  } catch {
    return { total: 0, available: 0 };
  }
}

// Best-effort "memory available without forcing swap-out", matching what
// Linux exposes as MemAvailable and macOS Activity Monitor shows as
// "available." Falls back to os.freemem() if parsing fails.
async function collectAvailableMemoryBytes(): Promise<number> {
  if (process.platform === "linux") {
    try {
      const { readFile } = await import("node:fs/promises");
      const meminfo = await readFile("/proc/meminfo", "utf8");
      const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (m) return Number(m[1]) * 1024;
      // Pre-3.14 kernels don't have MemAvailable, so approximate it from the
      // pieces the kernel itself uses to compute it.
      const grab = (key: string): number => {
        const r = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
        return r ? Number(r[1]) * 1024 : 0;
      };
      return grab("MemFree") + grab("Buffers") + grab("Cached") + grab("SReclaimable");
    } catch {
      return freemem();
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("vm_stat", [], { timeout: 2000 });
      // First line: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
      const pageSizeMatch = stdout.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
      const grab = (label: string): number => {
        const r = stdout.match(new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "m"));
        return r ? Number(r[1]) * pageSize : 0;
      };
      // Track Activity Monitor's "Memory Used." Anonymous pages cover both
      // resident app memory and the compressor's storage (compressed pages
      // are tagged anonymous, not file-backed), so we don't add "Pages
      // occupied by compressor" separately, which would double-count.
      // File-backed pages (both the active portion AM rolls into App Memory
      // and the inactive portion AM shows as "Cached Files") are treated as
      // available, since the kernel can re-read them from disk under pressure.
      const wired = grab("Pages wired down");
      const anonymous = grab("Anonymous pages");
      const used = wired + anonymous;
      if (used <= 0) return freemem();
      return Math.max(0, totalmem() - used);
    } catch {
      return freemem();
    }
  }
  return freemem();
}

async function collectVmStat(handle: VmHandle): Promise<VmStat | null> {
  try {
    const m = await handle.sandbox.metrics();
    const upper = await fileAllocatedBytes(upperExt4Path(handle.id));
    return {
      id: handle.id,
      role: handle.role,
      // Seed both with the guest figure. collectSandboxStats overwrites
      // cpuPercent with the host-process measurement when available.
      cpuPercent: m.cpuPercent,
      guestCpuPercent: m.cpuPercent,
      memoryBytes: m.memoryBytes,
      memoryLimitBytes: m.memoryLimitBytes,
      diskReadBytes: m.diskReadBytes,
      diskWriteBytes: m.diskWriteBytes,
      netRxBytes: m.netRxBytes,
      netTxBytes: m.netTxBytes,
      uptimeMs: m.uptimeMs,
      upperDiskBytes: upper,
    };
  } catch {
    return null;
  }
}

// Two separate slices of ~/.microsandbox:
//   - cache/: OCI image cache (extracted layer blobs, fsmeta, manifests).
//     Shared across VMs. The "win" of running multiple VMs from one image.
//   - sandboxes/: per-VM rootfs dirs. Live VMs' upper.ext4 files are
//     attributed to their VmStat row. Whatever else lives under sandboxes/
//     is orphaned data (an upper.ext4 from a VM that crashed before cleanup,
//     or transient runtime/log files of live VMs, small for the latter).
async function collectMicrosandboxDirTotals(): Promise<{
  imageCache: number;
  sandboxesTotal: number;
}> {
  const root = msbStateHome();
  const [imageCache, sandboxesTotal] = await Promise.all([
    dirAllocatedBytes(join(root, "cache")),
    dirAllocatedBytes(join(root, "sandboxes")),
  ]);
  return { imageCache, sandboxesTotal };
}

// Recursive `du` of the in-process registry's content+manifest store
// (`~/.local/share/isolade/registry/` by default). Cheap enough to run on
// each disk-cache tick. Size scales with blob count, not file count, since
// the store keeps one file per blob.
async function collectRegistryDiskBytes(): Promise<number> {
  return dirAllocatedBytes(registryDataDir());
}

// Background-refreshed snapshot of the slow disk metrics: recursive `du`
// over ~/.microsandbox/{cache,sandboxes} and the registry data dir. Each can
// take seconds on large hosts. Refreshing every ~30s keeps the /stats hot
// path snappy without lying much: these values change on the order of "a
// build finished" or "a VM rotated", not 2-second poll cycles.
//
// Cold start: snapshot() awaits the first refresh. start() kicks one off
// immediately, so by the time anyone hits /stats the cache is populated.
const DISK_CACHE_REFRESH_MS = 30_000;

interface DiskCacheValues {
  microsandboxImageCacheBytes: number;
  microsandboxSandboxesTotalBytes: number;
  registryDiskBytes: number;
}

export class StatsDiskCache {
  private values: DiskCacheValues | null = null;
  private inFlight: Promise<DiskCacheValues> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly intervalMs: number = DISK_CACHE_REFRESH_MS) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async snapshot(): Promise<DiskCacheValues> {
    if (this.values) return this.values;
    return this.refresh();
  }

  private async tick(): Promise<void> {
    try {
      await this.refresh();
    } catch {}
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  private refresh(): Promise<DiskCacheValues> {
    if (this.inFlight) return this.inFlight;
    const promise = (async () => {
      const [{ imageCache, sandboxesTotal }, registryDiskBytes] = await Promise.all([
        collectMicrosandboxDirTotals(),
        collectRegistryDiskBytes(),
      ]);
      const next: DiskCacheValues = {
        microsandboxImageCacheBytes: imageCache,
        microsandboxSandboxesTotalBytes: sandboxesTotal,
        registryDiskBytes,
      };
      this.values = next;
      return next;
    })();
    this.inFlight = promise;
    promise.finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    return promise;
  }
}

export interface CollectStatsDeps {
  vmManager: Pick<VmManager, "listVmHandles">;
  builderManager: Pick<BuilderManager, "currentBuilderHandle"> | null;
  diskCache: StatsDiskCache;
  cpuSampler: CpuSampler;
}

export async function collectSandboxStats(deps: CollectStatsDeps): Promise<SandboxStats> {
  const handles: VmHandle[] = deps.vmManager.listVmHandles().map((h) => ({
    id: h.id,
    role: "workspace",
    sandbox: h.sandbox,
  }));

  const builderHandle = deps.builderManager?.currentBuilderHandle();
  if (builderHandle) {
    handles.push({
      id: builderHandle.id,
      role: "builder",
      sandbox: builderHandle.sandbox,
    });
  }

  const [vmStats, buildkitCacheDiskBytes, hostMemoryAvailableBytes, hostDisk, diskCache] =
    await Promise.all([
      Promise.all(handles.map((h) => collectVmStat(h))).then((arr) =>
        arr.filter((s): s is VmStat => s !== null),
      ),
      fileAllocatedBytes(buildkitCacheDiskPath()),
      collectAvailableMemoryBytes(),
      collectHostDiskStats(),
      deps.diskCache.snapshot(),
    ]);

  // CPU figures come from the background sampler's latest tick (fixed ~1s
  // window) rather than being sampled inline, so host total and per-VM CPU
  // share one window and the os.cpus() delta isn't double-consumed.
  const cpu = deps.cpuSampler.snapshot();

  // Prefer the host-visible CPU cost (matches Activity Monitor), and keep the
  // guest figure as a fallback for VMs whose process we couldn't sample yet.
  for (const vm of vmStats) {
    const hostCpu = cpu.vmHostCpuByName.get(vm.id);
    if (hostCpu !== undefined) vm.cpuPercent = hostCpu;
  }

  // Orphaned = sandboxes/ total minus the upper.ext4 sizes attributed to
  // currently-live VMs. Done at request time (not in the cache) so a VM that
  // exited between refreshes doesn't get double-counted as orphaned for up
  // to 30s. Its upper.ext4 disappears from disk along with the VM itself.
  const liveUpperSum = vmStats.reduce((a, v) => a + v.upperDiskBytes, 0);
  const microsandboxOrphanedSandboxBytes = Math.max(
    0,
    diskCache.microsandboxSandboxesTotalBytes - liveUpperSum,
  );

  return {
    vms: vmStats,
    hostMemoryTotalBytes: totalmem(),
    hostMemoryFreeBytes: freemem(),
    hostMemoryAvailableBytes,
    hostDiskTotalBytes: hostDisk.total,
    hostDiskAvailableBytes: hostDisk.available,
    selfProcess: sandboxSelfSampler.sample(),
    hostCpuCount: cpus().length,
    hostCpuPercent: cpu.hostCpuPercent,
    microsandboxImageCacheBytes: diskCache.microsandboxImageCacheBytes,
    microsandboxOrphanedSandboxBytes,
    buildkitCacheDiskBytes,
    registryDiskBytes: diskCache.registryDiskBytes,
    collectedAtMs: Date.now(),
  };
}
