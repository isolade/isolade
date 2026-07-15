import { existsSync, readFileSync } from "node:fs";
import { EMPTY_RUNTIME_CONFIG, type RuntimeConfig, runtimeConfigSchema } from "@isolade/shared";
import { writeConfigTable } from "./config-editor";
import { profileConfigSchema, runtimeTableSchema } from "./profile-config";

// Per-profile runtime posture — host-backed cache mounts plus the setup/start
// lifecycle phases — applied when the profile's instance VMs boot. It lives in
// the profile's config.toml as a `[runtime]` table (so it's git-checkable,
// UI-editable, and comment-preserving like the rest of the profile), read/
// written through config-editor. Nothing here is secret.
//
// `setup` and `start` are inline sub-tables in the table
// (`setup = { sync = […], async = […] }`), so the whole runtime posture stays
// in a single comment-preservable `[runtime]` block. Empty phases and empty
// caches are omitted so a cleared field drops its line rather than leaving
// `= []` behind, and an all-empty runtime drops the table entirely.
//
// The consuming resolution lives in loadProfileConfig (profile-config.ts):
// caches → CacheMount bind mounts, setup/start → the instance init phases.

type RuntimeTable = ReturnType<typeof runtimeTableSchema.parse>;

function tableToConfig(table: RuntimeTable): RuntimeConfig {
  return {
    caches: table.caches,
    setup: { sync: table.setup?.sync ?? [], async: table.setup?.async ?? [] },
    start: { sync: table.start?.sync ?? [], async: table.start?.async ?? [] },
  };
}

// A phase → an inline-table object, or undefined when both arrays are empty (so
// the sub-key is omitted rather than written as an empty `{ }`).
function phaseToObject(phase: {
  sync: string[];
  async: string[];
}): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (phase.sync.length) out.sync = phase.sync;
  if (phase.async.length) out.async = phase.async;
  return Object.keys(out).length ? out : undefined;
}

// The runtime config → a `[runtime]` table, or undefined when nothing is set (so
// the table is dropped rather than left bare).
function configToTable(config: RuntimeConfig): Record<string, unknown> | undefined {
  const obj: Record<string, unknown> = {};
  if (config.caches.length) obj.caches = config.caches;
  const setup = phaseToObject(config.setup);
  if (setup) obj.setup = setup;
  const start = phaseToObject(config.start);
  if (start) obj.start = start;
  return Object.keys(obj).length ? obj : undefined;
}

export class RuntimeConfigStore {
  constructor(private configPath: string) {}

  /** Current config. Never throws: an absent / unreadable / corrupt file (or a
   * config without a `[runtime]` table) reads as the empty posture. */
  read(): RuntimeConfig {
    if (!existsSync(this.configPath)) return structuredClone(EMPTY_RUNTIME_CONFIG);
    try {
      const parsed = profileConfigSchema.parse(
        Bun.TOML.parse(readFileSync(this.configPath, "utf-8")) ?? {},
      );
      return parsed.runtime ? tableToConfig(parsed.runtime) : structuredClone(EMPTY_RUNTIME_CONFIG);
    } catch {
      return structuredClone(EMPTY_RUNTIME_CONFIG);
    }
  }

  /** Validate and persist the config, returning the parsed (normalized) value.
   * The merge preserves comments on the table's keys. */
  write(config: RuntimeConfig): RuntimeConfig {
    const parsed = runtimeConfigSchema.parse(config);
    writeConfigTable(this.configPath, "runtime", configToTable(parsed));
    return parsed;
  }
}
