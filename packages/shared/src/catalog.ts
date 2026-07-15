import { z } from "zod";
import type { ChatEffort } from "./base";
import { type ChatModelDefinition, chatModelSchema, type RatePlan } from "./domain";

// Static catalog for both providers. Both halves are generated at maintenance
// time by `bun run refresh-catalog` (see scripts/refresh-catalog.ts) from
// models.dev — first-party rate cards and, for Claude, a per-model
// reasoning-effort matrix — so the picker is instant, uniform, and works
// offline before any build exists. The old dynamic discovery is gone: Codex no
// longer boots a one-shot VM to call the app-server's `model/list`, and Claude
// no longer assumes every 4.x model accepts all five efforts (models.dev
// publishes the real per-model menu; the earlier assumption over-offered
// `xhigh` on models that don't take it). All models are always offered;
// per-profile visibility/tier is layered on top via ModelOverrides (see below).
//
// What stays hand-managed (the script never touches it): which Anthropic ids to
// offer (ANTHROPIC_ALLOWLIST — models.dev has no per-subscription view and the
// `claude` CLI has no model-list command), the default frontier/"More…"
// placement (MORE_BY_DEFAULT_MODEL_IDS), and the fallback effort menu the script
// uses for a Claude model models.dev doesn't publish efforts for. See the
// script header for the full source-of-truth split.

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

// Pricing for delisted codex ids models.dev no longer carries, kept by hand so
// historical chats on these ids can still cost out on a live recompute.
// (Persisted usage is unaffected regardless; see the note above.)
const CODEX_PRICING_HISTORICAL: Record<string, z.input<typeof chatModelSchema>["pricing"]> = {
  "gpt-5.3-codex": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
  "gpt-5.2": { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 },
};

export function codexPricingFor(modelId: string) {
  return CODEX_PRICING[modelId] ?? CODEX_PRICING_HISTORICAL[modelId];
}

// Which Anthropic models to offer, in picker order. Unlike the Codex half —
// whose list comes from the user's logged-in `codex app-server` — there is no
// per-subscription source for Claude: models.dev lists every historical Claude
// model with no notion of what a given plan can reach, and the `claude` CLI has
// no model-list command. So the Anthropic list is a curated allowlist.
// `bun run refresh-catalog` fills each id's name, context window, effort menu,
// and pricing from models.dev into the <anthropic:…> block below — add or
// remove an id here and re-run the script. Tier placement is separate
// (MORE_BY_DEFAULT_MODEL_IDS); keep the two in sync.
export const ANTHROPIC_ALLOWLIST = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
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
  // Codex (OpenAI) models. The block below is generated from `codex app-server`
  // `model/list` by `bun run refresh-catalog` (hidden entries dropped,
  // efforts copied through verbatim, contextWindow omitted since codex reports
  // `modelContextWindow` per usage update). Pricing is attached by
  // id from CODEX_PRICING, and each model's default tier (frontier vs "More…")
  // is curated separately in MORE_BY_DEFAULT_MODEL_IDS — both are hand-managed,
  // so keep them in sync when this list changes. Don't edit between the markers
  // by hand; re-run the script instead.
  // <codex:start>
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.6-sol"],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.6-terra"],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.6-luna"],
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
    pricing: CODEX_PRICING["gpt-5.5"],
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.4"],
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    provider: "openai",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    pricing: CODEX_PRICING["gpt-5.4-mini"],
  },
  // <codex:end>
] as const satisfies readonly z.input<typeof chatModelSchema>[];

// Per-plan token budgets, used as the denominator when expressing this
// chat's consumption as a fraction of the rate-limit window. We can't
// publish these from a single authoritative source, and Anthropic deliberately
// doesn't disclose the exact subscription-side conversion, so these are
// best-effort estimates from public blog posts and Anthropic's own "5x/20x
// of Pro" framing. The UI labels the resulting share as "approximate".
//
// `fiveHourTokens` covers Anthropic's 5h window (and ChatGPT's primary).
// `sevenDayTokens` covers Anthropic's 7d window. Opus-only weekly cap is
// represented by an Opus-specific plan row below.
export const RATE_PLANS: Record<string, RatePlan> = {
  // Claude plans. Tier strings match what we read from the OAuth secret
  // (`rateLimitTier`), so keep these spellings aligned with usage.ts.
  pro: {
    id: "pro",
    label: "Claude Pro",
    fiveHourTokens: 250_000,
    sevenDayTokens: 4_000_000,
  },
  max_5x: {
    id: "max_5x",
    label: "Claude Max 5×",
    fiveHourTokens: 1_250_000,
    sevenDayTokens: 20_000_000,
  },
  max_20x: {
    id: "max_20x",
    label: "Claude Max 20×",
    fiveHourTokens: 5_000_000,
    sevenDayTokens: 80_000_000,
  },
  // ChatGPT plans seen via /wham/usage `plan_type` (lowercased on our side).
  // Token budgets are calibrated from OpenAI's published per-plan message
  // ranges on the Codex pricing page (15–80 GPT-5.5 messages / 5h for Plus,
  // ~14 credits / message, 125 credits / 1M input tokens for GPT-5.5),
  // which puts Plus at roughly 4M input-equivalent tokens / 5h. Pro 5×/20×
  // multiply accordingly. OpenAI explicitly bundles Business and Team at
  // Plus tier. Plus's 5-hour limits "also apply to Business and Team".
  plus: {
    id: "plus",
    label: "ChatGPT Plus",
    fiveHourTokens: 4_000_000,
    sevenDayTokens: 30_000_000,
  },
  team: {
    id: "team",
    label: "ChatGPT Team",
    fiveHourTokens: 4_000_000,
    sevenDayTokens: 30_000_000,
  },
  business: {
    id: "business",
    label: "ChatGPT Business",
    fiveHourTokens: 4_000_000,
    sevenDayTokens: 30_000_000,
  },
  pro_5x: {
    id: "pro_5x",
    label: "ChatGPT Pro 5×",
    fiveHourTokens: 20_000_000,
    sevenDayTokens: 150_000_000,
  },
  pro_20x: {
    id: "pro_20x",
    label: "ChatGPT Pro 20×",
    fiveHourTokens: 80_000_000,
    sevenDayTokens: 600_000_000,
  },
  // Enterprise: OpenAI doesn't publish concrete Codex caps. "Codex-only
  // seats have no rate limits" per their docs, but regular Enterprise
  // seats with Codex bundled do have caps. Use 2× Pro 20× as a
  // best-effort upper estimate.
  enterprise: {
    id: "enterprise",
    label: "ChatGPT Enterprise",
    fiveHourTokens: 160_000_000,
    sevenDayTokens: 1_200_000_000,
  },
};

// Best-effort mapping from upstream `rateLimitTier` / `planType` strings to
// our internal plan ids. We accept several spellings because Anthropic and
// OpenAI haven't promised stable values here.
export function resolveRatePlan(tierOrPlan: string | null | undefined): RatePlan | undefined {
  if (!tierOrPlan) return undefined;
  const k = tierOrPlan.toLowerCase().replace(/[\s-]+/g, "_");
  if (k.includes("max") && k.includes("20")) return RATE_PLANS.max_20x;
  if (k.includes("max") && k.includes("5")) return RATE_PLANS.max_5x;
  if (k.includes("max")) return RATE_PLANS.max_20x;
  if (k === "pro" || k === "claude_pro") return RATE_PLANS.pro;
  if (k.includes("pro") && k.includes("20")) return RATE_PLANS.pro_20x;
  if (k.includes("pro") && k.includes("5")) return RATE_PLANS.pro_5x;
  if (k === "plus" || k.includes("chatgpt_plus")) return RATE_PLANS.plus;
  if (k.includes("enterprise")) return RATE_PLANS.enterprise;
  if (k.includes("business")) return RATE_PLANS.business;
  // ChatGPT Team appears as `team` from /wham/usage. Claude Team comes
  // through as `subscriptionType: "team"` and is handled upstream by
  // preferring `rateLimitTier` (which says max_5x / max_20x). So treat
  // bare "team" as the ChatGPT plan.
  if (k === "team" || k.includes("chatgpt_team")) return RATE_PLANS.team;
  return RATE_PLANS[k];
}

// Preferred default for new chats. The new-chat picker snaps to a visible
// fallback when this id has been hidden for the active profile (see
// NewInstancePane).
export const DEFAULT_CHAT_MODEL_ID = "gpt-5.6-sol";
export const DEFAULT_ANTHROPIC_MODEL_ID = "claude-opus-4-8";
export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-sol";

// Catalog-default tier: non-frontier releases (older versions + smaller
// siblings) start tucked behind a "More…" affordance in the picker; everything
// else is frontier. This is only the *default* — each profile can override any
// model's tier (or hide it) via ModelOverrides, and a model whose tier the
// user hasn't touched follows catalog changes here.
const MORE_BY_DEFAULT_MODEL_IDS = new Set<string>([
  // Keep the current-gen flagships (Fable 5, Opus 4.8, Sonnet 5) at the top
  // level; older Opus/Sonnet releases and Haiku start under "More…".
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
