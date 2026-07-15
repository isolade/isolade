import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSocket, GitConfigStatus, SigningKeysResult } from "./contracts";
import {
  type GitConfigStore,
  gitIdentitySchema,
  type SigningConfig,
  signingConfigSchema,
} from "./git-config-store";

// Owns the git configuration applied to agent VMs:
//   * the committer identity (applied to every commit, signed or not), and
//   * optional commit signing through the user's SSH agent.
//
// Signing detail: agent VMs can't reach the user's Secretive key (Secure
// Enclave, host-only, presence-gated), and we deliberately never put a private
// key in the VM. The VM's git is pointed at a thin shim (sign-shim.ts) that
// hands the bytes-to-sign to an in-VM broker over a VM-local unix socket. The
// broker relays them to the host over the microsandbox exec channel
// (sign-broker.ts), where this manager signs through the SSH agent and returns
// the SSHSIG. No host network egress, no port, no bind mount. The private key
// never leaves the agent. We only ask it to sign with one specific public key
// in the `git` namespace, so a VM can never coax it into signing as the user's
// personal identity or producing an SSH *auth* signature.

/** Secretive's well-known per-user agent socket on macOS. Users commonly run a
 * different agent (gpg-agent, the macOS ssh-agent) as their primary
 * SSH_AUTH_SOCK and Secretive only for signing, so we look here explicitly
 * rather than trusting SSH_AUTH_SOCK to point at it. */
export const SECRETIVE_SOCKET = join(
  homedir(),
  "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh",
);

/** A human label inferred from a socket path, for the UI picker. */
function labelForSocket(path: string): string {
  if (path.includes("Secretive")) return "Secretive";
  if (path.includes("gnupg") || path.includes("gpg-agent")) return "gpg-agent";
  if (path.includes("com.apple.launchd")) return "macOS ssh-agent";
  return "SSH_AUTH_SOCK";
}

/** Rank candidate agent sockets, Secretive first (this feature is built around
 * it), then the session's SSH_AUTH_SOCK. Pure so it's unit-tested. The real
 * lookup is detectAgentSockets below. */
export function rankAgentSockets(input: {
  sshAuthSock: string | null;
  secretiveExists: boolean;
}): AgentSocket[] {
  const out: AgentSocket[] = [];
  if (input.secretiveExists) out.push({ path: SECRETIVE_SOCKET, label: "Secretive" });
  if (input.sshAuthSock && input.sshAuthSock !== SECRETIVE_SOCKET) {
    out.push({
      path: input.sshAuthSock,
      label: labelForSocket(input.sshAuthSock),
    });
  }
  return out;
}

/** Agent sockets present on this host, Secretive first. */
function detectAgentSockets(): AgentSocket[] {
  return rankAgentSockets({
    sshAuthSock: process.env.SSH_AUTH_SOCK || null,
    secretiveExists: existsSync(SECRETIVE_SOCKET),
  });
}

/** The socket to default the UI to: Secretive if it's present, else the
 * session's SSH_AUTH_SOCK. */
function defaultSocketPath(): string | null {
  return detectAgentSockets()[0]?.path ?? null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).
// ---------------------------------------------------------------------------

/** OpenSSH SHA256 fingerprint of a public-key line ("type base64 [comment]"),
 * computed in-process so we don't spawn ssh-keygen per key. Matches
 * `ssh-keygen -lf`'s `SHA256:…` form (base64 of sha256(keyblob), no padding). */
export function sshFingerprint(pubkeyLine: string): string | null {
  const b64 = pubkeyLine.trim().split(/\s+/)[1];
  if (!b64) return null;
  let blob: Buffer;
  try {
    blob = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (blob.length === 0) return null;
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

export interface AgentKey {
  /** Full original line: "type base64 [comment]". */
  line: string;
  type: string;
  comment: string;
  fingerprint: string | null;
}

const KEY_TYPE_RE = /^(ssh-|sk-|ecdsa-)/;

/** Parse `ssh-add -L` output into the keys the agent holds. Skips status lines
 * like "The agent has no identities." */
export function parseAgentKeys(stdout: string): AgentKey[] {
  const out: AgentKey[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const [type, b64, ...rest] = parts;
    if (!type || !b64 || !KEY_TYPE_RE.test(type)) continue;
    out.push({
      line,
      type,
      comment: rest.join(" "),
      fingerprint: sshFingerprint(`${type} ${b64}`),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Host / agent interaction.
// ---------------------------------------------------------------------------

function readGitGlobal(key: string): string {
  try {
    return execFileSync("git", ["config", "--global", key], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

/** The host's own git identity, used as the default committer identity and to
 * prefill the UI. Either field may be empty if the host hasn't set it. Null
 * only when neither is set. */
function detectHostIdentity(): { name: string; email: string } | null {
  const name = readGitGlobal("user.name");
  const email = readGitGlobal("user.email");
  if (!name && !email) return null;
  return { name, email };
}

/** Probe an agent socket. Distinguishes "reachable but empty" (ssh-add exit 1)
 * from "can't connect" (exit 2 / spawn error). */
function probeAgent(socketPath: string): {
  reachable: boolean;
  keys: AgentKey[];
} {
  const res = spawnSync("ssh-add", ["-L"], {
    env: { ...process.env, SSH_AUTH_SOCK: socketPath },
    encoding: "utf-8",
  });
  if (res.error || res.status === 2) return { reachable: false, keys: [] };
  return { reachable: true, keys: parseAgentKeys(res.stdout ?? "") };
}

/** Sign `payload` through the agent with one specific public key, in the `git`
 * namespace. Throws if the agent doesn't hold the matching private key or the
 * socket is unreachable. `-U` forces agent-backed signing (the key file is the
 * PUBLIC half, and the private half is fetched from the agent), so no private key
 * ever touches disk. */
export function signWithAgent(
  payload: Buffer,
  opts: { signingKey: string; socketPath: string },
): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "isolade-sign-"));
  try {
    const keyFile = join(dir, "key.pub");
    const dataFile = join(dir, "data");
    writeFileSync(keyFile, `${opts.signingKey.trim()}\n`);
    writeFileSync(dataFile, payload);
    execFileSync("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", keyFile, "-U", dataFile], {
      env: { ...process.env, SSH_AUTH_SOCK: opts.socketPath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    return readFileSync(`${dataFile}.sig`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fingerprint of the host's own git signing key (user.signingkey), if it's an
 * SSH key, used to warn when the user picks their personal key as the agent
 * key. Accepts a literal key or a path to a (public) key file. */
function hostSigningKeyFingerprint(): string | null {
  const value = readGitGlobal("user.signingkey");
  if (!value) return null;
  if (KEY_TYPE_RE.test(value)) return sshFingerprint(value);
  for (const p of [value.endsWith(".pub") ? value : `${value}.pub`, value]) {
    try {
      return sshFingerprint(readFileSync(p, "utf-8"));
    } catch {
      // try next
    }
  }
  return null;
}

// API-facing shapes (GitConfigStatus / SigningKeysResult / SigningKeyInfo) are
// defined once as zod schemas in @isolade/shared and imported above, so the
// values this manager returns stay compiler-locked to what the web parses.

// ---------------------------------------------------------------------------
// Manager: the signing oracle + the config-driven API surface. The per-VM
// transport (exec-stream broker) lives in sign-broker.ts and is driven by
// InstanceManager, which calls signPayload() for each request.
// ---------------------------------------------------------------------------

export class GitConfigManager {
  constructor(private store: GitConfigStore) {}

  /** Sign a commit payload with the currently-enabled agent key, in the `git`
   * namespace. Called by the host side of the exec-stream broker
   * (sign-broker.ts) for each request a VM's shim forwards. Throws when signing
   * isn't enabled (the broker relays that to the shim as an error). */
  signPayload(payload: Buffer): Buffer {
    const sig = this.store.read().signing;
    if (!sig || !sig.enabled) throw new Error("commit signing is not enabled");
    return signWithAgent(payload, {
      signingKey: sig.signingKey,
      socketPath: sig.socketPath,
    });
  }

  // ---- API surface (consumed by app.ts routes) ----

  status(): GitConfigStatus {
    const cfg = this.store.read();
    const sig = cfg.signing;
    const socketPath = sig?.socketPath ?? defaultSocketPath();
    const agentReachable = socketPath ? probeAgent(socketPath).reachable : false;
    const detectedSockets = detectAgentSockets();
    return {
      identity: cfg.identity,
      hostIdentity: detectHostIdentity(),
      signing: sig
        ? {
            enabled: sig.enabled,
            configured: true,
            socketPath: sig.socketPath,
            detectedSockets,
            key: {
              pubkey: sig.signingKey,
              comment: sig.signingKey.trim().split(/\s+/).slice(2).join(" "),
              fingerprint: sshFingerprint(sig.signingKey),
            },
            agentReachable,
          }
        : {
            enabled: false,
            configured: false,
            socketPath,
            detectedSockets,
            key: null,
            agentReachable,
          },
    };
  }

  /** Keys the agent advertises, for the UI key picker. `socketPath` lets the UI
   * preview a not-yet-saved socket, falling back to the stored / session one. */
  listKeys(socketPath?: string): SigningKeysResult {
    const sock = socketPath || this.store.read().signing?.socketPath || defaultSocketPath();
    if (!sock) return { reachable: false, socketPath: null, keys: [] };
    const { reachable, keys } = probeAgent(sock);
    const hostFp = hostSigningKeyFingerprint();
    return {
      reachable,
      socketPath: sock,
      keys: keys.map((k) => ({
        pubkey: k.line,
        comment: k.comment,
        fingerprint: k.fingerprint,
        isHostSigningKey: hostFp != null && k.fingerprint === hostFp,
      })),
    };
  }

  /** Set the committer identity (applied to every VM). */
  setIdentity(body: unknown): GitConfigStatus {
    this.store.setIdentity(gitIdentitySchema.parse(body));
    return this.status();
  }

  /** Persist the signing config. Running VMs read the live config per request
   * (key/socket changes take effect immediately). Enabling/disabling for a VM
   * that's already up takes effect on its next create/restart. */
  setSigning(body: unknown): GitConfigStatus {
    this.store.setSigning(signingConfigSchema.parse(body));
    return this.status();
  }

  /** Turn signing off (keeps the key/socket for easy re-enable). */
  disableSigning(): GitConfigStatus {
    const current = this.store.read().signing;
    if (current) this.store.setSigning({ ...current, enabled: false });
    return this.status();
  }

  /** Committer identity to apply to a VM: the configured one, else the host's.
   * Either field may be empty (host with only one set), null when neither. */
  effectiveIdentity(): { name: string; email: string } | null {
    return this.store.read().identity ?? detectHostIdentity();
  }

  /** Whether to wire signing into a VM right now: non-null only when signing is
   * enabled AND the agent socket is reachable, so an opted-in workspace whose
   * agent is down (Secretive not running, wrong socket) degrades to unsigned
   * commits rather than failing every commit. */
  resolveActiveSigning(): SigningConfig | null {
    const sig = this.store.read().signing;
    if (!sig || !sig.enabled) return null;
    if (!probeAgent(sig.socketPath).reachable) return null;
    return sig;
  }
}
