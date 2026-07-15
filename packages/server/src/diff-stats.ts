import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";
import type { Instance } from "./db/schema";
import type { SandboxApi } from "./sandbox-client";

// The VM filesystem is ephemeral, so the number worth showing is "work that
// would be lost if this VM evaporated": the working tree diffed against the
// nearest commit known to exist on a remote. Unpushed local commits count, but
// pushed work drops out the moment the push lands (the local remote-tracking
// ref advances, no fetch needed).
//
// The slow loop covers changes nobody told us about (terminal-tab edits,
// long-running builds). Agent activity gets a fast path: chat tool events
// nudge() the instance, debounced so a busy turn probes at most once a
// second instead of once per tool call.
const DIFF_STATS_REFRESH_MS = 10_000;
const DIFF_STATS_NUDGE_DEBOUNCE_MS = 1_000;

const PROBE_TIMEOUT_MS = 10_000;

// Shell probe run inside the VM via the sandbox's `/bin/sh -c` exec. Visits
// every git repo at /workspace or one level below (where user Dockerfiles
// COPY the `<name>` repo contexts) and emits per-file numstat lines plus
// one `U <lines>` line per repo for untracked-file content (counted as
// additions, and --exclude-standard keeps gitignored bulk like node_modules
// out). The trailing awk folds everything into a single "added deleted
// lines" triple; binary files numstat as "-" and coerce to 0. `lines` is 0
// only when no repo was found at all (every visited repo emits at least
// its U line), which is how the parser tells "no repos" from "no changes".
//
// The diff base per repo is the merge-base of HEAD with every commit the
// repo can prove exists on the remote: all remote-tracking refs, plus the
// tips recorded in FETCH_HEAD. A `git fetch origin pull/N/head:branch` PR
// checkout records the PR tip there and nowhere else, so without it a
// checked-out PR counts as one giant unpushed diff against main. Deliberately
// NOT the current branch's upstream: agents check out branches without
// tracking refs all the time. Repos with no remote knowledge at all fall
// back to plain HEAD (count only uncommitted work, not the whole history).
//
// `root` is parameterized for tests. Production always probes /workspace.
export function diffStatsProbeScript(root = "/workspace"): string {
  return `
for g in ${root}/.git ${root}/*/.git; do
  [ -e "$g" ] || continue
  r="\${g%/.git}"
  base=$( { git -C "$r" for-each-ref --format='%(objectname)' refs/remotes 2>/dev/null
            awk '{print $1 "^{commit}"}' "$g/FETCH_HEAD" 2>/dev/null |
              git -C "$r" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null |
              awk '$2 == "commit" {print $1}'
          } | xargs git -C "$r" merge-base HEAD 2>/dev/null | head -n 1)
  [ -n "$base" ] || base=HEAD
  git -C "$r" diff --numstat "$base" 2>/dev/null
  printf 'U %s\\n' "$( (cd "$r" 2>/dev/null && git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 cat -- 2>/dev/null) | wc -l)"
done | awk '{ if ($1 == "U") add += $2; else { add += $1; del += $2 }; lines += 1 } END { printf "%d %d %d", add, del, lines }'
`.trim();
}

// "added deleted lines" → stats. Returns:
//   { added: n, deleted: n }       : at least one repo probed
//   { added: null, deleted: null } : probe ran fine but found no git repos
//   null                           : output unparseable (treat as probe
//                                    failure: keep the previous values)
export function parseDiffStatsProbe(
  stdout: string,
): { added: number | null; deleted: number | null } | null {
  const m = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (!m) return null;
  if (Number(m[3]) === 0) return { added: null, deleted: null };
  return { added: Number(m[1]), deleted: Number(m[2]) };
}

// Background refresher for the per-instance diff stats shown next to each
// chat title. A slow loop execs the probe into every `running` VM (one
// in-flight probe per instance, so a slow VM skips rounds instead of
// stacking), and nudge() schedules a debounced one-off probe when agent
// activity makes a change likely. Changed values are persisted onto the
// instances row. Stopped/errored VMs keep their last persisted stats: the
// VM may be gone, but "what was unpushed when we last saw it" is still the
// most useful answer.
//
// Same lifecycle contract as DirSizeCache: constructed inside createApp,
// started only by the real server entrypoint so tests never reach for a
// sandbox that isn't theirs. nudge() is a no-op until start(), which also
// keeps fake-backend tests quiet.
export class DiffStatsPoller {
  private probe = diffStatsProbeScript();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = new Set<string>();
  private nudgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Instances whose last probe failed, so a flapping VM logs once per
  // outage instead of once per round.
  private failing = new Set<string>();
  private readonly refreshMs: number;
  private readonly nudgeDebounceMs: number;

  constructor(
    private readonly db: Db,
    private readonly sandboxClient: SandboxApi,
    opts: { refreshMs?: number; nudgeDebounceMs?: number } = {},
  ) {
    this.refreshMs = opts.refreshMs ?? DIFF_STATS_REFRESH_MS;
    this.nudgeDebounceMs = opts.nudgeDebounceMs ?? DIFF_STATS_NUDGE_DEBOUNCE_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const timer of this.nudgeTimers.values()) clearTimeout(timer);
    this.nudgeTimers.clear();
  }

  // Fast path for "the agent just did something": probe this instance after
  // a short debounce. Nudges arriving while one is pending coalesce, so a
  // turn firing tool calls back-to-back probes at most once per debounce
  // window.
  nudge(instanceId: string): void {
    if (!this.running || this.nudgeTimers.has(instanceId)) return;
    this.nudgeTimers.set(
      instanceId,
      setTimeout(() => {
        this.nudgeTimers.delete(instanceId);
        if (!this.running) return;
        if (this.inFlight.has(instanceId)) {
          // A probe (likely the slow loop's) is mid-flight, so re-arm so the
          // post-activity state still lands once it finishes.
          this.nudge(instanceId);
          return;
        }
        const row = this.db
          .select()
          .from(schema.instances)
          .where(eq(schema.instances.id, instanceId))
          .get();
        if (!row || row.status !== "running") return;
        this.launchProbe(row);
      }, this.nudgeDebounceMs),
    );
  }

  private tick(): void {
    if (!this.running) return;
    const rows = this.db.select().from(schema.instances).all();
    for (const row of rows) {
      if (row.status !== "running" || this.inFlight.has(row.id)) continue;
      this.launchProbe(row);
    }
    this.timer = setTimeout(() => this.tick(), this.refreshMs);
  }

  private launchProbe(row: Instance): void {
    this.inFlight.add(row.id);
    void this.refresh(row)
      .catch((err) => {
        if (this.failing.has(row.id)) return;
        this.failing.add(row.id);
        // Concise message only: a stopped/unreachable VM throws a microsandbox
        // error whose object form dumps a stack + raw napi cause. One line per
        // outage (gated by `failing`) is enough to know a VM went dark.
        console.warn(
          `[diff-stats ${row.id}] probe failed (will keep retrying): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => this.inFlight.delete(row.id));
  }

  private async refresh(row: Instance): Promise<void> {
    const { stdout, stderr, exitCode } = await this.sandboxClient.exec(row.vmId, this.probe, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (exitCode !== 0) throw new Error(`probe exited ${exitCode}: ${stderr.trim()}`);
    const stats = parseDiffStatsProbe(stdout);
    if (stats === null) throw new Error(`unparseable probe output: ${stdout.trim()}`);
    this.failing.delete(row.id);
    if (stats.added === row.diffAdded && stats.deleted === row.diffDeleted) return;
    // Deliberately no updatedAt bump: the sidebar orders by updatedAt, and a
    // background stat refresh must never reorder rows.
    this.db
      .update(schema.instances)
      .set({ diffAdded: stats.added, diffDeleted: stats.deleted })
      .where(eq(schema.instances.id, row.id))
      .run();
  }
}
