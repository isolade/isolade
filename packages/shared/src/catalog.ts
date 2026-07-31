import { z } from "zod";
import type { ChatEffort } from "./base";
import type { TokenUsage } from "./chat-render";
import { type ChatModelDefinition, chatModelSchema, type ModelPricing } from "./domain";

// Static catalog for both providers, generated at maintenance time by
// `bun run refresh-catalog` (see scripts/refresh-catalog.ts) from models.dev:
// first-party rate cards plus a per-model reasoning-effort matrix, for Claude
// and OpenAI alike. Static because the picker has to render before any VM boots
// or any CLI process exists (a new-chat draft has nothing to ask), and one
// source because neither CLI publishes prices. All models are always offered;
// per-profile visibility/tier is layered on top via ModelOverrides (see below).
//
// What stays hand-managed (the script never touches it): which ids to offer
// (ANTHROPIC_ALLOWLIST / OPENAI_ALLOWLIST), which effort levels to decline
// (EXCLUDED_EFFORTS), the default frontier/"More…" placement
// (MORE_BY_DEFAULT_MODEL_IDS), and the fallback effort menu the script uses for
// a model models.dev publishes no efforts for. See the script header for the
// full source-of-truth split.

// Which OpenAI models to offer, in picker order. Curated for the same reason as
// the Anthropic list below: models.dev carries every model OpenAI has ever
// published, with no notion of which ones make sense as a coding agent, so the
// set is ours to choose and the script fills in the details.
//
// This used to come from `codex app-server model/list` instead, on the theory
// that the logged-in account was the authority on which models exist. It wasn't
// worth it: the list is generated once at maintenance time from one maintainer's
// account and committed, so no user ever saw their own entitlements, and the
// dependency meant refreshing the catalog needed codex installed and logged in.
export const OPENAI_ALLOWLIST = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

// Effort levels we decline to offer even where a model advertises them.
//
// `ultra` is not a reasoning level at all on the wire: codex maps it to `max`
// before the request goes out (core/src/client.rs, reasoning_effort_for_request)
// and uses it locally as the switch for proactive multi-agent mode, where codex
// spawns sub-agents on its own initiative. Isolade orchestrates agents itself, so
// offering it would hand that decision to the CLI while looking like nothing more
// than a slider position; `max` buys the same reasoning at the same price without
// the behaviour change.
//
// `none` disables reasoning outright. No agentic loop here wants that, and
// codex's own account-scoped model list never offered it either — models.dev
// reports the raw API capability, which is a superset of what the CLIs menu.
export const EXCLUDED_EFFORTS: readonly string[] = ["ultra", "none"];

// Codex-side pricing by model id, in USD per million tokens. Neither codex's
// `model/list` nor its usage stream carries pricing, so we vendor a snapshot.
// The block between the markers is generated from models.dev
// (https://models.dev, MIT-licensed — first-party OpenAI rates) by
// `bun run refresh-catalog`; don't edit it by hand, re-run the script
// (its `--check` mode fails CI when upstream prices move, so each change is a
// reviewable PR). Feeds the static catalog entries above and the server's
// per-turn API-$ math via `codexPricingFor`. Changing these only affects future
// turns: historical usage is costed at the rate in effect and persisted
// per-turn (see the usage_events table), never recomputed from current pricing.
const CODEX_PRICING: Record<string, z.input<typeof chatModelSchema>["pricing"]> = {
  // <codex-pricing:start>
  "gpt-5.6-sol": { inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 30 },
  "gpt-5.6-terra": { inputPerMTok: 2.5, cachedInputPerMTok: 0.25, outputPerMTok: 15 },
  "gpt-5.6-luna": { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 6 },
  "gpt-5.5": { inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 30 },
  "gpt-5.4": { inputPerMTok: 2.5, cachedInputPerMTok: 0.25, outputPerMTok: 15 },
  "gpt-5.4-mini": { inputPerMTok: 0.75, cachedInputPerMTok: 0.075, outputPerMTok: 4.5 },
  // <codex-pricing:end>
};

// The same, for turns that ask for OpenAI's priority service tier — codex's
// "fast mode" (see ServiceTier::Fast, which goes out as `service_tier:
// "priority"`). models.dev publishes these as a separate rate card per model,
// tagged with that exact request body, so the split is upstream's, not ours.
// Roughly 2× list across the board; the picker computes the multiplier it shows
// from these two records rather than stating one.
const CODEX_FAST_PRICING: Record<string, z.input<typeof chatModelSchema>["pricing"]> = {
  // <codex-fast-pricing:start>
  "gpt-5.6-sol": { inputPerMTok: 10, cachedInputPerMTok: 1, outputPerMTok: 60 },
  "gpt-5.6-terra": { inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 30 },
  "gpt-5.6-luna": { inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 12 },
  "gpt-5.5": { inputPerMTok: 12.5, cachedInputPerMTok: 1.25, outputPerMTok: 75 },
  "gpt-5.4": { inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 30 },
  "gpt-5.4-mini": { inputPerMTok: 1.5, cachedInputPerMTok: 0.15, outputPerMTok: 9 },
  // <codex-fast-pricing:end>
};

// Pricing for delisted codex ids models.dev no longer carries, kept by hand so
// historical chats on these ids can still cost out on a live recompute.
// (Persisted usage is unaffected regardless; see the note above.)
const CODEX_PRICING_HISTORICAL: Record<string, z.input<typeof chatModelSchema>["pricing"]> = {
  "gpt-5.3-codex": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5.2": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
};

// `fast` asks for the priority-tier card. It falls back to the standard rates
// for an id with no fast card (delisted ids, or a model OpenAI doesn't offer the
// tier on) rather than returning nothing: a turn still has to be costed, and
// understating a premium beats reporting no price at all.
export function codexPricingFor(modelId: string, fast = false) {
  const standard = CODEX_PRICING[modelId] ?? CODEX_PRICING_HISTORICAL[modelId];
  if (!fast) return standard;
  return CODEX_FAST_PRICING[modelId] ?? standard;
}

// Which Anthropic models to offer, in picker order. Curated because models.dev
// lists every historical Claude model with no notion of what a given plan can
// reach. `bun run refresh-catalog` fills each id's name, context window, effort
// menu, and pricing from models.dev into the <anthropic:…> block below — add or
// remove an id here and re-run the script. Tier placement is separate
// (MORE_BY_DEFAULT_MODEL_IDS); keep the two in sync.
export const ANTHROPIC_ALLOWLIST = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export const CHAT_MODELS = [
  // Claude (Anthropic) models. The block below is generated from models.dev by
  // `bun run refresh-catalog` for the ids in ANTHROPIC_ALLOWLIST (name with the
  // "Claude " prefix stripped, contextWindow from `limit.context`, effort menu
  // from `reasoning_options`, pricing from `cost`). defaultEffort is fixed to
  // "high" (models.dev doesn't publish one) and clamped to each menu; the tier
  // (frontier vs "More…") is curated separately in MORE_BY_DEFAULT_MODEL_IDS.
  // Don't edit between the markers by hand; re-run the script instead.
  // <anthropic:start>
  {
    id: "claude-fable-5",
    name: "Fable 5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    pricing: {
      inputPerMTok: 10,
      cachedInputPerMTok: 1,
      cacheWritePerMTok: 12.5,
      outputPerMTok: 50,
    },
  },
  {
    id: "claude-opus-5",
    name: "Opus 5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    pricing: {
      inputPerMTok: 5,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      outputPerMTok: 25,
    },
    fastPricing: {
      inputPerMTok: 10,
      cachedInputPerMTok: 1,
      cacheWritePerMTok: 12.5,
      outputPerMTok: 50,
    },
  },
  {
    id: "claude-sonnet-5",
    name: "Sonnet 5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    pricing: {
      inputPerMTok: 2,
      cachedInputPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      outputPerMTok: 10,
    },
  },
  {
    id: "claude-opus-4-8",
    name: "Opus 4.8",
    provider: "anthropic",
    contextWindow: 1_000_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    pricing: {
      inputPerMTok: 5,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      outputPerMTok: 25,
    },
    fastPricing: {
      inputPerMTok: 10,
      cachedInputPerMTok: 1,
      cacheWritePerMTok: 12.5,
      outputPerMTok: 50,
    },
  },
  {
    id: "claude-opus-4-7",
    name: "Opus 4.7",
    provider: "anthropic",
    contextWindow: 1_000_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    pricing: {
      inputPerMTok: 5,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      outputPerMTok: 25,
    },
    fastPricing: {
      inputPerMTok: 30,
      cachedInputPerMTok: 3,
      cacheWritePerMTok: 37.5,
      outputPerMTok: 150,
    },
  },
  {
    id: "claude-opus-4-6",
    name: "Opus 4.6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    supportedEfforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    pricing: {
      inputPerMTok: 5,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      outputPerMTok: 25,
    },
    fastPricing: {
      inputPerMTok: 30,
      cachedInputPerMTok: 3,
      cacheWritePerMTok: 37.5,
      outputPerMTok: 150,
    },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Sonnet 4.6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    supportedEfforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    pricing: {
      inputPerMTok: 3,
      cachedInputPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
      outputPerMTok: 15,
    },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Haiku 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    pricing: {
      inputPerMTok: 1,
      cachedInputPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
      outputPerMTok: 5,
    },
  },
  // <anthropic:end>
  // Codex (OpenAI) models. The block below is generated by
  // `bun run refresh-catalog` for the ids in OPENAI_ALLOWLIST (name and effort
  // menu from models.dev; contextWindow omitted since codex reports
  // `modelContextWindow` per usage update, and defaultEffort fixed to "medium").
  // Both rate cards are attached by id from the records above. Each model's
  // default tier (frontier vs "More…") is curated separately in
  // MORE_BY_DEFAULT_MODEL_IDS — keep it in sync when this list changes. Don't
  // edit between the markers by hand; re-run the script instead.
  // <codex:start>
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.6-sol"],
    fastPricing: CODEX_FAST_PRICING["gpt-5.6-sol"],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.6-terra"],
    fastPricing: CODEX_FAST_PRICING["gpt-5.6-terra"],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.6-luna"],
    fastPricing: CODEX_FAST_PRICING["gpt-5.6-luna"],
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.5"],
    fastPricing: CODEX_FAST_PRICING["gpt-5.5"],
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.4"],
    fastPricing: CODEX_FAST_PRICING["gpt-5.4"],
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.4-mini"],
    fastPricing: CODEX_FAST_PRICING["gpt-5.4-mini"],
  },
  // <codex:end>
] as const satisfies readonly z.input<typeof chatModelSchema>[];

// Anthropic bills a cache write by how long the entry lives: the catalog's
// `cacheWritePerMTok` is the five-minute rate (1.25× input), and a one-hour
// write costs twice the input rate instead. Claude Code asks for one-hour
// entries for subscription users who are not in overage, so on those accounts
// most of a chat's cache writes are at this rate, not the catalog's.
export const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

// What each token bucket of `usage` costs at a model's list prices. The buckets
// in TokenUsage are disjoint, so these add up to the whole (see `total`).
// Reasoning tokens bill at the output rate, which is how both providers price
// them. A rate the catalog doesn't publish (codex has no cache-write rate, and a
// model may have no pricing entry at all) contributes nothing rather than a
// guess, so a missing rate understates rather than invents.
//
// `cacheWrite1hTokens` splits the cache-write bucket by TTL: that many of its
// tokens are priced at the one-hour rate and the rest at the catalog's
// five-minute one. Left out, everything is five-minute, which is what the
// provider means when it reports no split.
export interface TokenCostBreakdown {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

export function tokenCostBreakdown(
  usage: TokenUsage,
  pricing: ModelPricing | undefined,
  cacheWrite1hTokens = 0,
): TokenCostBreakdown {
  const perMTok = (tokens: number, rate: number | undefined) =>
    rate == null ? 0 : (tokens * rate) / 1_000_000;
  // Never more than were written, however the two figures reached us.
  const writes1h = Math.min(Math.max(0, cacheWrite1hTokens), usage.cacheCreationInputTokens);
  const parts = {
    input: perMTok(usage.inputTokens, pricing?.inputPerMTok),
    cachedInput: perMTok(usage.cachedInputTokens, pricing?.cachedInputPerMTok),
    cacheWrite: perMTok(usage.cacheCreationInputTokens - writes1h, pricing?.cacheWritePerMTok),
    cacheWrite1h: perMTok(
      writes1h,
      pricing?.inputPerMTok == null
        ? undefined
        : pricing.inputPerMTok * CACHE_WRITE_1H_INPUT_MULTIPLIER,
    ),
    output: perMTok(usage.outputTokens, pricing?.outputPerMTok),
    reasoningOutput: perMTok(usage.reasoningOutputTokens, pricing?.outputPerMTok),
  };
  return {
    ...parts,
    total:
      parts.input +
      parts.cachedInput +
      parts.cacheWrite +
      parts.cacheWrite1h +
      parts.output +
      parts.reasoningOutput,
  };
}

// Preferred default for new chats. The new-chat picker snaps to a visible
// fallback when this id has been hidden for the active profile (see
// NewInstancePane).
export const DEFAULT_CHAT_MODEL_ID = "gpt-5.6-sol";
export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-opus-5";
export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-sol";

// Catalog-default tier: non-frontier releases (older versions + smaller
// siblings) start tucked behind a "More…" affordance in the picker; everything
// else is frontier. This is only the *default* — each profile can override any
// model's tier (or hide it) via ModelOverrides, and a model whose tier the
// user hasn't touched follows catalog changes here.
const MORE_BY_DEFAULT_MODEL_IDS = new Set<string>([
  // Keep the current-gen flagships (Fable 5, Opus 5, Sonnet 5) at the top
  // level; older Opus/Sonnet releases and Haiku start under "More…".
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  // Keep the two current-gen flagships (Sol, Terra) at the top level; the
  // fast/cheap sibling and the older gpt-5.x line start under "More…".
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

export function findChatModel(id: string): ChatModelDefinition | undefined {
  return CHAT_MODELS.find((model) => model.id === id);
}

// ---- per-profile model visibility/tier overrides ----
//
// A model sits in one of three tiers in the picker: "default" (top level),
// "more" (behind the More… affordance), or "hidden" (not offered at all). Each
// model has a catalog default of "default" or "more" (never "hidden"). A
// profile stores only the *deltas* from that default, so:
//   - adding a model to the catalog → it shows at its catalog tier for everyone
//   - deleting a model → its (now-dangling) override is pruned and it's gone
//   - moving a model's catalog default into "more" → follows for every profile
//     that hasn't overridden *that* model's tier
// Reverting a model to its catalog default drops the stored field, and an entry
// with no fields left is dropped entirely, so future catalog changes to that
// model take effect again.
//
// Each override is an OBJECT (not a bare tier string) so the format can grow
// per-model settings later — e.g. as isolade grows toward the broader models.dev
// provider set, an entry might carry an alias, pricing override, or provider
// config alongside `tier`. The object is validated strictly (see profile-config's
// modelsTableSchema): an unknown field is rejected, not silently kept, so adding
// a per-model setting means extending the schema.

export type ModelTier = "default" | "more" | "hidden";

/** Per-model override. Only `tier` exists today; a future per-model setting is
 *  added here and to the schema, which rejects any field it doesn't know. */
export type ModelOverride = { tier?: ModelTier };
export type ModelOverrides = Record<string, ModelOverride>;

/** The catalog's built-in tier for a model, ignoring any profile override. */
export function defaultModelTier(id: string): "default" | "more" {
  return MORE_BY_DEFAULT_MODEL_IDS.has(id) ? "more" : "default";
}

/** The tier a model actually sits in for a profile, override applied. */
export function effectiveModelTier(id: string, overrides: ModelOverrides): ModelTier {
  return overrides[id]?.tier ?? defaultModelTier(id);
}

/**
 * Return overrides with `id`'s tier set to `tier`, but store nothing when
 * `tier` is the catalog default — so a manual revert leaves no delta behind.
 * `tier` is the only field an entry carries, so a reverted entry is dropped
 * entirely. Pure; the caller persists the result.
 */
export function setModelTierOverride(
  overrides: ModelOverrides,
  id: string,
  tier: ModelTier,
): ModelOverrides {
  const next = { ...overrides };
  if (tier === defaultModelTier(id)) delete next[id];
  else next[id] = { tier };
  return next;
}

/** Drop entries for ids no longer in `catalog`, so removed models don't linger. */
export function pruneModelOverrides(
  overrides: ModelOverrides,
  catalog: readonly ChatModelDefinition[] = CHAT_MODELS,
): ModelOverrides {
  const ids = new Set(catalog.map((m) => m.id));
  const next: ModelOverrides = {};
  for (const [id, entry] of Object.entries(overrides)) if (ids.has(id)) next[id] = entry;
  return next;
}

/**
 * Split a catalog into picker sections by effective tier, preserving catalog
 * order. `keepVisibleId`, when its model is hidden, is surfaced under "more" so
 * a chat already using a since-hidden model still shows it (with its real name)
 * and stays switchable.
 */
export function splitModelsByTier(
  catalog: readonly ChatModelDefinition[],
  overrides: ModelOverrides,
  keepVisibleId?: string,
): { frontier: ChatModelDefinition[]; more: ChatModelDefinition[]; hidden: ChatModelDefinition[] } {
  const frontier: ChatModelDefinition[] = [];
  const more: ChatModelDefinition[] = [];
  const hidden: ChatModelDefinition[] = [];
  for (const model of catalog) {
    const tier = effectiveModelTier(model.id, overrides);
    if (tier === "hidden") {
      if (model.id === keepVisibleId) more.push(model);
      else hidden.push(model);
    } else if (tier === "more") {
      more.push(model);
    } else {
      frontier.push(model);
    }
  }
  return { frontier, more, hidden };
}

// Returns the stored effort as-is, falling back to "high" only for legacy
// rows that predate the effort column. Model swaps are responsible for
// clamping the stored effort against the new model's menu at PATCH time,
// so chat hydration paths don't need a profile-catalog dependency here.
export function resolveEffort(effort: ChatEffort | null | undefined): ChatEffort {
  return effort ?? "high";
}

// Returns `effort` if `model` supports it, otherwise the model's declared
// default. Used by the new-chat drafter (no server in the loop)
// and the chat PATCH route (authoritative server-side clamp on model swap).
export function clampEffortToModel(effort: ChatEffort, model: ChatModelDefinition): ChatEffort {
  return model.supportedEfforts.includes(effort) ? effort : model.defaultEffort;
}
