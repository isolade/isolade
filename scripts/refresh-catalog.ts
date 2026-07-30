#!/usr/bin/env bun
// Regenerate the static model catalog (packages/shared/src/catalog.ts) from
// models.dev — first-party, MIT-licensed rate cards plus a per-model
// reasoning-effort matrix, for both providers. The catalog used to be discovered
// per profile at runtime; it's now static, so this is the maintenance path — run
// it after a new model ships or when a provider changes prices.
//
//   bun run refresh-catalog             # rewrite the generated blocks in catalog.ts
//   bun run refresh-catalog --check     # don't write; report drift, exit 1 if any
//   bun run refresh-catalog anthropic   # only the Claude half
//   bun run refresh-catalog codex       # only the Codex half
//
// Source-of-truth split (what this script owns vs what stays hand-managed):
//
//   models.dev, per allowlisted id
//     name, effort menu, pricing, and — Claude only — context window and the
//     fast-mode rate card. Neither CLI publishes prices, and neither publishes a
//     default effort, so those come from here and from the constants below.
//     Rewrites <anthropic:…>, <codex:…> and <codex-pricing:…>.
//
//   Hand-managed in catalog.ts (this script only reads it)
//     which ids to offer and in what order (ANTHROPIC_ALLOWLIST /
//     OPENAI_ALLOWLIST — models.dev carries every model either vendor ever
//     shipped, with no notion of what a plan can reach), which effort levels to
//     decline (EXCLUDED_EFFORTS), the default frontier/"More…" placement
//     (MORE_BY_DEFAULT_MODEL_IDS), and CODEX_PRICING_HISTORICAL (delisted ids
//     models.dev no longer carries). New/removed ids are flagged so you remember
//     to place them; ids without a models.dev price are flagged too.
//
// Changing prices only affects future turns — historical usage is persisted
// per-turn at the rate in effect (see the usage_events table), never recomputed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatEffort } from "../packages/shared/src/base";
import {
  ANTHROPIC_ALLOWLIST,
  CHAT_MODELS,
  codexPricingFor,
  EXCLUDED_EFFORTS,
  OPENAI_ALLOWLIST,
} from "../packages/shared/src/catalog";

const CATALOG_PATH = join(import.meta.dir, "../packages/shared/src/catalog.ts");
const ANTHROPIC_MARKERS = { start: "// <anthropic:start>", end: "// <anthropic:end>" };
const CODEX_MARKERS = { start: "// <codex:start>", end: "// <codex:end>" };
const PRICING_MARKERS = { start: "// <codex-pricing:start>", end: "// <codex-pricing:end>" };
const FAST_PRICING_MARKERS = {
  start: "// <codex-fast-pricing:start>",
  end: "// <codex-fast-pricing:end>",
};
const MODELSDEV_URL = "https://models.dev/api.json";

// Claude models.dev entries don't publish a default effort, and a few (e.g.
// Haiku) publish no effort menu at all. Fix a sane default and a full-menu
// fallback here; both are clamped to whatever menu the model does advertise.
const ANTHROPIC_DEFAULT_EFFORT: ChatEffort = "high";
// Codex publishes no default either, and the app-server's (which used to supply
// it) is gone. "medium" preserves what the committed catalog has always had.
const CODEX_DEFAULT_EFFORT: ChatEffort = "medium";
const ANTHROPIC_EFFORT_FALLBACK: ChatEffort[] = ["low", "medium", "high", "xhigh", "max"];

// USD per million tokens. cacheWrite is Anthropic-only (codex publishes no
// cache-write rate); both cache fields are optional.
interface Pricing {
  inputPerMTok: number;
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
  outputPerMTok: number;
}

// One Codex catalog entry. Pricing is referenced by id from CODEX_PRICING rather
// than inlined, since the server also looks it up there for historical ids.
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
  fastPricing?: Pricing;
}

// Shape of the slice of models.dev we consume, per provider.
type ModelsDevCost = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
};
interface ModelsDevModel {
  name?: string;
  reasoning_options?: { type: string; values?: string[] }[];
  limit?: { context?: number };
  cost?: ModelsDevCost;
  // A separate rate card for a provider's fast mode, where it offers one:
  // same buckets, premium rates (2× list on Opus 5, 6× on Opus 4.6). Under
  // `experimental` upstream, so treat its absence as "no fast mode" rather
  // than an error.
  experimental?: { modes?: { fast?: { cost?: ModelsDevCost } } };
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

type PricingMode = "standard" | "fast";

function fastPricingFrom(m: ModelsDevModel): Pricing | undefined {
  return pricingFromCost(m.experimental?.modes?.fast?.cost);
}

function pricingFromCost(cost: ModelsDevCost | undefined): Pricing | undefined {
  if (!cost || cost.input == null || cost.output == null) return undefined;
  const p: Pricing = { inputPerMTok: cost.input, outputPerMTok: cost.output };
  if (cost.cache_read != null) p.cachedInputPerMTok = cost.cache_read;
  if (cost.cache_write != null) p.cacheWritePerMTok = cost.cache_write;
  return p;
}

// The effort menu one model offers, minus the levels isolade declines
// (EXCLUDED_EFFORTS). `fallback` covers a model models.dev publishes no
// reasoning options for; pass [] to treat that as a hard error instead.
function effortMenu(m: ModelsDevModel, fallback: ChatEffort[]): ChatEffort[] {
  const advertised = m.reasoning_options?.find((o) => o.type === "effort")?.values;
  const menu = advertised?.length ? advertised : fallback;
  return menu.filter((e) => !EXCLUDED_EFFORTS.includes(e)) as ChatEffort[];
}

// ---------- Codex ----------

// Resolve each allowlisted OpenAI id against models.dev, mirroring the Claude
// half: same dataset, same fields, same reporting of ids it doesn't carry.
//
// This replaced a `codex app-server` `model/list` handshake. That was the better
// source in theory (the logged-in account knows which models it may use) and not
// in practice: the result is generated once from a maintainer's account and
// committed, so no user ever saw their own entitlements, while the dependency
// meant a catalog refresh needed codex installed and logged in. What we gave up
// with it is the `hidden` flag, which the allowlist now covers by hand, and the
// per-model default effort, which we pick ourselves anyway.
function toCodexEntries(
  db: ModelsDev,
  allowlist: readonly string[],
): { entries: CodexEntry[]; missing: string[]; extra: string[] } {
  const models = db.openai?.models ?? {};
  const entries: CodexEntry[] = [];
  const missing: string[] = [];
  for (const id of allowlist) {
    const m = models[id];
    if (!m) {
      missing.push(id);
      continue;
    }
    const supportedEfforts = effortMenu(m, []);
    const [firstEffort] = supportedEfforts;
    if (!firstEffort) {
      missing.push(`${id} (no advertised efforts)`);
      continue;
    }
    const defaultEffort = supportedEfforts.includes(CODEX_DEFAULT_EFFORT)
      ? CODEX_DEFAULT_EFFORT
      : firstEffort;
    entries.push({ id, name: m.name ?? id, supportedEfforts, defaultEffort });
  }
  // Informational, like the Claude half: a newly-shipped model shouldn't go
  // unnoticed just because the allowlist predates it. Only the gpt-5+ line is
  // worth reporting — models.dev carries every OpenAI model ever published.
  const offered = new Set(allowlist);
  const extra = Object.keys(models).filter(
    (id) => !offered.has(id) && /^gpt-[5-9]/.test(id) && models[id]?.reasoning_options?.length,
  );
  return { entries, missing, extra };
}

// models.dev pricing for the given OpenAI-provider ids, standard or fast-tier.
// Ids the dataset doesn't price are simply absent from the returned map. Codex
// reports no cache-creation tokens, so its entries omit cache-write and we drop
// that rate here — keeping it would show as perpetual drift against the
// committed records and price a bucket that is always zero.
function codexPricing(db: ModelsDev, ids: string[], mode: PricingMode = "standard") {
  const models = db.openai?.models ?? {};
  const out = new Map<string, Pricing>();
  for (const id of ids) {
    const m = models[id];
    const p = pricingFromCost(mode === "fast" ? m?.experimental?.modes?.fast?.cost : m?.cost);
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
    const supportedEfforts = effortMenu(m, ANTHROPIC_EFFORT_FALLBACK);
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
      fastPricing: fastPricingFrom(m),
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
function renderPricingLiteral(p: Pricing, indent: string, key = "pricing"): string {
  const lines = [`${indent}${key}: {`, `${indent}  inputPerMTok: ${p.inputPerMTok},`];
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
  if (e.fastPricing) lines.push(renderPricingLiteral(e.fastPricing, "    ", "fastPricing"));
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
    `    fastPricing: CODEX_FAST_PRICING[${JSON.stringify(e.id)}],`,
    "  },",
  ].join("\n");
}

// The lines of a codex pricing record, in catalog order, skipping unpriced ids.
function renderCodexPricingBlock(ids: string[], pricing: Map<string, Pricing>): string {
  return ids
    .filter((id) => pricing.has(id))
    .map((id) => renderCodexPricing(id, pricing.get(id)!))
    .join("\n");
}

// Render one pricing-record entry for a <codex-…pricing:…> block.
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
function reportCodexDrift(
  entries: CodexEntry[],
  pricing: Map<string, Pricing>,
  fastPricing: Map<string, Pricing>,
): boolean {
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
    // A model that loses its fast card (or never had one) drops the composer's
    // fast-mode toggle, so report that as drift too rather than only price moves.
    const liveFast = fastPricing.get(e.id);
    const currentFast = codexPricingFor(e.id, true);
    const hadFast = currentFast != null && !samePricing(currentFast, codexPricingFor(e.id));
    if (!liveFast && hadFast) {
      console.log(`  ! ${e.id} (no fast-tier rate on models.dev — fast mode will hide)`);
      drift = true;
    } else if (liveFast && (!hadFast || !samePricing(currentFast, liveFast))) {
      console.log(
        `  $ ${e.id} fast-tier price ${hadFast ? "changed" : "added"} → in=${liveFast.inputPerMTok} out=${liveFast.outputPerMTok}`,
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
  const db = await sharedDb();
  const { entries, missing, extra } = toCodexEntries(db, OPENAI_ALLOWLIST);
  if (missing.length) {
    throw new Error(
      `models.dev has no usable entry for: ${missing.join(", ")}. Remove them from OPENAI_ALLOWLIST or fix the id.`,
    );
  }
  if (entries.length === 0) throw new Error("no usable OpenAI models");
  const ids = entries.map((e) => e.id);
  const pricing = codexPricing(db, ids);
  const fastPricing = codexPricing(db, ids, "fast");

  console.log(`\nCodex: ${entries.length} model(s): ${ids.join(", ")}`);
  if (extra.length) console.log(`  on models.dev but not offered: ${extra.join(", ")}`);
  console.log(`  priced from models.dev: ${[...pricing.keys()].join(", ") || "(none)"}`);
  console.log(`  fast-tier rates: ${[...fastPricing.keys()].join(", ") || "(none)"}`);
  const drift = reportCodexDrift(entries, pricing, fastPricing);
  if (check) return { src, drift };

  let out = splice(src, CODEX_MARKERS, entries.map(renderCodexEntry).join("\n"));
  out = splice(out, PRICING_MARKERS, renderCodexPricingBlock(ids, pricing));
  out = splice(out, FAST_PRICING_MARKERS, renderCodexPricingBlock(ids, fastPricing));
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
