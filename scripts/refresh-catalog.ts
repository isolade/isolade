#!/usr/bin/env bun
// Regenerate the static model catalog (packages/shared/src/catalog.ts) from
// models.dev — first-party, MIT-licensed rate cards plus, for Claude, a
// per-model reasoning-effort matrix. The catalog used to be discovered per
// profile at runtime; it's now static, so this is the maintenance path — run it
// after a new model ships, after bumping the codex binary, or when a provider
// changes prices.
//
//   bun run refresh-catalog             # rewrite the generated blocks in catalog.ts
//   bun run refresh-catalog --check     # don't write; report drift, exit 1 if any
//   bun run refresh-catalog anthropic   # only the Claude half (no codex CLI needed)
//   bun run refresh-catalog codex       # only the Codex half
//
// Source-of-truth split (what this script owns vs what stays hand-managed):
//
//   Codex (OpenAI)
//     list + names + effort menus  ← `codex app-server` `model/list` (the
//       user's logged-in account is the authority on which models exist)
//     pricing                      ← models.dev (codex exposes none)
//     rewrites  <codex:start>…<codex:end>  and  <codex-pricing:start>…<end>
//
//   Claude (Anthropic)
//     which ids to offer + order   ← ANTHROPIC_ALLOWLIST in catalog.ts (models.dev
//       has no per-subscription view and the `claude` CLI has no list command)
//     name + context + efforts + pricing  ← models.dev, per allowlisted id
//     rewrites  <anthropic:start>…<anthropic:end>  (pricing is inline; unlike
//       codex, only subscription-share reads it, via findChatModel().pricing)
//
// Not touched by either half: the default frontier/"More…" placement
// (MORE_BY_DEFAULT_MODEL_IDS) and CODEX_PRICING_HISTORICAL (delisted ids
// models.dev no longer carries). New/removed ids are flagged so you remember to
// place them; ids without a models.dev price are flagged too.
//
// Changing prices only affects future turns — historical usage is persisted
// per-turn at the rate in effect (see the usage_events table), never recomputed.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatEffort } from "../packages/shared/src/base";
import { ANTHROPIC_ALLOWLIST, CHAT_MODELS, codexPricingFor } from "../packages/shared/src/catalog";

const CATALOG_PATH = join(import.meta.dir, "../packages/shared/src/catalog.ts");
const ANTHROPIC_MARKERS = { start: "// <anthropic:start>", end: "// <anthropic:end>" };
const CODEX_MARKERS = { start: "// <codex:start>", end: "// <codex:end>" };
const PRICING_MARKERS = { start: "// <codex-pricing:start>", end: "// <codex-pricing:end>" };
const MODELSDEV_URL = "https://models.dev/api.json";

// Claude models.dev entries don't publish a default effort, and a few (e.g.
// Haiku) publish no effort menu at all. Fix a sane default and a full-menu
// fallback here; both are clamped to whatever menu the model does advertise.
const ANTHROPIC_DEFAULT_EFFORT: ChatEffort = "high";
const ANTHROPIC_EFFORT_FALLBACK: ChatEffort[] = ["low", "medium", "high", "xhigh", "max"];

interface CodexModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  defaultReasoningEffort: string;
}

// USD per million tokens. cacheWrite is Anthropic-only (codex publishes no
// cache-write rate); both cache fields are optional.
interface Pricing {
  inputPerMTok: number;
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
  outputPerMTok: number;
}

// One Codex catalog entry, reduced to the fields the model-list source owns.
interface CodexEntry {
  id: string;
  name: string;
  supportedEfforts: ChatEffort[];
  defaultEffort: ChatEffort;
}

// One fully-resolved Claude catalog entry (models.dev owns everything here).
interface AnthropicEntry {
  id: string;
  name: string;
  contextWindow: number;
  supportedEfforts: ChatEffort[];
  defaultEffort: ChatEffort;
  pricing?: Pricing;
}

// Shape of the slice of models.dev we consume, per provider.
interface ModelsDevModel {
  name?: string;
  reasoning_options?: { type: string; values?: string[] }[];
  limit?: { context?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}
interface ModelsDev {
  anthropic?: { models?: Record<string, ModelsDevModel> };
  openai?: { models?: Record<string, ModelsDevModel> };
}

async function fetchModelsDev(): Promise<ModelsDev> {
  const res = await fetch(MODELSDEV_URL);
  if (!res.ok) throw new Error(`models.dev fetch failed: HTTP ${res.status}`);
  return (await res.json()) as ModelsDev;
}

function pricingFromCost(cost: ModelsDevModel["cost"]): Pricing | undefined {
  if (!cost || cost.input == null || cost.output == null) return undefined;
  const p: Pricing = { inputPerMTok: cost.input, outputPerMTok: cost.output };
  if (cost.cache_read != null) p.cachedInputPerMTok = cost.cache_read;
  if (cost.cache_write != null) p.cacheWritePerMTok = cost.cache_write;
  return p;
}

// ---------- Codex ----------

// Drive `codex app-server` over stdio JSON-RPC: initialize, then model/list
// (including hidden, so we can drop them ourselves and log what we dropped).
async function fetchCodexModels(): Promise<CodexModel[]> {
  const proc = spawn(
    "codex",
    ["app-server", "--listen", "stdio://", "--disable", "apps", "-c", "features.memories=false"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let buf = "";
  let reqId = 0;
  const pending = new Map<
    number,
    (msg: { result?: unknown; error?: { message?: string } }) => void
  >();
  const send = (method: string, params: unknown) => {
    const id = ++reqId;
    return new Promise<{ result?: unknown; error?: { message?: string } }>((resolve) => {
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg && typeof msg === "object" && "id" in msg && pending.has(msg.id)) {
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        }
      } catch {
        // Non-JSON stdout (startup noise) — ignore.
      }
    }
  });

  const guard = setTimeout(() => {
    proc.kill();
    throw new Error("codex app-server timed out; is `codex` installed and logged in?");
  }, 60_000);

  try {
    await send("initialize", { clientInfo: { name: "isolade-refresh-catalog", version: "1.0" } });
    const res = await send("model/list", { includeHidden: true });
    if (res.error) throw new Error(`codex model/list failed: ${res.error.message}`);
    return (res.result as { data: CodexModel[] }).data;
  } finally {
    clearTimeout(guard);
    proc.kill();
  }
}

// Map codex's shape onto isolade's: drop hidden models and copy the advertised
// efforts through verbatim (ChatEffort is a free-form string, so there's nothing
// to filter). A model that somehow advertises no efforts is skipped, since the
// picker needs at least one.
function toCodexEntries(models: CodexModel[]): { entries: CodexEntry[]; dropped: string[] } {
  const dropped: string[] = [];
  const entries: CodexEntry[] = [];
  for (const m of models) {
    if (m.hidden) {
      dropped.push(`${m.id} (hidden)`);
      continue;
    }
    const supportedEfforts = m.supportedReasoningEfforts.map(
      (e) => e.reasoningEffort as ChatEffort,
    );
    const [firstEffort] = supportedEfforts;
    if (!firstEffort) {
      dropped.push(`${m.id} (no advertised efforts)`);
      continue;
    }
    const declaredDefault = m.defaultReasoningEffort as ChatEffort;
    const defaultEffort = supportedEfforts.includes(declaredDefault)
      ? declaredDefault
      : firstEffort;
    entries.push({ id: m.id, name: m.displayName || m.id, supportedEfforts, defaultEffort });
  }
  return { entries, dropped };
}

// models.dev pricing for the given OpenAI-provider ids. Ids the dataset doesn't
// price are simply absent from the returned map. Codex catalog entries omit
// cache-write (only input/cached/output are surfaced), so we drop it here —
// keeping it would show as perpetual drift against the committed CODEX_PRICING.
function codexPricing(db: ModelsDev, ids: string[]): Map<string, Pricing> {
  const models = db.openai?.models ?? {};
  const out = new Map<string, Pricing>();
  for (const id of ids) {
    const p = pricingFromCost(models[id]?.cost);
    if (p) {
      delete p.cacheWritePerMTok;
      out.set(id, p);
    }
  }
  return out;
}

// ---------- Anthropic ----------

// Resolve each allowlisted id against models.dev. `missing` lists allowlisted
// ids the dataset doesn't carry (so we don't silently drop them). `extra` lists
// Claude ids models.dev has that the allowlist doesn't offer — informational,
// so a newly-shipped model (the next Sonnet, say) doesn't go unnoticed.
function toAnthropicEntries(
  db: ModelsDev,
  allowlist: readonly string[],
): { entries: AnthropicEntry[]; missing: string[]; extra: string[] } {
  const models = db.anthropic?.models ?? {};
  const entries: AnthropicEntry[] = [];
  const missing: string[] = [];
  for (const id of allowlist) {
    const m = models[id];
    if (!m) {
      missing.push(id);
      continue;
    }
    const context = m.limit?.context;
    if (context == null) {
      missing.push(`${id} (no context window)`);
      continue;
    }
    const advertised = m.reasoning_options?.find((o) => o.type === "effort")?.values;
    const supportedEfforts = (advertised?.length ? advertised : ANTHROPIC_EFFORT_FALLBACK) as
      | ChatEffort[]
      | string[] as ChatEffort[];
    const defaultEffort = supportedEfforts.includes(ANTHROPIC_DEFAULT_EFFORT)
      ? ANTHROPIC_DEFAULT_EFFORT
      : supportedEfforts[0];
    entries.push({
      id,
      // models.dev names Claude models "Claude Sonnet 5"; isolade drops the
      // brand prefix so the picker reads "Sonnet 5".
      name: (m.name ?? id).replace(/^Claude\s+/, ""),
      contextWindow: context,
      supportedEfforts,
      defaultEffort,
      pricing: pricingFromCost(m.cost),
    });
  }
  const offered = new Set(allowlist);
  const extra = Object.keys(models).filter((id) => !offered.has(id));
  return { entries, missing, extra };
}

// ---------- rendering ----------

// Group an integer's digits in threes with underscores, matching the catalog's
// hand-written style (1_000_000, 200_000).
function groupThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

function renderEfforts(efforts: ChatEffort[]): string {
  return `[${efforts.map((x) => JSON.stringify(x)).join(", ")}]`;
}

// Render a pricing object as an expanded (multiline) literal. models.dev prices
// can push the inline form past biome's 100-col width, so we always expand for
// a uniform, format-stable block.
function renderPricingLiteral(p: Pricing, indent: string): string {
  const lines = [`${indent}pricing: {`, `${indent}  inputPerMTok: ${p.inputPerMTok},`];
  if (p.cachedInputPerMTok != null)
    lines.push(`${indent}  cachedInputPerMTok: ${p.cachedInputPerMTok},`);
  if (p.cacheWritePerMTok != null)
    lines.push(`${indent}  cacheWritePerMTok: ${p.cacheWritePerMTok},`);
  lines.push(`${indent}  outputPerMTok: ${p.outputPerMTok},`, `${indent}},`);
  return lines.join("\n");
}

function renderAnthropicEntry(e: AnthropicEntry): string {
  const lines = [
    "  {",
    `    id: ${JSON.stringify(e.id)},`,
    `    name: ${JSON.stringify(e.name)},`,
    '    provider: "anthropic",',
    `    contextWindow: ${groupThousands(e.contextWindow)},`,
    `    supportedEfforts: ${renderEfforts(e.supportedEfforts)},`,
    `    defaultEffort: ${JSON.stringify(e.defaultEffort)},`,
  ];
  if (e.pricing) lines.push(renderPricingLiteral(e.pricing, "    "));
  lines.push("  },");
  return lines.join("\n");
}

// Render one codex entry as the exact TypeScript the <codex:…> block holds.
// Pricing is referenced by id (undefined for unpriced ids — pricing is optional).
function renderCodexEntry(e: CodexEntry): string {
  return [
    "  {",
    `    id: ${JSON.stringify(e.id)},`,
    `    name: ${JSON.stringify(e.name)},`,
    '    provider: "openai",',
    `    supportedEfforts: ${renderEfforts(e.supportedEfforts)},`,
    `    defaultEffort: ${JSON.stringify(e.defaultEffort)},`,
    `    pricing: CODEX_PRICING[${JSON.stringify(e.id)}],`,
    "  },",
  ].join("\n");
}

// Render one CODEX_PRICING entry for the <codex-pricing:…> block.
function renderCodexPricing(id: string, p: Pricing): string {
  const parts = [`inputPerMTok: ${p.inputPerMTok}`];
  if (p.cachedInputPerMTok != null) parts.push(`cachedInputPerMTok: ${p.cachedInputPerMTok}`);
  parts.push(`outputPerMTok: ${p.outputPerMTok}`);
  return `  ${JSON.stringify(id)}: { ${parts.join(", ")} },`;
}

// Replace the text between a marker pair with `block`, preserving everything
// else and the 2-space indent of the closing marker.
function splice(src: string, markers: { start: string; end: string }, block: string): string {
  const start = src.indexOf(markers.start);
  const end = src.indexOf(markers.end);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`markers ${markers.start} / ${markers.end} not found in catalog.ts`);
  }
  return `${src.slice(0, start + markers.start.length)}\n${block}\n  ${src.slice(end)}`;
}

// ---------- drift reporting (--check) ----------

function currentCodexEntries(): CodexEntry[] {
  return CHAT_MODELS.filter((m) => m.provider === "openai").map((m) => ({
    id: m.id,
    name: m.name,
    supportedEfforts: [...m.supportedEfforts],
    defaultEffort: m.defaultEffort,
  }));
}

function currentAnthropicEntries(): AnthropicEntry[] {
  return CHAT_MODELS.filter((m) => m.provider === "anthropic").map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow ?? 0,
    supportedEfforts: [...m.supportedEfforts],
    defaultEffort: m.defaultEffort,
    pricing: m.pricing,
  }));
}

function sameEfforts(a: ChatEffort[], b: ChatEffort[]): boolean {
  return a.join(",") === b.join(",");
}

function samePricing(a: Pricing | undefined, b: Pricing | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.inputPerMTok === b.inputPerMTok &&
    (a.cachedInputPerMTok ?? null) === (b.cachedInputPerMTok ?? null) &&
    (a.cacheWritePerMTok ?? null) === (b.cacheWritePerMTok ?? null) &&
    a.outputPerMTok === b.outputPerMTok
  );
}

// Print Codex model + pricing drift relative to the committed catalog.
function reportCodexDrift(entries: CodexEntry[], pricing: Map<string, Pricing>): boolean {
  const cur = currentCodexEntries();
  const curById = new Map(cur.map((e) => [e.id, e]));
  const nextById = new Map(entries.map((e) => [e.id, e]));
  let drift = false;
  for (const e of entries) {
    const prev = curById.get(e.id);
    if (!prev) {
      console.log(`  + ${e.id} (new — set its tier in MORE_BY_DEFAULT_MODEL_IDS)`);
      drift = true;
    } else if (
      prev.name !== e.name ||
      prev.defaultEffort !== e.defaultEffort ||
      !sameEfforts(prev.supportedEfforts, e.supportedEfforts)
    ) {
      console.log(`  ~ ${e.id} (efforts/name/default changed)`);
      drift = true;
    }
    const live = pricing.get(e.id);
    if (!live) {
      console.log(`  ! ${e.id} (no price on models.dev — API-$ chip will hide)`);
    } else if (!samePricing(codexPricingFor(e.id), live)) {
      console.log(
        `  $ ${e.id} price changed → in=${live.inputPerMTok} cached=${live.cachedInputPerMTok ?? "-"} out=${live.outputPerMTok}`,
      );
      drift = true;
    }
  }
  for (const e of cur) {
    if (!nextById.has(e.id)) {
      console.log(`  - ${e.id} (no longer offered by codex)`);
      drift = true;
    }
  }
  return drift;
}

// Print Claude drift relative to the committed catalog. The allowlist is the
// list authority, so a "removed" id can only appear if the catalog holds a
// Claude id the allowlist dropped (its generated entry is now stale).
function reportAnthropicDrift(entries: AnthropicEntry[]): boolean {
  const cur = currentAnthropicEntries();
  const curById = new Map(cur.map((e) => [e.id, e]));
  const nextById = new Map(entries.map((e) => [e.id, e]));
  let drift = false;
  for (const e of entries) {
    const prev = curById.get(e.id);
    if (!prev) {
      console.log(`  + ${e.id} (new — set its tier in MORE_BY_DEFAULT_MODEL_IDS)`);
      drift = true;
    } else if (
      prev.name !== e.name ||
      prev.contextWindow !== e.contextWindow ||
      prev.defaultEffort !== e.defaultEffort ||
      !sameEfforts(prev.supportedEfforts, e.supportedEfforts) ||
      !samePricing(prev.pricing, e.pricing)
    ) {
      console.log(`  ~ ${e.id} (name/context/efforts/pricing changed)`);
      drift = true;
    }
    if (!e.pricing) console.log(`  ! ${e.id} (no price on models.dev)`);
  }
  for (const e of cur) {
    if (!nextById.has(e.id)) {
      console.log(`  - ${e.id} (dropped from ANTHROPIC_ALLOWLIST)`);
      drift = true;
    }
  }
  return drift;
}

// ---------- main ----------

async function refreshCodex(src: string, check: boolean): Promise<{ src: string; drift: boolean }> {
  const models = await fetchCodexModels();
  const { entries, dropped } = toCodexEntries(models);
  if (entries.length === 0) throw new Error("codex returned no usable models");
  const pricing = codexPricing(
    await sharedDb(),
    entries.map((e) => e.id),
  );

  console.log(`\nCodex: ${entries.length} model(s): ${entries.map((e) => e.id).join(", ")}`);
  if (dropped.length) console.log(`  dropped: ${dropped.join(", ")}`);
  console.log(`  priced from models.dev: ${[...pricing.keys()].join(", ") || "(none)"}`);
  const drift = reportCodexDrift(entries, pricing);
  if (check) return { src, drift };

  let out = splice(src, CODEX_MARKERS, entries.map(renderCodexEntry).join("\n"));
  const pricingBlock = entries
    .filter((e) => pricing.has(e.id))
    .map((e) => renderCodexPricing(e.id, pricing.get(e.id)!))
    .join("\n");
  out = splice(out, PRICING_MARKERS, pricingBlock);
  return { src: out, drift };
}

async function refreshAnthropic(
  src: string,
  check: boolean,
): Promise<{ src: string; drift: boolean }> {
  const { entries, missing, extra } = toAnthropicEntries(await sharedDb(), ANTHROPIC_ALLOWLIST);
  if (missing.length) {
    throw new Error(
      `ANTHROPIC_ALLOWLIST ids missing from models.dev: ${missing.join(", ")}. ` +
        `Fix the id in catalog.ts or drop it from the allowlist.`,
    );
  }

  console.log(`\nClaude: ${entries.length} model(s): ${entries.map((e) => e.id).join(", ")}`);
  if (extra.length) console.log(`  on models.dev but not offered: ${extra.join(", ")}`);
  const drift = reportAnthropicDrift(entries);
  if (check) return { src, drift };

  const out = splice(src, ANTHROPIC_MARKERS, entries.map(renderAnthropicEntry).join("\n"));
  return { src: out, drift };
}

// models.dev is fetched once and shared by both halves.
let _db: Promise<ModelsDev> | undefined;
function sharedDb(): Promise<ModelsDev> {
  _db ??= fetchModelsDev();
  return _db;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const only = args.find((a) => a === "anthropic" || a === "codex");
  const doAnthropic = only !== "codex";
  const doCodex = only !== "anthropic";

  const src = readFileSync(CATALOG_PATH, "utf8");
  let out = src;
  let drift = false;
  if (doAnthropic) {
    const r = await refreshAnthropic(out, check);
    out = r.src;
    drift ||= r.drift;
  }
  if (doCodex) {
    const r = await refreshCodex(out, check);
    out = r.src;
    drift ||= r.drift;
  }

  if (check) {
    if (drift) {
      console.error("\nCatalog is out of date. Run `bun run refresh-catalog` to update it.");
      process.exit(1);
    }
    console.log("\nCatalog is up to date.");
    return;
  }

  if (out === src) {
    console.log("\nNo changes.");
    return;
  }
  writeFileSync(CATALOG_PATH, out);
  console.log(`\nWrote ${CATALOG_PATH}. Run \`bun run format\` and \`bun run check\`.`);
  if (drift) console.log("Review MORE_BY_DEFAULT_MODEL_IDS for any + / - ids above.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
