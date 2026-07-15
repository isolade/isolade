import { z } from "zod";
import { networkConfigSchema } from "./api";
import { secretInjectModeSchema } from "./base";
import { portForwardSchema } from "./domain";

export const sandboxVolumeSchema = z.object({
  // Path inside the guest. May start with ~/ or $HOME/, resolved against
  // the image's runtime HOME on the sandbox side.
  guestPath: z.string().min(1),
  // Absolute host directory bind-mounted at guestPath. Caller is
  // responsible for creating it.
  hostPath: z.string().min(1),
});

// Per-secret entry: exposes `env` inside the guest. `inject` (see
// SECRET_INJECT_MODES) selects delivery:
//   - headers / full: the proxy substitutes the real value into requests bound
//     for `hosts` (headers only, or anywhere in the request). Entries may
//     contain `*` wildcards (e.g. "*.example.com"), and literal hosts match exactly.
//   - env: the real value is set as a plain guest env var. `hosts` is empty and
//     unused.
export const sandboxSecretSchema = z.object({
  env: z.string().min(1),
  value: z.string().min(1),
  hosts: z.array(z.string().min(1)),
  inject: secretInjectModeSchema.default("headers"),
});

export const sandboxVmCreateRequestSchema = z.object({
  image: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  hostPorts: z.array(z.number().int().positive()).optional(),
  ports: z.array(z.object({ remote: z.number() })).optional(),
  volumes: z.array(sandboxVolumeSchema).optional(),
  secrets: z.array(sandboxSecretSchema).optional(),
  // Global network posture. Absent → the sandbox applies the "open internet,
  // no local/host access" default, matching pre-feature behavior.
  network: networkConfigSchema.optional(),
});

export const sandboxVmCreateResponseSchema = z.object({
  id: z.string(),
  ports: z.array(portForwardSchema),
});

export const sandboxExecResponseSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
});

export const sandboxExecStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({ type: z.literal("exit"), exitCode: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export const terminalResizeMessageSchema = z.object({
  type: z.literal("resize"),
  rows: z.number(),
  cols: z.number(),
});

export const vmStatSchema = z.object({
  id: z.string(),
  role: z.enum(["workspace", "builder"]),
  // The VM's CPU cost as the host sees it (sampled from the VMM process's
  // CPU time) on a 0..(cores*100) scale, matching what Activity Monitor
  // shows for the `msb` process. Falls back to `guestCpuPercent` when the
  // process can't be sampled.
  cpuPercent: z.number(),
  // Guest-only vCPU busy time reported by microsandbox
  // (hv_vcpu_get_exec_time). Excludes virtualization, device-emulation and
  // I/O overhead, so it reads lower than `cpuPercent`. Kept for callers that
  // want in-VM utilization rather than host cost.
  guestCpuPercent: z.number(),
  memoryBytes: z.number(),
  memoryLimitBytes: z.number(),
  diskReadBytes: z.number(),
  diskWriteBytes: z.number(),
  netRxBytes: z.number(),
  netTxBytes: z.number(),
  uptimeMs: z.number(),
  upperDiskBytes: z.number(),
});

export const processStatSchema = z.object({
  name: z.string(),
  pid: z.number(),
  cpuPercent: z.number(),
  memoryBytes: z.number(),
});

export const sandboxStatsSchema = z.object({
  vms: z.array(vmStatSchema),
  hostMemoryTotalBytes: z.number(),
  hostMemoryFreeBytes: z.number(),
  hostMemoryAvailableBytes: z.number(),
  hostCpuCount: z.number(),
  hostCpuPercent: z.number(),
  hostDiskTotalBytes: z.number(),
  hostDiskAvailableBytes: z.number(),
  selfProcess: processStatSchema,
  microsandboxImageCacheBytes: z.number(),
  microsandboxOrphanedSandboxBytes: z.number(),
  buildkitCacheDiskBytes: z.number(),
  registryDiskBytes: z.number(),
  collectedAtMs: z.number(),
});

export const resourceStatsSchema = sandboxStatsSchema
  .extend({
    workspaceCheckoutsBytes: z.number(),
    workspaceCachesBytes: z.number(),
    databaseBytes: z.number(),
    services: z.array(processStatSchema),
  })
  .omit({ selfProcess: true });

export const jsonRpcErrorSchema = z.object({
  message: z.string(),
});

export const jsonRpcResponseSchema = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
});

export const jsonRpcNotificationSchema = z.object({
  method: z.string(),
  params: z.unknown().optional(),
});

export const jsonRpcMessageSchema = z.union([jsonRpcResponseSchema, jsonRpcNotificationSchema]);

export type SandboxVolume = z.infer<typeof sandboxVolumeSchema>;
export type SandboxSecret = z.infer<typeof sandboxSecretSchema>;
export type SandboxVmCreateRequest = z.infer<typeof sandboxVmCreateRequestSchema>;
export type SandboxVmCreateResponse = z.infer<typeof sandboxVmCreateResponseSchema>;
export type SandboxExecResponse = z.infer<typeof sandboxExecResponseSchema>;
export type SandboxExecStreamMessage = z.infer<typeof sandboxExecStreamMessageSchema>;
export type TerminalResizeMessage = z.infer<typeof terminalResizeMessageSchema>;
export type VmStat = z.infer<typeof vmStatSchema>;
export type ProcessStat = z.infer<typeof processStatSchema>;
export type SandboxStats = z.infer<typeof sandboxStatsSchema>;
export type ResourceStats = z.infer<typeof resourceStatsSchema>;
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
