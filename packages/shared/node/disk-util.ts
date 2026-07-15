import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Why shell out to `du -sk` instead of `fs.stat().blocks * 512`:
//   - On macOS APFS, fs.Stats.blocks is unreliable for many file types
//     (sparse files, clones, compressed files), and empirically returns 8
//     (= 4 KiB) constantly regardless of true extent allocation.
//   - `du -sk` reads allocation via statfs / getattrlist, which APFS
//     answers correctly. Same answer Linux gives via /proc.
//   - Output is identical on BSD du (macOS) and GNU du (Linux) for `-sk`,
//     so one code path covers both.
// Cost: one fork+exec per call (~5–10 ms). The stats endpoint polls a
// handful of paths every 2 s, so the overhead is negligible.
async function duKilobytes(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", path], {
      timeout: 10_000,
    });
    const kib = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kib) ? kib : 0;
  } catch {
    return 0;
  }
}

// Allocated bytes for a single file. Symlinks count as themselves (du's
// default, so it doesn't follow them).
export async function fileAllocatedBytes(path: string): Promise<number> {
  return (await duKilobytes(path)) * 1024;
}

// Recursive allocated bytes for a directory tree. Same as `du -sk <dir>`.
export async function dirAllocatedBytes(path: string): Promise<number> {
  return (await duKilobytes(path)) * 1024;
}
