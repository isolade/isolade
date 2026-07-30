import { describe, expect, it } from "bun:test";
import {
  CHAT_MODELS,
  type ChatModelDefinition,
  codexPricingFor,
  defaultModelTier,
  effectiveModelTier,
  findChatModel,
  type ModelOverrides,
  pruneModelOverrides,
  setModelTierOverride,
  splitModelsByTier,
  tokenCostBreakdown,
} from "../src/catalog";

describe("static catalog", () => {
  it("ships both anthropic and openai models", () => {
    expect(CHAT_MODELS.some((m) => m.provider === "anthropic")).toBe(true);
    expect(CHAT_MODELS.some((m) => m.provider === "openai")).toBe(true);
  });

  it("has unique ids", () => {
    const ids = CHAT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("defaultModelTier", () => {
  it("puts frontier models at the top and legacy ones under More", () => {
    expect(defaultModelTier("claude-opus-5")).toBe("default");
    expect(defaultModelTier("gpt-5.6-sol")).toBe("default");
    expect(defaultModelTier("gpt-5.5")).toBe("more");
    expect(defaultModelTier("claude-opus-4-8")).toBe("more");
  });
});

describe("effectiveModelTier", () => {
  it("falls back to the catalog default when there's no override", () => {
    expect(effectiveModelTier("claude-opus-5", {})).toBe("default");
    expect(effectiveModelTier("gpt-5.5", {})).toBe("more");
  });

  it("honors an override", () => {
    const overrides: ModelOverrides = {
      "claude-opus-5": { tier: "hidden" },
      "gpt-5.5": { tier: "default" },
    };
    expect(effectiveModelTier("claude-opus-5", overrides)).toBe("hidden");
    expect(effectiveModelTier("gpt-5.5", overrides)).toBe("default");
  });
});

describe("setModelTierOverride", () => {
  it("stores a delta that differs from the catalog default", () => {
    const next = setModelTierOverride({}, "claude-opus-5", "hidden");
    expect(next).toEqual({ "claude-opus-5": { tier: "hidden" } });
  });

  it("drops the entry when reverting to the catalog default", () => {
    const start: ModelOverrides = { "claude-opus-5": { tier: "hidden" } };
    const next = setModelTierOverride(start, "claude-opus-5", "default");
    expect(next).toEqual({});
    // Pure: the input is untouched.
    expect(start).toEqual({ "claude-opus-5": { tier: "hidden" } });
  });

  it("stores 'default' when a More-by-default model is pulled up", () => {
    const next = setModelTierOverride({}, "gpt-5.5", "default");
    expect(next).toEqual({ "gpt-5.5": { tier: "default" } });
    // ...and reverting to its 'more' default clears it again.
    expect(setModelTierOverride(next, "gpt-5.5", "more")).toEqual({});
  });
});

describe("pruneModelOverrides", () => {
  it("drops ids no longer in the catalog", () => {
    const overrides: ModelOverrides = {
      "claude-opus-5": { tier: "hidden" },
      "gone-9.9": { tier: "more" },
    };
    expect(pruneModelOverrides(overrides)).toEqual({ "claude-opus-5": { tier: "hidden" } });
  });
});

describe("splitModelsByTier", () => {
  const catalog: ChatModelDefinition[] = [
    {
      id: "a",
      name: "A",
      provider: "anthropic",
      supportedEfforts: ["high"],
      defaultEffort: "high",
    },
    {
      id: "b",
      name: "B",
      provider: "anthropic",
      supportedEfforts: ["high"],
      defaultEffort: "high",
    },
    {
      id: "c",
      name: "C",
      provider: "anthropic",
      supportedEfforts: ["high"],
      defaultEffort: "high",
    },
  ];

  it("splits by effective tier, preserving catalog order", () => {
    const overrides: ModelOverrides = { b: { tier: "more" }, c: { tier: "hidden" } };
    const { frontier, more, hidden } = splitModelsByTier(catalog, overrides);
    expect(frontier.map((m) => m.id)).toEqual(["a"]);
    expect(more.map((m) => m.id)).toEqual(["b"]);
    expect(hidden.map((m) => m.id)).toEqual(["c"]);
  });

  it("keeps a hidden current model visible under More", () => {
    const overrides: ModelOverrides = { c: { tier: "hidden" } };
    const { more, hidden } = splitModelsByTier(catalog, overrides, "c");
    expect(more.map((m) => m.id)).toContain("c");
    expect(hidden.map((m) => m.id)).not.toContain("c");
  });
});

describe("tokenCostBreakdown", () => {
  const pricing = {
    inputPerMTok: 10,
    cachedInputPerMTok: 1,
    cacheWritePerMTok: 12.5,
    outputPerMTok: 50,
  };
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 2_000_000,
    cacheCreationInputTokens: 400_000,
    outputTokens: 100_000,
    reasoningOutputTokens: 20_000,
    totalTokens: 3_520_000,
  };

  it("prices each bucket separately and sums them", () => {
    const cost = tokenCostBreakdown(usage, pricing);
    expect(cost.input).toBeCloseTo(10, 10);
    expect(cost.cachedInput).toBeCloseTo(2, 10);
    expect(cost.cacheWrite).toBeCloseTo(5, 10);
    expect(cost.output).toBeCloseTo(5, 10);
    // Reasoning bills at the output rate, which is how both providers charge it.
    expect(cost.reasoningOutput).toBeCloseTo(1, 10);
    expect(cost.total).toBeCloseTo(23, 10);
  });

  it("prices a one-hour cache write at twice input, not the catalog's 1.25x", () => {
    // Anthropic bills by cache TTL and only the five-minute rate is on the rate
    // card. Claude Code asks for one-hour entries on subscription accounts, so
    // pricing every write at 1.25x understates the largest bucket of a turn.
    const writes = {
      ...usage,
      cacheCreationInputTokens: 1_000_000,
      cache: undefined,
    };
    const allFiveMinute = tokenCostBreakdown(writes, pricing);
    expect(allFiveMinute.cacheWrite).toBeCloseTo(12.5, 10);
    expect(allFiveMinute.cacheWrite1h).toBe(0);

    const allOneHour = tokenCostBreakdown(writes, pricing, 1_000_000);
    expect(allOneHour.cacheWrite).toBe(0);
    expect(allOneHour.cacheWrite1h).toBeCloseTo(20, 10);

    // A mixed turn splits at the boundary rather than picking one rate.
    const mixed = tokenCostBreakdown(writes, pricing, 400_000);
    expect(mixed.cacheWrite).toBeCloseTo(7.5, 10);
    expect(mixed.cacheWrite1h).toBeCloseTo(8, 10);
    expect(mixed.cacheWrite + mixed.cacheWrite1h).toBeCloseTo(15.5, 10);
  });

  it("never prices more one-hour writes than were written", () => {
    // The count and the total reach us from different fields, so a mismatch is
    // possible and must not invent tokens.
    const priced = tokenCostBreakdown({ ...usage, cacheCreationInputTokens: 100 }, pricing, 999);
    expect(priced.cacheWrite).toBe(0);
    expect(priced.cacheWrite1h).toBeCloseTo((100 * 2 * pricing.inputPerMTok) / 1e6, 12);
  });

  it("charges nothing for a rate the catalog doesn't publish", () => {
    // Codex has no cache-write rate, so those tokens must not be billed at the
    // fresh-input rate by accident.
    const { cacheWrite, total } = tokenCostBreakdown(usage, {
      inputPerMTok: 10,
      cachedInputPerMTok: 1,
      outputPerMTok: 50,
    });
    expect(cacheWrite).toBe(0);
    expect(total).toBeCloseTo(18, 10);
  });

  it("costs nothing at all for a model with no pricing entry", () => {
    expect(tokenCostBreakdown(usage, undefined).total).toBe(0);
  });
});

describe("fast-mode pricing", () => {
  it("ships a fast rate card for the models that have one", () => {
    // Generated from models.dev's experimental.modes.fast, not hand-written, so
    // this asserts the shape and the premium rather than exact figures.
    const opus5 = findChatModel("claude-opus-5");
    expect(opus5?.fastPricing).toBeDefined();
    expect(opus5!.fastPricing!.inputPerMTok).toBeGreaterThan(opus5!.pricing!.inputPerMTok);
    // Models with no fast mode upstream must not invent one, since its presence
    // is what offers the toggle.
    expect(findChatModel("claude-haiku-4-5-20251001")?.fastPricing).toBeUndefined();
  });

  it("costs a turn at whichever card it was billed on", () => {
    const model = findChatModel("claude-opus-5")!;
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 1_000_000,
    };
    const standard = tokenCostBreakdown(usage, model.pricing);
    const fast = tokenCostBreakdown(usage, model.fastPricing);
    expect(fast.total).toBeCloseTo(standard.total * 2, 10);
  });

  it("prices a one-hour cache write against the fast input rate too", () => {
    // The TTL rule is a multiple of whatever input costs, so under fast mode it
    // compounds with the premium rather than staying at list.
    const model = findChatModel("claude-opus-5")!;
    const usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 1_000_000,
    };
    const fast = tokenCostBreakdown(usage, model.fastPricing, 1_000_000);
    expect(fast.cacheWrite1h).toBeCloseTo(model.fastPricing!.inputPerMTok * 2, 10);
  });

  it("offers a fast card for codex models too, and one the picker can compare", () => {
    // The codex half keeps its rates in a lookup rather than inline, so check
    // both the entry the picker reads and the server's lookup agree.
    const sol = findChatModel("gpt-5.6-sol");
    expect(sol?.fastPricing?.inputPerMTok).toBe(codexPricingFor("gpt-5.6-sol", true)?.inputPerMTok);
    expect(sol!.fastPricing!.outputPerMTok).toBeGreaterThan(sol!.pricing!.outputPerMTok);
    expect(codexPricingFor("gpt-5.6-sol")).toEqual(sol!.pricing);
  });

  it("falls back to standard codex rates for an id with no fast card", () => {
    // A delisted id still has to cost out; asking for fast must not lose the
    // price entirely (nor invent a premium).
    expect(codexPricingFor("gpt-5.2", true)).toEqual(codexPricingFor("gpt-5.2"));
    expect(codexPricingFor("no-such-model", true)).toBeUndefined();
  });
});
