import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FastModeToggle, fastRateLabel } from "../src/components/FastModeToggle";
import { type ChatModelDefinition, findChatModel } from "../src/lib/contracts";

const opus5 = findChatModel("claude-opus-5") as ChatModelDefinition;
const opus46 = findChatModel("claude-opus-4-6") as ChatModelDefinition;

function model(over: Partial<ChatModelDefinition> = {}): ChatModelDefinition {
  return { ...opus5, ...over };
}

describe("FastModeToggle", () => {
  const noop = () => {};

  it("offers the bolt only on models that sell a faster rate", () => {
    const without = model({ fastPricing: undefined });
    expect(renderToStaticMarkup(<FastModeToggle model={without} onFastModeChange={noop} />)).toBe(
      "",
    );
    expect(renderToStaticMarkup(<FastModeToggle model={undefined} onFastModeChange={noop} />)).toBe(
      "",
    );
  });

  it("says nothing where the choice has nowhere to be stored", () => {
    // The new-chat draft passes no handler: there is no chat row yet to hold a
    // per-chat billing decision.
    expect(renderToStaticMarkup(<FastModeToggle model={opus5} />)).toBe("");
  });

  it("is an outline the eye skips while it is off", () => {
    const html = renderToStaticMarkup(<FastModeToggle model={opus5} onFastModeChange={noop} />);
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("fill-current");
    expect(html).toContain("text-muted-foreground");
  });

  it("fills in and says so once it is on", () => {
    const html = renderToStaticMarkup(
      <FastModeToggle model={opus5} fastMode onFastModeChange={noop} />,
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("fill-current");
    expect(html).toContain("Fast");
  });

  it("opens the word from nothing rather than popping it into the row", () => {
    // The label is mounted in both states and the track it sits in is what
    // moves, so turning fast mode on widens the button instead of inserting a
    // node into the row.
    const off = renderToStaticMarkup(<FastModeToggle model={opus5} onFastModeChange={noop} />);
    const on = renderToStaticMarkup(
      <FastModeToggle model={opus5} fastMode onFastModeChange={noop} />,
    );
    expect(off).toContain("Fast");
    expect(off).toContain("grid-cols-[0fr]");
    expect(on).toContain("grid-cols-[1fr]");
    expect(off).toContain("transition-[grid-template-columns]");
  });

  it("names the premium it is asking for, both ways round", () => {
    const off = renderToStaticMarkup(<FastModeToggle model={opus5} onFastModeChange={noop} />);
    const on = renderToStaticMarkup(
      <FastModeToggle model={opus5} fastMode onFastModeChange={noop} />,
    );
    expect(off).toContain("2× the usual rate");
    expect(off).toContain("Fast mode off");
    expect(on).toContain("Fast mode on");
    expect(on).toContain("turn it off");
  });
});

describe("fastRateLabel", () => {
  it("reads the premium off the two rate cards rather than hardcoding it", () => {
    expect(fastRateLabel(opus5)).toBe("2×");
    expect(fastRateLabel(opus46)).toBe("6×");
  });

  it("keeps a decimal only where the ratio has one", () => {
    expect(
      fastRateLabel(
        model({
          pricing: { inputPerMTok: 2, outputPerMTok: 10 },
          fastPricing: { inputPerMTok: 5 },
        }),
      ),
    ).toBe("2.5×");
  });

  it("stays vague rather than dividing by a rate it does not have", () => {
    expect(fastRateLabel(model({ pricing: undefined }))).toBe("a premium on");
  });
});
