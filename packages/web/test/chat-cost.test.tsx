import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { usageSeedFromChat } from "../src/components/chat/chunks";
import { ChatCost, CostBreakdownDetail } from "../src/components/chat/UsagePanel";
import type { Chat, ChatCostBreakdown } from "../src/lib/contracts";
import { formatCost } from "../src/lib/format";

function chatRow(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    instanceId: "instance-1",
    model: "claude-opus-5",
    provider: "anthropic",
    effort: "high",
    fastMode: false,
    claudeSessionId: null,
    codexThreadId: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    costUsd: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastCacheCreationInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    modelContextWindow: null,
    compacted: null,
    activeLeafId: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

describe("ChatCost", () => {
  it("starts at zero before the chat has spent anything", () => {
    expect(renderToStaticMarkup(<ChatCost />)).toContain("$0.00");
  });

  it("shows a chat's total straight away, without counting up from zero", () => {
    // A reloaded chat paints its total on the first frame. Only a change while
    // mounted animates.
    expect(renderToStaticMarkup(<ChatCost costUsd={1.234} />)).toContain("$1.23");
  });

  it("holds at cents whatever the amount, so the count-up never jitters", () => {
    expect(renderToStaticMarkup(<ChatCost costUsd={0.0042} />)).toContain("$0.00");
    expect(renderToStaticMarkup(<ChatCost costUsd={0.5} />)).toContain("$0.50");
    expect(renderToStaticMarkup(<ChatCost costUsd={123.456} />)).toContain("$123.46");
  });
});

describe("cost formatting", () => {
  // The picker dropdown and the usage tab still grow precision as the figure
  // shrinks; only the composer's ambient ticker is pinned to cents.
  it("grows precision as the figure shrinks", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.5)).toBe("$0.500");
    expect(formatCost(12.345)).toBe("$12.35");
  });
});

describe("usageSeedFromChat", () => {
  it("seeds the chat's cost from the persisted row", () => {
    const seed = usageSeedFromChat(chatRow({ inputTokens: 1_000, costUsd: 4 }));
    expect(seed?.costUsd).toBe(4);
  });

  it("has no seed for a chat whose active session never streamed", () => {
    // The row can still hold a cost here (a chat that just switched agents, so
    // its token columns were reset but its bill was not), which Chat.tsx reads
    // straight off the row for the composer.
    expect(usageSeedFromChat(chatRow({ costUsd: 4 }))).toBeNull();
  });
});

describe("CostBreakdownDetail", () => {
  const breakdown = (over: Partial<ChatCostBreakdown> = {}): ChatCostBreakdown => ({
    billed: 2.5,
    buckets: [
      { bucket: "input", tokens: 1_200_000, costUsd: 1.2 },
      { bucket: "cachedInput", tokens: 800_000, costUsd: 0.08 },
      { bucket: "cacheWrite", tokens: 120_000, costUsd: 0.15 },
      { bucket: "output", tokens: 45_000, costUsd: 1.0 },
    ],
    models: [{ model: "claude-opus-5", provider: "anthropic", costUsd: 2.5 }],
    webSearchRequests: 0,
    unattributed: 0.07,
    ...over,
  });

  it("itemizes every bucket with its tokens and its cost", () => {
    const html = renderToStaticMarkup(<CostBreakdownDetail breakdown={breakdown()} />);
    expect(html).toContain("input");
    expect(html).toContain("cache read");
    expect(html).toContain("cache write");
    expect(html).toContain("1.20M");
    expect(html).toContain("$1.2000");
    expect(html).toContain("$2.5000");
  });

  it("shows what list prices cannot explain rather than hiding it", () => {
    const html = renderToStaticMarkup(<CostBreakdownDetail breakdown={breakdown()} />);
    expect(html).toContain("other");
    expect(html).toContain("$0.0700");
  });

  it("keeps rounding out of sight", () => {
    // A residual under half a cent explains nothing and would just be noise.
    const html = renderToStaticMarkup(
      <CostBreakdownDetail breakdown={breakdown({ unattributed: 0.001 })} />,
    );
    expect(html).not.toContain("other");
  });

  it("names each model only once a chat has spent on more than one", () => {
    const single = renderToStaticMarkup(<CostBreakdownDetail breakdown={breakdown()} />);
    expect(single).not.toContain("Models");
    const switched = renderToStaticMarkup(
      <CostBreakdownDetail
        breakdown={breakdown({
          models: [
            { model: "claude-opus-5", provider: "anthropic", costUsd: 2.2 },
            { model: "gpt-5.6-sol", provider: "openai", costUsd: 0.3 },
          ],
        })}
      />,
    );
    expect(switched).toContain("Models");
    expect(switched).toContain("Opus 5");
    expect(switched).toContain("GPT-5.6 Sol");
  });
});

describe("CostBreakdownDetail, mid-turn", () => {
  const settled: ChatCostBreakdown = {
    billed: 1,
    buckets: [{ bucket: "input", tokens: 1_000_000, costUsd: 1 }],
    models: [{ model: "claude-opus-5", provider: "anthropic", costUsd: 1 }],
    webSearchRequests: 0,
    unattributed: 0,
  };

  it("names what the running turn has added, so the card matches the composer", () => {
    // The composer counts the turn in flight; the log only knows settled turns.
    // Showing the difference is what keeps the two from looking inconsistent.
    const html = renderToStaticMarkup(
      <CostBreakdownDetail breakdown={settled} inFlightUsd={0.25} />,
    );
    expect(html).toContain("in progress");
    expect(html).toContain("$0.2500");
    expect(html).toContain("$1.2500");
  });

  it("says nothing about a turn in flight when none is", () => {
    const html = renderToStaticMarkup(<CostBreakdownDetail breakdown={settled} />);
    expect(html).not.toContain("in progress");
    expect(html).toContain("$1.0000");
  });

  it("counts searches billed per request rather than per token", () => {
    const html = renderToStaticMarkup(
      <CostBreakdownDetail breakdown={{ ...settled, webSearchRequests: 4 }} />,
    );
    expect(html).toContain("web search");
    expect(html).toContain("4 requests");
  });
});
