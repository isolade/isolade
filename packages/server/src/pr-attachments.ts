import { and, asc, eq } from "drizzle-orm";
import type { AttachedPr } from "./contracts";
import type { Db } from "./db";
import { schema } from "./db";
import type { InstancePrRow } from "./db/schema";
import type { SandboxApi } from "./sandbox-client";

// Pull requests attached to a chat via the in-VM `isolade pr add` CLI. Two
// pieces live here:
//   * PrAttachmentManager — the DB store (attach/detach/list) plus the `gh`
//     probe that refreshes a PR's cached state by running inside the instance's
//     VM, where the user's GitHub auth lives (the host has no GitHub token).
//   * PrStatePoller — the slow background loop that keeps every attached PR's
//     badge current, mirroring DiffStatsPoller.
//
// Why probe from inside the VM: agents already push branches and open PRs with
// the VM's authenticated `gh`, so that's the one place a token exists. The host
// holds a persistent exec channel into every running VM, so a `gh pr view` is a
// single exec away, with no host-side credential and no network-policy change.

/** A fully-resolved reference to a single pull request. */
export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

// The wire payload the in-VM CLI sends: either a full PR URL, or a bare number
// paired with the repo's `origin` remote URL (resolved by the CLI from the cwd,
// which is why `isolade pr add 123` must run inside the repo). Parsing both
// forms lives here on the host so there's a single, unit-tested implementation.
export interface PrRefInput {
  number?: number;
  remoteUrl?: string;
  prUrl?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
// PR state (open/merged/closed, review, draft) changes on human time, so a
// slow loop is plenty. The `add` path refreshes immediately, so a fresh badge
// never waits a full round.
const PR_REFRESH_MS = 30_000;

// Strip a trailing ".git" and any surrounding slashes from a repo path segment.
function cleanRepo(repo: string): string {
  return repo.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
}

/** Parse a git remote URL (`git@host:owner/repo.git`, `https://host/owner/repo`,
 * `ssh://git@host/owner/repo.git`) into its host/owner/repo. Returns null for
 * anything that doesn't name a `<owner>/<repo>` under a host. */
export function parseRepoUrl(url: string): Omit<PrRef, "number"> | null {
  const raw = url.trim();
  if (!raw) return null;

  // scp-like syntax: git@host:owner/repo(.git)
  const scp = raw.match(/^[^/@]+@([^:/]+):(.+)$/);
  if (scp?.[1] && scp[2]) {
    const parts = cleanRepo(scp[2]).split("/");
    if (parts.length >= 2) {
      const repo = parts.pop()!;
      const owner = parts.pop()!;
      if (owner && repo) return { host: scp[1], owner, repo };
    }
    return null;
  }

  // URL syntax: [scheme://][user@]host[:port]/owner/.../repo(.git)
  const withScheme = raw.includes("://") ? raw : `ssh://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  const parts = cleanRepo(parsed.pathname).split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.pop()!;
  const owner = parts.pop()!;
  if (!parsed.hostname || !owner || !repo) return null;
  return { host: parsed.hostname, owner, repo };
}

/** Parse a PR web URL (`https://host/owner/repo/pull/123`) into a full ref. */
export function parsePrUrl(url: string): PrRef | null {
  const raw = url.trim();
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  // .../<owner>/<repo>/pull/<n>  (GitHub uses /pull, but accept /pulls too)
  const m = parsed.pathname.match(/^\/(.+?)\/([^/]+)\/pulls?\/(\d+)\/?$/);
  if (!m || !parsed.hostname) return null;
  const owner = m[1]!;
  const repo = cleanRepo(m[2]!);
  const number = Number(m[3]);
  if (!owner.length || !repo.length || !Number.isInteger(number) || number < 1) return null;
  return { host: parsed.hostname, owner, repo, number };
}

/** Resolve the CLI's wire payload into a concrete PR ref, or an error string
 * describing why it couldn't (bad number, unparseable remote, missing inputs). */
export function resolvePrRef(input: PrRefInput): PrRef | { error: string } {
  if (input.prUrl) {
    const ref = parsePrUrl(input.prUrl);
    return ref ?? { error: `not a pull-request URL: ${input.prUrl}` };
  }
  if (input.number == null || !Number.isInteger(input.number) || input.number < 1) {
    return { error: "expected a positive PR number or a pull-request URL" };
  }
  if (!input.remoteUrl) {
    return { error: "no git remote to resolve the PR against (run inside the repo)" };
  }
  const repo = parseRepoUrl(input.remoteUrl);
  if (!repo) return { error: `could not parse the repo from remote: ${input.remoteUrl}` };
  return { ...repo, number: input.number };
}

/** The canonical web URL for a PR, synthesized so the badge links out even
 * before the first probe. */
export function canonicalPrUrl(ref: PrRef): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

/** gh's `--repo` accepts `[HOST/]OWNER/REPO`; the host prefix is only needed
 * for GitHub Enterprise, so drop it for github.com to keep the common case clean. */
function ghRepoSpec(ref: PrRef): string {
  const prefix = ref.host === "github.com" ? "" : `${ref.host}/`;
  return `${prefix}${ref.owner}/${ref.repo}`;
}

/** The in-VM command that reads a PR's live state. Single-quoted args are safe:
 * owner/repo/host come from a parsed URL (no quotes), and the number is an int. */
export function ghPrViewCommand(ref: PrRef): string {
  return `gh pr view ${ref.number} --repo '${ghRepoSpec(ref)}' --json number,title,state,isDraft,url`;
}

/** The mutable slice of a PR a probe reads back. */
export interface PrState {
  title: string | null;
  state: AttachedPr["state"];
  isDraft: boolean;
  url: string | null;
}

/** Parse `gh pr view --json …` output. Returns null when the payload is missing
 * the fields we need (gh errored, or a shape we don't understand), so the caller
 * keeps the last-known state rather than blanking the badge. */
export function parseGhPrView(stdout: string): PrState | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const rawState = typeof obj.state === "string" ? obj.state.toUpperCase() : "";
  const state: AttachedPr["state"] =
    rawState === "OPEN"
      ? "open"
      : rawState === "MERGED"
        ? "merged"
        : rawState === "CLOSED"
          ? "closed"
          : "unknown";
  if (state === "unknown" && typeof obj.title !== "string") return null;
  return {
    title: typeof obj.title === "string" ? obj.title : null,
    state,
    isDraft: obj.isDraft === true,
    url: typeof obj.url === "string" ? obj.url : null,
  };
}

function toClient(row: InstancePrRow): AttachedPr {
  return {
    host: row.host,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    title: row.title,
    state: row.state,
    isDraft: row.isDraft,
    url: row.url,
  };
}

// The store + probe for chat-attached PRs. DB CRUD is synchronous (drizzle over
// bun:sqlite), and refresh() runs `gh` inside a given VM. Injected with the
// sandbox client so the same probe backs both the `add` path (immediate refresh
// so the badge lands populated) and the background poller.
export class PrAttachmentManager {
  constructor(
    private db: Db,
    private sandboxClient: SandboxApi,
  ) {}

  private rowsFor(instanceId: string): InstancePrRow[] {
    return this.db
      .select()
      .from(schema.instancePrs)
      .where(eq(schema.instancePrs.instanceId, instanceId))
      .orderBy(asc(schema.instancePrs.createdAt))
      .all();
  }

  /** The PRs attached to one instance, in attach order. */
  listFor(instanceId: string): AttachedPr[] {
    return this.rowsFor(instanceId).map(toClient);
  }

  /** Every attachment, grouped by instance id. Built once per instance listing
   * so decorate() stays a synchronous map read. */
  listByInstance(): Map<string, AttachedPr[]> {
    const rows = this.db
      .select()
      .from(schema.instancePrs)
      .orderBy(asc(schema.instancePrs.createdAt))
      .all();
    const map = new Map<string, AttachedPr[]>();
    for (const row of rows) {
      const list = map.get(row.instanceId);
      if (list) list.push(toClient(row));
      else map.set(row.instanceId, [toClient(row)]);
    }
    return map;
  }

  private where(instanceId: string, ref: PrRef) {
    return and(
      eq(schema.instancePrs.instanceId, instanceId),
      eq(schema.instancePrs.host, ref.host),
      eq(schema.instancePrs.owner, ref.owner),
      eq(schema.instancePrs.repo, ref.repo),
      eq(schema.instancePrs.number, ref.number),
    );
  }

  /** Attach a PR to an instance (idempotent: re-adding leaves the cached state
   * intact), then probe its live state so the returned badge is populated.
   * Never throws on a probe failure — the attachment stands with state
   * "unknown" and the poller retries. */
  async attach(instanceId: string, vmId: string, ref: PrRef): Promise<AttachedPr> {
    const existing = this.db
      .select()
      .from(schema.instancePrs)
      .where(this.where(instanceId, ref))
      .get();
    if (!existing) {
      this.db
        .insert(schema.instancePrs)
        .values({
          instanceId,
          host: ref.host,
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          url: canonicalPrUrl(ref),
        })
        .run();
    }
    await this.refreshOne(vmId, instanceId, ref).catch(() => {});
    const row = this.db.select().from(schema.instancePrs).where(this.where(instanceId, ref)).get();
    return row
      ? toClient(row)
      : { ...ref, title: null, state: "unknown", isDraft: false, url: canonicalPrUrl(ref) };
  }

  /** Detach a PR from an instance. No-op if it wasn't attached. */
  detach(instanceId: string, ref: PrRef): void {
    this.db.delete(schema.instancePrs).where(this.where(instanceId, ref)).run();
  }

  /** Drop every attachment for an instance (called when the instance is deleted). */
  removeForInstance(instanceId: string): void {
    this.db.delete(schema.instancePrs).where(eq(schema.instancePrs.instanceId, instanceId)).run();
  }

  /** Probe one PR's state inside `vmId` and persist any change. Throws on an
   * exec/transport failure so the poller can log it once per outage. */
  private async refreshOne(vmId: string, instanceId: string, ref: PrRef): Promise<void> {
    const { stdout } = await this.sandboxClient.exec(vmId, ghPrViewCommand(ref), {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const parsed = parseGhPrView(stdout);
    // gh failed (not installed, unauthenticated, PR not found, offline): leave
    // the cached row as-is so the badge holds its last-known state.
    if (!parsed) return;
    this.db
      .update(schema.instancePrs)
      .set({
        title: parsed.title,
        state: parsed.state,
        isDraft: parsed.isDraft,
        // Trust gh's canonical URL once we have it; keep the synthesized one
        // otherwise.
        ...(parsed.url ? { url: parsed.url } : {}),
      })
      .where(this.where(instanceId, ref))
      .run();
  }

  /** Refresh every PR attached to one instance. Best-effort per PR: a single
   * failing PR doesn't abort the rest. Returns whether all probes succeeded. */
  async refreshInstance(vmId: string, instanceId: string): Promise<boolean> {
    let ok = true;
    for (const row of this.rowsFor(instanceId)) {
      await this.refreshOne(vmId, instanceId, {
        host: row.host,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
      }).catch(() => {
        ok = false;
      });
    }
    return ok;
  }

  /** Instance ids that currently have at least one attached PR. */
  instanceIdsWithPrs(): string[] {
    const rows = this.db
      .selectDistinct({ instanceId: schema.instancePrs.instanceId })
      .from(schema.instancePrs)
      .all();
    return rows.map((r) => r.instanceId);
  }
}

// Background refresher for attached-PR badges, mirroring DiffStatsPoller: a slow
// loop probes every running VM that has attachments (one probe per instance in
// flight, so a slow VM skips rounds instead of stacking). Stopped/errored VMs
// keep their last-known state. Constructed in createApp but started only by the
// real entrypoint, so tests never reach for a sandbox that isn't theirs.
export class PrStatePoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = new Set<string>();
  private failing = new Set<string>();
  private readonly refreshMs: number;

  constructor(
    private readonly db: Db,
    private readonly prs: PrAttachmentManager,
    opts: { refreshMs?: number } = {},
  ) {
    this.refreshMs = opts.refreshMs ?? PR_REFRESH_MS;
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
  }

  private tick(): void {
    if (!this.running) return;
    for (const instanceId of this.prs.instanceIdsWithPrs()) {
      if (this.inFlight.has(instanceId)) continue;
      const row = this.db
        .select({ vmId: schema.instances.vmId, status: schema.instances.status })
        .from(schema.instances)
        .where(eq(schema.instances.id, instanceId))
        .get();
      if (!row || row.status !== "running") continue;
      this.launch(instanceId, row.vmId);
    }
    this.timer = setTimeout(() => this.tick(), this.refreshMs);
  }

  private launch(instanceId: string, vmId: string): void {
    this.inFlight.add(instanceId);
    void this.prs
      .refreshInstance(vmId, instanceId)
      .then((ok) => {
        if (ok) this.failing.delete(instanceId);
      })
      .catch((err) => {
        if (this.failing.has(instanceId)) return;
        this.failing.add(instanceId);
        console.warn(
          `[pr-state ${instanceId}] refresh failed (will keep retrying): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => this.inFlight.delete(instanceId));
  }
}
