/**
 * Re-roots $HOME to a fresh tempdir so microsandbox uses an isolated state
 * directory (its sqlite db, image cache, and sandbox namespace all live under
 * $HOME/.microsandbox). Lets the integration tests run alongside ./dev.sh
 * without colliding on the shared SQLite db.
 *
 * Must be called BEFORE the first microsandbox API call. Pattern lifted from
 * microsandbox's own integration tests (test-utils/src/lib.rs).
 *
 * Note: Bun's `process.env.HOME = ...` does NOT call libc setenv, so NAPI
 * modules (microsandbox is one) keep reading the original HOME. We use FFI
 * to update libc's env table directly.
 */
import { dlopen, FFIType, suffix } from "bun:ffi";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// On glibc Linux the runtime object is the versioned `libc.so.6`. The bare
// `libc.so` is a linker script that only exists with dev packages installed
// (and dlopen can't load it anyway). macOS has plain `libc.dylib`.
function openLibc() {
  const symbols = {
    setenv: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
      returns: FFIType.i32,
    },
  } as const;
  try {
    return dlopen(`libc.${suffix}`, symbols);
  } catch (err) {
    if (process.platform !== "linux") throw err;
    return dlopen("libc.so.6", symbols);
  }
}

const libc = openLibc();

function setProcessEnvVar(key: string, value: string) {
  process.env[key] = value;
  const k = Buffer.from(key + "\0");
  const v = Buffer.from(value + "\0");
  libc.symbols.setenv(k, v, 1);
}

export interface IsolatedHome {
  path: string;
  realHome: string;
  cleanup: () => void;
}

export function setupIsolatedHome(): IsolatedHome {
  // Anchor under /tmp explicitly. On macOS $TMPDIR points at
  // /var/folders/<hash>/T/... (~49 chars), which combined with
  // .microsandbox/sandboxes/<name>/<sock> exceeds the 104-byte SUN_LEN
  // limit for UNIX domain sockets and breaks the sandbox agent relay.
  const tempRoot = mkdtempSync("/tmp/isolade-test-home-");
  const msbHome = join(tempRoot, ".microsandbox");
  const binDir = join(msbHome, "bin");
  const libDir = join(msbHome, "lib");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });

  const realHome = homedir();
  const realMsbHome = join(realHome, ".microsandbox");
  const realBin = join(realMsbHome, "bin", "msb");
  if (!existsSync(realBin)) {
    throw new Error(`setupIsolatedHome: ${realBin} not found. Install microsandbox first`);
  }
  symlinkSync(realBin, join(binDir, "msb"));

  const realLib = join(realMsbHome, "lib");
  if (existsSync(realLib)) {
    for (const entry of readdirSync(realLib)) {
      symlinkSync(join(realLib, entry), join(libDir, entry));
    }
  }

  setProcessEnvVar("HOME", tempRoot);

  return {
    path: tempRoot,
    realHome,
    cleanup: () => {
      setProcessEnvVar("HOME", realHome);
      // Allow MSB_TEST_KEEP_HOME=1 to preserve the tempdir for post-mortem
      // (sqlite db, sandbox logs). Same convention microsandbox itself uses.
      if (process.env.MSB_TEST_KEEP_HOME === "1") {
        console.log(`[isolated-home] keeping tempdir: ${tempRoot}`);
        return;
      }
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}
