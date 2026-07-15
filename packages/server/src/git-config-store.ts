import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeConfigTable } from "./config-editor";
import { profileConfigSchema } from "./profile-config";

// Git configuration applied to agent VMs. Two independent parts:
//
//   identity  : the committer name/email recorded on EVERY commit an agent
//               makes, signed or not. Defaults to the host's git identity (see
//               detectHostIdentity in git-config.ts) but can be overridden here.
//   signing   : opt-in commit signing through the user's SSH agent (e.g.
//               Secretive). The private key never enters the VM. We persist
//               only the public key, the agent socket, and the on/off flag.
//
// Both live in the profile's config.toml as one flat `[git]` table (so the
// whole profile is a single git-checkable, UI-editable, comment-preserving
// file), read/written through config-editor. Identity and signing are two views
// of that one table; each setter reads the current pair and re-persists it, so
// updating one leaves the other's keys (and their comments) in place. Nothing
// here is secret; `signing_socket` is machine-specific and simply won't resolve
// on another machine, leaving signing off until reconfigured there.

export const gitIdentitySchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
});
export type GitIdentity = z.infer<typeof gitIdentitySchema>;

export const signingConfigSchema = z.object({
  enabled: z.boolean(),
  /** SSH agent socket we sign through (e.g. Secretive's socket on macOS). */
  socketPath: z.string().min(1),
  /** Dedicated signing key as an OpenSSH public-key line:
   * "ssh-ed25519 AAAA… agent@isolade". The private half stays in the agent. */
  signingKey: z.string().min(1),
});
export type SigningConfig = z.infer<typeof signingConfigSchema>;

const gitConfigSchema = z.object({
  identity: gitIdentitySchema.nullable().default(null),
  signing: signingConfigSchema.nullable().default(null),
});
export type GitConfig = z.infer<typeof gitConfigSchema>;

const EMPTY: GitConfig = { identity: null, signing: null };

// A parsed [git] table → the identity/signing pair. Identity needs both
// name+email; signing needs both a socket and a key (an incomplete half reads
// as "not configured" rather than throwing).
function tableToConfig(table: NonNullable<GitTable>): GitConfig {
  const identity: GitIdentity | null =
    table.name && table.email ? { name: table.name, email: table.email } : null;
  const signing: SigningConfig | null =
    table.signing_socket && table.signing_key
      ? {
          enabled: table.signing_enabled,
          socketPath: table.signing_socket,
          signingKey: table.signing_key,
        }
      : null;
  return { identity, signing };
}

// The identity/signing pair → a flat [git] table, or undefined when neither is
// configured (so the table is dropped rather than left empty).
function configToTable(config: GitConfig): Record<string, unknown> | undefined {
  const obj: Record<string, unknown> = {};
  if (config.identity) {
    obj.name = config.identity.name;
    obj.email = config.identity.email;
  }
  if (config.signing) {
    obj.signing_enabled = config.signing.enabled;
    obj.signing_socket = config.signing.socketPath;
    obj.signing_key = config.signing.signingKey;
  }
  return Object.keys(obj).length ? obj : undefined;
}

type GitTable = ReturnType<typeof profileConfigSchema.parse>["git"];

export class GitConfigStore {
  constructor(private configPath: string) {}

  /** Current config. Never null: an absent / unreadable / corrupt file (or a
   * config without a `[git]` table) reads as "nothing configured" so callers
   * fall back to host defaults. */
  read(): GitConfig {
    if (!existsSync(this.configPath)) return { ...EMPTY };
    try {
      const parsed = profileConfigSchema.parse(
        Bun.TOML.parse(readFileSync(this.configPath, "utf-8")) ?? {},
      );
      return parsed.git ? tableToConfig(parsed.git) : { ...EMPTY };
    } catch {
      return { ...EMPTY };
    }
  }

  /** True only when signing is configured AND turned on. */
  isSigningEnabled(): boolean {
    return this.read().signing?.enabled === true;
  }

  private writeAll(config: GitConfig): GitConfig {
    const parsed = gitConfigSchema.parse(config);
    writeConfigTable(this.configPath, "git", configToTable(parsed));
    return parsed;
  }

  /** Set (or clear, with null) the committer identity, leaving signing intact. */
  setIdentity(identity: GitIdentity | null): GitConfig {
    return this.writeAll({ ...this.read(), identity });
  }

  /** Set (or clear, with null) the signing config, leaving identity intact. */
  setSigning(signing: SigningConfig | null): GitConfig {
    return this.writeAll({ ...this.read(), signing });
  }

  /** Forget everything (drops the `[git]` table). */
  clear(): void {
    writeConfigTable(this.configPath, "git", undefined);
  }
}
