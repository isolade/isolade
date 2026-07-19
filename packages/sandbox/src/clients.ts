import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOST_CLIENT_ID } from "@isolade/shared";
import { stateDir } from "@isolade/shared/node/xdg";

// Per-client image retention and VM ownership for the shared sandbox runtime.
//
// The sandbox is driven by more than one isolade server at a time: the host's
// in-process server, and any `expose_sandbox` dev VM whose nested isolade
// reaches the same runtime over the reverse forward (isolade within isolade).
// Each of those servers memoizes image refs in its OWN database, so a GC that
// sweeps the shared cache down to one caller's keep-set deletes every other
// caller's images (the "mutual clobber"). This registry is the fix: each
// client REGISTERS the refs it needs, and sweeps only ever collect what is
// outside the UNION of all registered keep-sets.
//
// Ownership (vmId → clientId) exists so that deleting a client (its dev VM was
// removed) can cascade: destroy the VMs it created and drop its keep-set, at
// which point the next sweep reclaims the images only it was retaining.
// Host-owned VMs are deliberately NOT recorded: the host's own database is
// their lifecycle authority, and recording them would only add file churn.
//
// Consistency model: leak, never clobber. State is a single small JSON file
// under stateDir(), rewritten atomically (tmp + rename) on every mutation and
// re-read on every operation, so it survives process restarts and needs no
// in-memory singleton (tests re-root XDG per suite and just work). If the file
// is corrupt it is set aside and treated as empty — the same state as a fresh
// install, which every live client heals on its next boot/build GC.

// Re-exported so sandbox-side consumers keep one import site; the constant
// itself is a wire value and lives with the wire schema in @isolade/shared.
export { HOST_CLIENT_ID };

interface ClientsFile {
  version: 1;
  /** clientId → the image refs that client needs retained. */
  clients: Record<string, { keep: string[] }>;
  /** vmId → owning clientId (non-host clients only). */
  vms: Record<string, string>;
}

const EMPTY: ClientsFile = { version: 1, clients: {}, vms: {} };

function storePath(): string {
  return join(stateDir(), "sandbox-clients.json");
}

function load(): ClientsFile {
  const path = storePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return structuredClone(EMPTY);
  }
  try {
    const parsed = JSON.parse(raw) as ClientsFile;
    if (parsed?.version !== 1 || typeof parsed.clients !== "object" || !parsed.clients) {
      throw new Error("unexpected shape");
    }
    return {
      version: 1,
      clients: parsed.clients ?? {},
      vms: parsed.vms ?? {},
    };
  } catch (err) {
    // Set the corrupt file aside (don't silently destroy evidence) and start
    // empty. Live clients re-register on their next GC, so this converges.
    console.warn(`[sandbox-clients] corrupt ${path}, resetting:`, err);
    try {
      renameSync(path, `${path}.corrupt`);
    } catch {
      rmSync(path, { force: true });
    }
    return structuredClone(EMPTY);
  }
}

function save(data: ClientsFile): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Replace a client's keep-set with `keep` (registration, not a sweep). */
export function setKeepSet(clientId: string, keep: readonly string[]): void {
  const data = load();
  data.clients[clientId] = { keep: [...new Set(keep)] };
  save(data);
}

/** Add a single ref to a client's keep-set (freshly built image). Runs inside
 * the builder's opChain slot so the ref is protected before any later-queued
 * sweep computes its union. */
export function addToKeepSet(clientId: string, ref: string): void {
  const data = load();
  const entry = data.clients[clientId] ?? { keep: [] };
  if (!entry.keep.includes(ref)) entry.keep.push(ref);
  data.clients[clientId] = entry;
  save(data);
}

/** The union of every registered client's keep-set: the only refs a sweep may
 * NOT collect. */
export function keepUnion(): string[] {
  const data = load();
  const union = new Set<string>();
  for (const entry of Object.values(data.clients)) {
    for (const ref of entry.keep) union.add(ref);
  }
  return [...union];
}

/** Record which client created a VM. Host-owned VMs are not recorded (the host
 * database is their lifecycle authority). */
export function recordVmOwner(vmId: string, clientId: string): void {
  if (!clientId || clientId === HOST_CLIENT_ID) return;
  const data = load();
  data.vms[vmId] = clientId;
  save(data);
}

/** Forget a VM's ownership entry (VM removed, by whoever). */
export function dropVmOwner(vmId: string): void {
  const data = load();
  if (!(vmId in data.vms)) return;
  delete data.vms[vmId];
  save(data);
}

/** Every VM the given client created (and that still exists as far as this
 * registry knows). */
export function vmsOwnedBy(clientId: string): string[] {
  const data = load();
  return Object.entries(data.vms)
    .filter(([, owner]) => owner === clientId)
    .map(([vmId]) => vmId);
}

/** Every client id with a keep-set or an owned VM, the host included. The host
 * server reconciles this against its instances table at boot to retry client
 * removals a crash or failed cascade left behind. */
export function listClientIds(): string[] {
  const data = load();
  return [...new Set([...Object.keys(data.clients), ...Object.values(data.vms)])];
}

/** Drop a client entirely: its keep-set and any remaining VM-ownership rows.
 * The caller is responsible for having removed (or deliberately kept) the VMs
 * themselves, and for running a sweep afterwards. */
export function removeClientEntry(clientId: string): void {
  const data = load();
  delete data.clients[clientId];
  for (const [vmId, owner] of Object.entries(data.vms)) {
    if (owner === clientId) delete data.vms[vmId];
  }
  save(data);
}
