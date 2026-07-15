import { describe, expect, it } from "bun:test";
import type { TokenUsage } from "../src/chat/backend";
import { computeSubscriptionShare, effectiveInputTokens } from "../src/chat/subscription-share";
import { CHAT_MODELS, type ModelPricing, type UsageStats } from "../src/contracts";

function usage(p: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    ...p,
  };
}

// inputPerMTok=10 → cached ratio 1/10=0.1, output ratio 50/10=5.
const PRICING: ModelPricing = {
  inputPerMTok: 10,
  cachedInputPerMTok: 1,
  outputPerMTok: 50,
};

describe("effectiveInputTokens", () => {
  it("weights each bucket by the model's pricing ratios", () => {
    // input ×1 + cacheCreation ×1 + cached ×0.1 + (output+reasoning) ×5
    const eff = effectiveInputTokens(
      usage({
        inputTokens: 100,
        cacheCreationInputTokens: 10,
        cachedInputTokens: 200,
        outputTokens: 30,
      }),
      PRICING,
    );
    expect(eff).toBe(100 + 10 + 200 * 0.1 + 30 * 5);
  });

  it("counts reasoning output at the output rate", () => {
    const eff = effectiveInputTokens(
      usage({ outputTokens: 10, reasoningOutputTokens: 20 }),
      PRICING,
    );
    expect(eff).toBe((10 + 20) * 5);
  });

  it("treats cached tokens as free when the model has no cached rate", () => {
    const noCached: ModelPricing = { inputPerMTok: 10, outputPerMTok: 50 };
    const eff = effectiveInputTokens(usage({ inputTokens: 100, cachedInputTokens: 999 }), noCached);
    expect(eff).toBe(100); // cached contributes 0 without a cachedInputPerMTok
  });

  it("avoids divide-by-zero when inputPerMTok is 0 (ratios collapse to 0)", () => {
    const free: ModelPricing = {
      inputPerMTok: 0,
      cachedInputPerMTok: 1,
      outputPerMTok: 50,
    };
    const eff = effectiveInputTokens(
      usage({
        inputTokens: 100,
        cacheCreationInputTokens: 10,
        cachedInputTokens: 200,
        outputTokens: 30,
      }),
      free,
    );
    // Only the 1×-weighted buckets survive: input + cacheCreation.
    expect(eff).toBe(110);
  });
});

const ANTHROPIC_MODEL = CHAT_MODELS.find((m) => m.provider === "anthropic")!.id;
const CODEX_MODEL = "gpt-5.5";

function win(utilization: number) {
  return { utilization, resetsAt: null, windowSeconds: null };
}

// Build a UsageStats snapshot with each provider defaulting to "unavailable".
// Mirrors what the per-profile getUsageStats hands computeSubscriptionShare.
function stats(over: Partial<Pick<UsageStats, "claude" | "codex">>): UsageStats {
  return {
    fetchedAtMs: 0,
    claude: over.claude ?? { ok: false, error: "no claude" },
    codex: over.codex ?? { ok: false, error: "no codex" },
    aggregate: null,
  };
}

// A signed-out profile store: the plan-tier fallback finds no credential. Used
// by cases that resolve entirely from live stats.
const emptyStore = { read: () => null };

describe("computeSubscriptionShare", () => {
  // Regression guard: the share must come from the passed profile-scoped stats,
  // NOT a global fetch. Previously Codex resolved via a global default that this
  // refactor makes "unavailable", which silently dropped the Codex share.
  it("computes a Codex share from the passed profile-scoped stats", async () => {
    const share = await computeSubscriptionShare({
      provider: "openai",
      modelId: CODEX_MODEL,
      total: usage({ inputTokens: 1000 }),
      stats: stats({
        codex: {
          ok: true,
          data: {
            email: null,
            planType: "plus",
            activeLimit: null,
            primary: win(42),
            secondary: win(7),
            credits: null,
          },
        },
      }),
      authStore: emptyStore,
    });
    expect(share?.plan.id).toBe("plus");
    expect(share?.fiveHourCurrentPct).toBe(42);
    expect(share?.sevenDayCurrentPct).toBe(7);
  });

  it("computes a Claude share from the passed stats", async () => {
    const share = await computeSubscriptionShare({
      provider: "anthropic",
      modelId: ANTHROPIC_MODEL,
      total: usage({ inputTokens: 1000 }),
      stats: stats({
        claude: {
          ok: true,
          data: {
            account: {
              email: null,
              organizationName: null,
              rateLimitTier: "max_5x",
              subscriptionType: null,
            },
            fiveHour: win(12),
            sevenDay: win(3),
            weeklyWindows: [{ id: "all", label: "All models", window: win(3) }],
            sevenDayOpus: null,
            sevenDaySonnet: null,
            extraUsage: null,
          },
        },
      }),
      authStore: emptyStore,
    });
    expect(share?.plan.id).toBe("max_5x");
    expect(share?.fiveHourCurrentPct).toBe(12);
  });

  // When live Claude usage is rate-limited, the plan tier is resolved from the
  // profile's OWN stored credential, so this checks it reads the injected store
  // rather than a process-global one.
  it("falls back to the profile's stored plan tier when live Claude usage is unavailable", async () => {
    const share = await computeSubscriptionShare({
      provider: "anthropic",
      modelId: ANTHROPIC_MODEL,
      total: usage({ inputTokens: 1000 }),
      stats: stats({ claude: { ok: false, error: "rate-limited" } }),
      authStore: {
        read: (p) =>
          p === "claude" ? JSON.stringify({ claudeAiOauth: { rateLimitTier: "max_20x" } }) : null,
      },
    });
    expect(share?.plan.id).toBe("max_20x");
    // No live window data survived the rate-limit, only the plan tier.
    expect(share?.fiveHourCurrentPct).toBeNull();
  });

  it("returns undefined when the provider has no usable stats", async () => {
    const share = await computeSubscriptionShare({
      provider: "openai",
      modelId: CODEX_MODEL,
      total: usage({ inputTokens: 1000 }),
      stats: stats({}),
      authStore: emptyStore,
    });
    expect(share).toBeUndefined();
  });
});
