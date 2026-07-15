import {
  type AggregateTotals,
  type ChatProvider,
  codexPricingFor,
  findChatModel,
  type ModelPricing,
  type RatePlan,
  resolveRatePlan,
  type UsageStats,
} from "../contracts";
import { readClaudeOauthSecret, type UsageAuthStore } from "../usage";
import type { TokenUsage } from "./backend";

// What we attach to the `usage` SSE event so the UI can render a per-chat
// share of the user's subscription window. Numbers are deliberately
// labeled "approximate" in the UI. See the catalog's RATE_PLANS doc for
// the source of the denominators.
export interface SubscriptionShare {
  plan: { id: string; label: string };
  // This chat's cumulative effective-input-equivalent tokens, expressed as
  // a percentage of the plan's budget for each window. Null if the plan
  // doesn't gate that window or we don't have the data.
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  // The most recent observed window utilization from the upstream usage
  // endpoint. Surfaced so the UI can show "this chat: 6% · window now at
  // 78%". May be null if we haven't fetched stats yet or the call failed.
  fiveHourCurrentPct: number | null;
  sevenDayCurrentPct: number | null;
}

// Convert a TokenUsage tally into "input-equivalent tokens" using the
// model's API pricing ratios. This is our subscription-window denominator
// shape:
//   - Fresh input counts 1×.
//   - cache_write counts 1× (Anthropic's ITPM rule. On the API the dollar
//     premium is 1.25× but rate-limit weight is still 1×).
//   - cache_read scales by the pricing ratio (defaults to 10%, matching
//     Anthropic's published cached billing rate, and codex is similar).
//   - Output (incl. reasoning) scales by the output-to-input pricing ratio
//     because output isn't free against the window even though Anthropic counts
//     it under a separate OTPM bucket on the API side.
export function effectiveInputTokens(total: TokenUsage, pricing: ModelPricing): number {
  const cachedRatio =
    pricing.cachedInputPerMTok != null && pricing.inputPerMTok > 0
      ? pricing.cachedInputPerMTok / pricing.inputPerMTok
      : 0;
  const outputRatio = pricing.inputPerMTok > 0 ? pricing.outputPerMTok / pricing.inputPerMTok : 0;
  return (
    total.inputTokens +
    total.cacheCreationInputTokens +
    total.cachedInputTokens * cachedRatio +
    (total.outputTokens + total.reasoningOutputTokens) * outputRatio
  );
}

export function pricingFor(provider: ChatProvider, modelId: string): ModelPricing | undefined {
  if (provider === "anthropic") return findChatModel(modelId)?.pricing;
  return codexPricingFor(modelId);
}

// A resolved plan plus the live window utilization observed for it. The output
// of planAndWindowsFor, named so buildShare and its two callers agree on shape.
interface ResolvedPlan {
  plan: RatePlan;
  fiveHourCurrentPct: number | null;
  sevenDayCurrentPct: number | null;
}

// Assemble the SubscriptionShare payload: this chat/bucket's effective-input
// tokens (`eff`) as a percentage of each of the plan's window budgets, plus the
// live observed utilization carried straight through. Shared by the per-chat
// and lifetime-aggregate paths so the payload shape and the percentage formula
// can't drift between them.
function buildShare(eff: number, resolved: ResolvedPlan): SubscriptionShare {
  const pct = (budget: number | null) => (budget && budget > 0 ? (eff / budget) * 100 : null);
  return {
    plan: { id: resolved.plan.id, label: resolved.plan.label },
    fiveHourPct: pct(resolved.plan.fiveHourTokens),
    sevenDayPct: pct(resolved.plan.sevenDayTokens),
    fiveHourCurrentPct: resolved.fiveHourCurrentPct,
    sevenDayCurrentPct: resolved.sevenDayCurrentPct,
  };
}

// Compute the subscription-share payload from an already-fetched, profile-scoped
// usage snapshot (no network call of its own, since the caller passes `stats`, which
// is the 20s-cached per-profile result). Returns undefined when we can't make a
// reasonable estimate, e.g. missing pricing or unknown plan. The UI just omits the
// share row in that case. `authStore` is the profile's credential store, used
// only for the plan-tier fallback when the live Claude usage call is rate-
// limited (see planAndWindowsFor).
export async function computeSubscriptionShare(opts: {
  provider: ChatProvider;
  modelId: string;
  total: TokenUsage;
  stats: UsageStats;
  authStore: UsageAuthStore;
}): Promise<SubscriptionShare | undefined> {
  const pricing = pricingFor(opts.provider, opts.modelId);
  if (!pricing) return undefined;

  const resolved = await planAndWindowsFor(opts.provider, opts.stats, opts.authStore);
  if (!resolved) return undefined;

  return buildShare(effectiveInputTokens(opts.total, pricing), resolved);
}

// Resolve plan + observed window util for one provider from the upstream
// usage snapshot. Pulled out of computeSubscriptionShare so the lifetime
// aggregator can reuse it without re-fetching the cached stats per chat.
async function planAndWindowsFor(
  provider: ChatProvider,
  stats: UsageStats,
  authStore: UsageAuthStore,
): Promise<ResolvedPlan | null> {
  if (provider === "anthropic") {
    if (stats.claude.ok) {
      const claude = stats.claude.data;
      const plan = resolveRatePlan(
        claude.account?.rateLimitTier ?? claude.account?.subscriptionType ?? null,
      );
      if (plan) {
        return {
          plan,
          fiveHourCurrentPct: claude.fiveHour?.utilization ?? null,
          sevenDayCurrentPct: claude.sevenDay?.utilization ?? null,
        };
      }
    }
    // Fallback: /oauth/usage may be rate-limited (Anthropic 429s for several
    // minutes at a time), but the stored OAuth credential
    // already carries `rateLimitTier`, no network needed. Resolve the plan
    // from there so the lifetime share keeps rendering. Current-window
    // utilization stays null, since we only had it from the rate-limited call.
    const secret = await readClaudeOauthSecret(authStore);
    const plan = resolveRatePlan(secret?.rateLimitTier ?? secret?.subscriptionType ?? null);
    if (!plan) return null;
    return { plan, fiveHourCurrentPct: null, sevenDayCurrentPct: null };
  }
  if (!stats.codex.ok) return null;
  const codex = stats.codex.data;
  const plan = resolveRatePlan(codex.planType ?? null);
  if (!plan) return null;
  return {
    plan,
    fiveHourCurrentPct: codex.primary?.utilization ?? null,
    sevenDayCurrentPct: codex.secondary?.utilization ?? null,
  };
}

// Attach a `subscriptionShare` to each per-provider aggregate bucket, using
// the already-summed `effectiveInputTokens` divided by the resolved plan's
// budget. Mutates `aggregate` in place for ergonomic call-site code. The
// total bucket stays null (no single plan applies across providers).
export async function annotateAggregateShares(
  aggregate: AggregateTotals,
  stats: UsageStats,
  authStore: UsageAuthStore,
): Promise<void> {
  for (const provider of ["anthropic", "openai"] as const) {
    const bucket = aggregate[provider];
    const resolved = await planAndWindowsFor(provider, stats, authStore);
    if (!resolved) continue;
    bucket.subscriptionShare = buildShare(bucket.effectiveInputTokens, resolved);
  }
}
