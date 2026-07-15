import { describe, expect, it } from "bun:test";
import {
  CHAT_MODELS,
  type ChatModelDefinition,
  defaultModelTier,
  effectiveModelTier,
  type ModelOverrides,
  pruneModelOverrides,
  setModelTierOverride,
  splitModelsByTier,
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
    expect(defaultModelTier("claude-opus-4-8")).toBe("default");
    expect(defaultModelTier("gpt-5.6-sol")).toBe("default");
    expect(defaultModelTier("gpt-5.5")).toBe("more");
    expect(defaultModelTier("claude-opus-4-6")).toBe("more");
  });
});

describe("effectiveModelTier", () => {
  it("falls back to the catalog default when there's no override", () => {
    expect(effectiveModelTier("claude-opus-4-8", {})).toBe("default");
    expect(effectiveModelTier("gpt-5.5", {})).toBe("more");
  });

  it("honors an override", () => {
    const overrides: ModelOverrides = {
      "claude-opus-4-8": { tier: "hidden" },
      "gpt-5.5": { tier: "default" },
    };
    expect(effectiveModelTier("claude-opus-4-8", overrides)).toBe("hidden");
    expect(effectiveModelTier("gpt-5.5", overrides)).toBe("default");
  });
});

describe("setModelTierOverride", () => {
  it("stores a delta that differs from the catalog default", () => {
    const next = setModelTierOverride({}, "claude-opus-4-8", "hidden");
    expect(next).toEqual({ "claude-opus-4-8": { tier: "hidden" } });
  });

  it("drops the entry when reverting to the catalog default", () => {
    const start: ModelOverrides = { "claude-opus-4-8": { tier: "hidden" } };
    const next = setModelTierOverride(start, "claude-opus-4-8", "default");
    expect(next).toEqual({});
    // Pure: the input is untouched.
    expect(start).toEqual({ "claude-opus-4-8": { tier: "hidden" } });
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
      "claude-opus-4-8": { tier: "hidden" },
      "gone-9.9": { tier: "more" },
    };
    expect(pruneModelOverrides(overrides)).toEqual({ "claude-opus-4-8": { tier: "hidden" } });
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
