import { z } from "zod";

// A profile's build status: pending until first built, building while its image
// is rebuilding, ready once a build has succeeded, error on failure.
export const PROFILE_STATUSES = ["pending", "building", "ready", "error"] as const;
// "initializing": the VM has booted but the profile's sync initializers
// (config.toml `[setup]`/`[start]` sync steps) are still running, and chat turns
// wait for them to finish before the agent runs. See InstanceManager.runInit.
export const INSTANCE_STATUSES = [
  "initializing",
  "running",
  "stopped",
  "restarting",
  "error",
] as const;
export const CHAT_PROVIDERS = ["anthropic", "openai"] as const;
export const CHAT_MESSAGE_ROLES = ["user", "assistant"] as const;
// How the sandbox network policy treats public-internet egress:
//   open:      every public destination is reachable.
//   allowlist: only an approved set of domains (plus the always-on agent
//               essentials) is reachable, and everything else is denied.
export const INTERNET_ACCESS = ["open", "allowlist"] as const;
// How a declared secret's value is delivered to the guest:
//   headers: the egress proxy substitutes the value into outbound request
//             HEADERS only (including the Basic-Auth credential). The real value
//             never enters the VM. The safe default.
//   full:     the proxy substitutes it anywhere in the outbound request:
//             headers, query string, and body. The real value never enters the
//             VM, but it can land in URLs/bodies the destination logs.
//   env:      the REAL value is injected as a plain guest environment variable.
//             No proxy, no substitution: the value lives inside the VM and any
//             process there can read it. For secrets the agent must use locally
//             (signing keys, non-HTTP credentials) where substitution can't help.
//             Opts this secret out of the "secretless" model. `headers`/`full`
//             keep it, but `env` does not. `hosts` are meaningless in this mode.
export const SECRET_INJECT_MODES = ["headers", "full", "env"] as const;

// The guest working directory every instance VM boots into (set as WORKDIR at
// image build time, see packages/server/src/build-context.ts). It's the root
// the file-tree browses and the base "relative" paths are computed against, so
// it lives here as the single source of truth shared by the server file routes
// and the web file tree.
export const WORKSPACE_ROOT = "/workspace";

export const profileStatusSchema = z.enum(PROFILE_STATUSES);
export const instanceStatusSchema = z.enum(INSTANCE_STATUSES);
export const chatProviderSchema = z.enum(CHAT_PROVIDERS);
export const chatMessageRoleSchema = z.enum(CHAT_MESSAGE_ROLES);
// Reasoning effort is a free-form, provider-defined string, not a fixed enum:
// codex advertises efforts per model as open-ended strings ("a non-empty
// reasoning effort value advertised by the model"), and Claude has its own
// fixed set. Each model declares the subset it accepts via
// ChatModelDefinition.supportedEfforts, and that per-model list — not a global
// enum — is what create/patch validate against, so a new codex tier needs no
// change here. Backends map/clamp as needed (Claude drops non-Claude tiers;
// codex clamps to the nearest via `nearest_effort`).
export const chatEffortSchema = z.string().min(1);
export const internetAccessSchema = z.enum(INTERNET_ACCESS);
export const secretInjectModeSchema = z.enum(SECRET_INJECT_MODES);

export const dateLikeSchema = z
  .union([z.date(), z.string(), z.number()])
  .transform((value, ctx) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
      return z.NEVER;
    }
    return date;
  });

export type ProfileStatus = z.infer<typeof profileStatusSchema>;
export type InstanceStatus = z.infer<typeof instanceStatusSchema>;
export type ChatProvider = z.infer<typeof chatProviderSchema>;
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;
export type ChatEffort = z.infer<typeof chatEffortSchema>;
export type InternetAccess = z.infer<typeof internetAccessSchema>;
export type SecretInjectMode = z.infer<typeof secretInjectModeSchema>;
