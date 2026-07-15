import { existsSync, readFileSync } from "node:fs";
import { writeConfigTable } from "./config-editor";
import { type NetworkConfig, networkConfigSchema } from "./contracts";
import { networkTableSchema, profileConfigSchema } from "./profile-config";

// Per-profile sandbox network policy, applied to every instance VM the profile
// creates. It lives in the profile's config.toml as a `[network]` table (so it's
// git-checkable, UI-editable, and comment-preserving like the rest of the
// profile), read/written through config-editor. Nothing here is secret.
//
// The on-disk table uses config.toml's snake_case (`allowed_domains`, …); the
// API-facing shape (NetworkConfig, @isolade/shared) is camelCase. This store is
// the single place the two are mapped.
//
// The rule-construction that consumes the config lives in
// VmManager.buildNetworkPolicy (packages/sandbox/src/vms.ts).

// The default reproduces the historical hard-coded behavior: open internet, no
// local/host access. Parsing `{}` fills every field from its schema default.
const DEFAULT: NetworkConfig = networkConfigSchema.parse({});

type NetworkTable = ReturnType<typeof networkTableSchema.parse>;

function tableToConfig(table: NetworkTable): NetworkConfig {
  return {
    internet: table.internet,
    allowedDomains: table.allowed_domains,
    allowLocalNetwork: table.allow_local_network,
    allowHost: table.allow_host,
    ports: table.ports,
    hostPorts: table.host_ports,
  };
}

function configToTable(config: NetworkConfig): Record<string, unknown> {
  return {
    internet: config.internet,
    allowed_domains: config.allowedDomains,
    allow_local_network: config.allowLocalNetwork,
    allow_host: config.allowHost,
    ports: config.ports,
    host_ports: config.hostPorts,
  };
}

export class NetworkConfigStore {
  constructor(private configPath: string) {}

  /** Current config. Never throws: an absent / unreadable / corrupt file (or a
   * config without a `[network]` table) reads as the default posture so VM
   * creation always has something to apply. */
  read(): NetworkConfig {
    if (!existsSync(this.configPath)) return { ...DEFAULT };
    try {
      const parsed = profileConfigSchema.parse(
        Bun.TOML.parse(readFileSync(this.configPath, "utf-8")) ?? {},
      );
      return parsed.network ? tableToConfig(parsed.network) : { ...DEFAULT };
    } catch {
      return { ...DEFAULT };
    }
  }

  /** Validate and persist the config, returning the parsed (normalized) value.
   * The merge preserves comments on the table's keys, so writing edits values in
   * place rather than rewriting the block. */
  write(config: NetworkConfig): NetworkConfig {
    const parsed = networkConfigSchema.parse(config);
    writeConfigTable(this.configPath, "network", configToTable(parsed));
    return parsed;
  }
}
