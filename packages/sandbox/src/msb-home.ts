// Isolated microsandbox state + binary resolution.
//
// isolade ships and drives its own microsandbox instance. Its *state* (the VM
// database, rootfs deltas, image cache, agent-relay sockets) must live under a
// isolade-owned directory rather than the shared `~/.microsandbox`.
// That isolation is what keeps our VMs out of a user's own `msb list`: listing
// reads `$MSB_HOME/db/msb.db`, so a distinct home is a distinct, independent,
// invisible database. There is no shared daemon. The home dir *is* the
// namespace.
//
// Two locations are involved and must NOT be conflated:
//
//   * STATE HOME (`$MSB_HOME`): where microsandbox writes everything. We point
//     it at `~/.local/state/isolade/msb` (XDG_STATE_HOME). microsandbox hashes
//     the agent-relay socket name (`$MSB_HOME/run/agent/<32-hex>.sock`), so the
//     path stays well under the platform's `sun_path` limit (~86 of 104 bytes
//     on macOS) despite the longer root.
//
//   * BINARY DIR: where the `msb` executable lives. microsandbox's own binary
//     lookup falls back to `$MSB_HOME/bin/msb`, so the moment we move the home
//     off `~/.microsandbox` that fallback misses. We compensate by pinning
//     `MSB_PATH` to the real binary. libkrunfw is then found automatically as a
//     sibling of it (`<bin>/../lib/`), so it needs no separate wiring.
//
// The setup runs as an import side effect (`applyMsbEnv()` at the bottom) so any
// module that touches the home (vms, builder, stats) gets a consistent view
// simply by importing from here, regardless of which file is the process entry
// point (main.ts for `bun run dev` and the compiled sidecar, index.ts for the
// Tauri dev spawn). Setting the vars before the first `Sandbox.*` call or `msb`
// spawn is sufficient: microsandbox resolves its home lazily, per call.

import { dlopen, FFIType } from "bun:ffi";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, excludeFromBackup, stateDir } from "@isolade/shared/node/xdg";

/**
 * Absolute path to isolade's isolated microsandbox state home. Driven by the
 * isolade-specific ISOLADE_MSB_HOME, NOT by an inherited MSB_HOME, which a
 * user's microsandbox install may export and which we must override to stay
 * isolated. applyMsbEnv() copies this into MSB_HOME for the SDK.
 *
 * Lives under XDG_STATE_HOME: persistent machine-local VM state (db, per-VM
 * upper.ext4, the image cache that backs running VMs' rootfs). Not backed up
 * (see applyMsbEnv), but never in a cache dir, because running VMs depend on it.
 */
export function msbStateHome(): string {
  return process.env.ISOLADE_MSB_HOME || join(stateDir(), "msb");
}

/**
 * Directory holding the `msb` binary (with libkrunfw as a sibling `../lib/`).
 * Both run modes use a self-contained "msb runtime" assembled by
 * scripts/lib/assemble-msb-runtime.sh. isolade ships its own microsandbox and
 * never depends on a separate `~/.microsandbox` install:
 *   - release: lib.rs sets ISOLADE_MSB_BIN_DIR to the bundled `.app` location.
 *   - dev:     dev.sh assembles into app/binaries/msb-runtime (gitignored build
 *     artifact, shared with the release bundle) and sets ISOLADE_MSB_BIN_DIR.
 * The env var is set by both entry points in practice. The fallback resolves
 * that same dev artifact relative to the repo root (the sidecar's cwd in dev).
 */
export function msbBinDir(): string {
  return (
    process.env.ISOLADE_MSB_BIN_DIR || join(process.cwd(), "app", "binaries", "msb-runtime", "bin")
  );
}

// microsandbox's NAPI engine reads MSB_HOME / MSB_PATH via native getenv at
// call time (crates/utils resolve_home, and the MSB_PATH lookup). Bun does NOT
// propagate JS `process.env` writes to in-process native getenv. This was
// verified via FFI, so a plain `process.env.X = …` is invisible to the engine.
// We instead
// set the *real* libc environment via setenv (and process.env too, for JS-land
// readers). This lets the TS layer own these paths: the launcher (lib.rs /
// dev-common.sh) no longer presets MSB_HOME / MSB_PATH, only ISOLADE_MSB_BIN_DIR
// (the binary location it alone knows) and, in release, the dlopen-time
// NAPI_RS_NATIVE_LIBRARY_PATH.
let nativeSetenv: ((name: string, value: string) => void) | null | undefined;
function realEnvSetter(): ((name: string, value: string) => void) | null {
  if (nativeSetenv !== undefined) return nativeSetenv;
  try {
    const libc = dlopen(
      process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
      {
        setenv: {
          args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
          returns: FFIType.i32,
        },
      },
    );
    nativeSetenv = (name, value) => {
      libc.symbols.setenv(Buffer.from(`${name}\0`), Buffer.from(`${value}\0`), 1);
    };
  } catch {
    // No FFI/libc (unexpected on macOS/Linux): fall back to process.env only.
    nativeSetenv = null;
  }
  return nativeSetenv;
}

/** Set both process.env (JS readers) and the real libc env (native getenv). */
function setRealEnv(name: string, value: string): void {
  process.env[name] = value;
  realEnvSetter()?.(name, value);
}

let applied = false;

/**
 * Pin `MSB_HOME` (state) and `MSB_PATH` (binary) into the *real* process
 * environment (via setRealEnv). The in-process NAPI engine reads them with
 * native getenv, and any spawned `msb` subprocess reads them too, so both agree
 * on an isolated, isolade-owned layout. Idempotent.
 */
export function applyMsbEnv(): void {
  if (applied) return;
  applied = true;

  const home = msbStateHome();
  // microsandbox would create the home lazily, but stats collection walks
  // `$MSB_HOME/{cache,sandboxes}` on boot before any VM exists, so ensure it's
  // there. Best-effort: a genuinely unusable home surfaces later as a clear
  // microsandbox error rather than crashing module load here.
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    // ignore, see above
  }
  // Mark isolade's two heavy, non-backup roots excluded from Time Machine at
  // the earliest point both processes hit. State (this VM home: churny
  // upper.ext4, git is source of truth) and cache (regenerable buildkit disk +
  // workspace caches) should never bloat hourly backups. This is idempotent and
  // macOS-only. On a directory it covers the whole subtree, including files
  // microsandbox creates later. mkdir cacheDir first so the exclusion sticks.
  try {
    mkdirSync(cacheDir(), { recursive: true });
  } catch {
    // ignore, see above
  }
  excludeFromBackup(stateDir());
  excludeFromBackup(cacheDir());
  // Own MSB_HOME outright, overriding any value inherited from the shell. A
  // microsandbox install exports its own and we must not adopt it. setRealEnv
  // (not plain process.env) so the native engine's getenv actually sees it.
  setRealEnv("MSB_HOME", home);

  // Likewise pin MSB_PATH to our runtime's binary, overriding an inherited
  // MSB_PATH (the installer points one at ~/.microsandbox, which may not even
  // exist). Redirect via ISOLADE_MSB_BIN_DIR. If our binary is absent we leave
  // MSB_PATH alone so microsandbox's own resolution still has a chance.
  const msb = join(msbBinDir(), "msb");
  if (existsSync(msb)) setRealEnv("MSB_PATH", msb);
}

applyMsbEnv();
