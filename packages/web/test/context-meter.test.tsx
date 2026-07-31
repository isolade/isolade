import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageState } from "../src/components/chat/chunks";
import {
  ContextBreakdownDetail,
  ContextDetail,
  ContextMeter,
  contextProbeKey,
} from "../src/components/chat/UsagePanel";
import type { ContextBreakdown, TokenUsage } from "../src/lib/contracts";

function tokens(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    ...over,
  };
}

function usageState(over: Partial<UsageState> = {}): UsageState {
  return { last: tokens(), total: tokens(), ...over };
}

// What the meter puts on screen, as opposed to what it says to a screen reader
// through its label.
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

describe("ContextMeter", () => {
  const filled = (used: number, window?: number) =>
    usageState({
      last: tokens({ inputTokens: used, totalTokens: used }),
      total: tokens({ inputTokens: used, totalTokens: used }),
      modelContextWindow: window,
    });

  it("reads as a share of the window rather than a token count", () => {
    // The raw figures are a hover (or a screen reader) away. What the composer
    // paints is the one number that means the same thing on any model.
    const html = renderToStaticMarkup(<ContextMeter usage={filled(84_000, 200_000)} />);
    expect(visibleText(html)).toBe("42%");
  });

  it("names the tokens behind the share for anyone who cannot see the ring", () => {
    const html = renderToStaticMarkup(<ContextMeter usage={filled(84_000, 200_000)} />);
    expect(html).toContain('aria-label="Context 42% full, 84k of 200k tokens"');
  });

  it("falls back to the catalog window when the provider reports none", () => {
    const html = renderToStaticMarkup(
      <ContextMeter usage={filled(50_000)} catalogWindow={200_000} />,
    );
    expect(html).toContain("25%");
  });

  it("counts the whole prompt, however each part was billed", () => {
    // Cached tokens and cache writes occupy the window exactly like fresh input
    // does. Output does not: it came back, it was not sent.
    const usage = usageState({
      last: tokens({
        inputTokens: 10_000,
        cachedInputTokens: 60_000,
        cacheCreationInputTokens: 30_000,
        outputTokens: 100_000,
      }),
      total: tokens(),
      modelContextWindow: 200_000,
    });
    expect(renderToStaticMarkup(<ContextMeter usage={usage} />)).toContain("50%");
  });

  it("starts at zero on a chat that has not run a turn", () => {
    // The meter belongs to the composer from the moment a chat opens, the way
    // the cost beside it starts at $0.00, rather than appearing partway through
    // the first turn.
    const fresh = renderToStaticMarkup(<ContextMeter usage={null} catalogWindow={200_000} />);
    expect(visibleText(fresh)).toBe("0%");
    expect(fresh).toContain('aria-label="Context 0% full, 0 of 200k tokens"');
    expect(fresh).toContain("text-muted-foreground");
    expect(visibleText(renderToStaticMarkup(<ContextMeter usage={filled(0, 200_000)} />))).toBe(
      "0%",
    );
  });

  it("starts at zero even before the window is known", () => {
    // What a fresh codex chat looks like: the catalog leaves those windows to
    // the provider, which reports one with its first usage event. An empty
    // context is empty against any of them.
    expect(visibleText(renderToStaticMarkup(<ContextMeter usage={null} />))).toBe("0%");
  });

  it("says nothing once something is in a window nobody knows the size of", () => {
    // A share of an unknown denominator is not a fact, and a ring nobody can
    // read says less than no ring at all.
    expect(renderToStaticMarkup(<ContextMeter usage={filled(84_000)} />)).toBe("");
  });

  it("keeps a prompt that rounds to nothing visible", () => {
    // A first turn against a million-token window is a rounding error, and "0%"
    // reads as a broken meter rather than as room to spare.
    const html = renderToStaticMarkup(<ContextMeter usage={filled(2_000, 1_000_000)} />);
    expect(html).toContain("1%");
  });

  it("warms as the window fills, and only then", () => {
    const at = (pct: number) =>
      renderToStaticMarkup(<ContextMeter usage={filled(pct * 2_000, 200_000)} />);
    expect(at(50)).toContain("text-muted-foreground");
    expect(at(80)).toContain("text-amber-500");
    expect(at(95)).toContain("text-red-500");
  });
});

// The card reuses what a probe returned while this key is unchanged, so the key
// is what decides whether hovering reaches into the VM again.
describe("contextProbeKey", () => {
  const afterTurn = usageState({
    last: tokens({ inputTokens: 40_000, cachedInputTokens: 44_000, totalTokens: 87_000 }),
    total: tokens({ totalTokens: 250_000 }),
  });

  it("is unchanged by reopening the card on a session that has not moved", () => {
    expect(contextProbeKey(afterTurn)).toBe(contextProbeKey({ ...afterTurn }));
  });

  it("moves when a turn sends the model something new", () => {
    const next = usageState({
      last: tokens({ inputTokens: 40_000, cachedInputTokens: 90_000, totalTokens: 133_000 }),
      total: tokens({ totalTokens: 390_000 }),
    });
    expect(contextProbeKey(next)).not.toBe(contextProbeKey(afterTurn));
  });

  it("moves when the thread is compacted, which rearranges the whole context", () => {
    expect(contextProbeKey({ ...afterTurn, compacted: true })).not.toBe(contextProbeKey(afterTurn));
  });

  it("ignores what does not change what is in the context", () => {
    // Cost and the subscription share ride the same usage events as the token
    // counts. Re-probing the VM because a chat got more expensive would be a
    // round trip for an answer that cannot have changed.
    expect(contextProbeKey({ ...afterTurn, costUsd: 9.5 })).toBe(contextProbeKey(afterTurn));
    expect(contextProbeKey({ ...afterTurn, modelContextWindow: 1_000_000 })).toBe(
      contextProbeKey(afterTurn),
    );
  });

  it("holds still while a turn streams, whatever its figures do", () => {
    // The server declines to probe a running turn. Hearing that once is enough,
    // and the usage events a turn streams would otherwise ask again per frame.
    expect(contextProbeKey(afterTurn, true)).toBe(contextProbeKey(usageState(), true));
    expect(contextProbeKey(afterTurn, true)).not.toBe(contextProbeKey(afterTurn, false));
  });

  it("treats a chat with no usage yet as the empty session it is", () => {
    expect(contextProbeKey(null)).toBe(contextProbeKey(usageState()));
  });
});

describe("ContextDetail", () => {
  it("itemizes the tokens, and leaves the money to the cost card", () => {
    const html = renderToStaticMarkup(
      <ContextDetail
        usage={{
          last: tokens({ inputTokens: 84_000, outputTokens: 3_000, totalTokens: 87_000 }),
          total: tokens({ totalTokens: 250_000 }),
          modelContextWindow: 200_000,
          costUsd: 4.5,
        }}
      />,
    );
    expect(html).toContain("84k / 200k");
    expect(html).toContain("42%");
    expect(html).toContain("250k");
    expect(html).not.toContain("$");
  });

  it("holds the turn rows back until there has been a turn", () => {
    // The window and what is in it is the whole point of the card being open on
    // a fresh chat. A column of zeros under it is not.
    const html = renderToStaticMarkup(
      <ContextDetail usage={usageState()} catalogWindow={200_000} />,
    );
    expect(html).toContain("0 / 200k · 0%");
    expect(html).toContain("Nothing sent to the model yet.");
    expect(html).not.toContain("Last turn");
    expect(html).not.toContain("Total");
  });

  it("says when the thread has been compacted", () => {
    const html = renderToStaticMarkup(
      <ContextDetail
        usage={usageState({
          last: tokens({ inputTokens: 20_000 }),
          modelContextWindow: 200_000,
          compacted: true,
        })}
      />,
    );
    expect(html).toContain("thread compacted");
  });
});

describe("ContextBreakdownDetail", () => {
  const breakdown = (): ContextBreakdown => ({
    available: true,
    totalTokens: 75_000,
    contextWindow: 200_000,
    percent: 37.5,
    categories: [
      { name: "System prompt", tokens: 3_000, percent: 1.5 },
      { name: "Tools", tokens: 12_000, percent: 6 },
      { name: "Messages", tokens: 60_000, percent: 30 },
      { name: "Free space", tokens: 125_000, percent: 62.5 },
    ],
  });

  it("reads as loading until the open read lands", () => {
    const html = renderToStaticMarkup(<ContextBreakdownDetail breakdown={null} error={null} />);
    expect(html).toContain("Loading context breakdown…");
  });

  it("says what went wrong rather than sitting on a spinner", () => {
    const html = renderToStaticMarkup(
      <ContextBreakdownDetail breakdown={null} error="session not running" />,
    );
    expect(html).toContain("session not running");
  });

  it("names what is holding the context, minus what is holding nothing", () => {
    const html = renderToStaticMarkup(
      <ContextBreakdownDetail breakdown={breakdown()} error={null} />,
    );
    expect(html).toContain("system prompt");
    expect(html).toContain("12k");
    expect(html).not.toContain("free space");
  });

  it("is honest about the providers that do not report one", () => {
    const html = renderToStaticMarkup(
      <ContextBreakdownDetail breakdown={{ available: false, reason: "codex" }} error={null} />,
    );
    expect(html).toContain("Breakdown unavailable");
  });
});
