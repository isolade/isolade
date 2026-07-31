import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnStatus } from "../src/components/chat/UsagePanel";
import { formatDuration } from "../src/lib/format";

describe("formatDuration", () => {
  it("counts whole seconds under a minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(940)).toBe("0s");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("reads as a stopwatch from a minute up", () => {
    expect(formatDuration(60_000)).toBe("1:00");
    expect(formatDuration(63_000)).toBe("1:03");
    expect(formatDuration(23 * 60_000 + 7_000)).toBe("23:07");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59:59");
  });

  it("pads the minutes once an hour is on the clock, so the columns line up", () => {
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(3_600_000 + 4 * 60_000 + 9_000)).toBe("1:04:09");
    expect(formatDuration(11 * 3_600_000 + 59 * 60_000 + 59_000)).toBe("11:59:59");
  });

  it("never counts backwards from a clock nudged mid-turn", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("TurnStatus", () => {
  it("says nothing on a chat that has not run a turn", () => {
    const html = renderToStaticMarkup(
      <TurnStatus running={false} startedAt={null} lastMs={null} />,
    );
    expect(html).toBe("");
  });

  it("spins and counts while the agent works", () => {
    const html = renderToStaticMarkup(
      <TurnStatus running startedAt={Date.now() - 75_000} lastMs={null} />,
    );
    expect(html).toContain("animate-spin");
    expect(html).toContain("1:15");
    expect(html).toContain('aria-label="Working, 1:15 so far"');
  });

  it("times a resumed turn from when it started, not from when we attached", () => {
    // A reload during a long turn hands us the server's start, so the figure is
    // the turn's real age rather than the browser's.
    const html = renderToStaticMarkup(
      <TurnStatus running startedAt={Date.now() - 8 * 60_000} lastMs={null} />,
    );
    expect(html).toContain("8:00");
  });

  it("holds the last turn's time behind a settled mark", () => {
    const html = renderToStaticMarkup(
      <TurnStatus running={false} startedAt={null} lastMs={94_000} />,
    );
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("1:34");
    expect(html).toContain('aria-label="Last turn took 1:34"');
  });

  it("shows the running turn rather than the one before it", () => {
    const html = renderToStaticMarkup(
      <TurnStatus running startedAt={Date.now() - 3_000} lastMs={94_000} />,
    );
    expect(html).toContain("3s");
    expect(html).not.toContain("1:34");
  });

  it("works without a figure when the turn's start is unknown", () => {
    // What a pointer left behind by a restarted server looks like for the
    // instant it takes to settle. Claiming it just began would be a guess.
    const html = renderToStaticMarkup(<TurnStatus running startedAt={null} lastMs={null} />);
    expect(html).toContain("animate-spin");
    expect(html).toContain('aria-label="Working"');
    expect(html).not.toContain("0s");
  });
});

// It stands alone in the send corner now that the cost has moved to the left of
// the row, so it carries its own type rather than inheriting a cluster's.
describe("TurnStatus, alone in the send corner", () => {
  it("sets its own type, on the send button's centre line", () => {
    const html = renderToStaticMarkup(
      <TurnStatus running={false} startedAt={null} lastMs={94_000} />,
    );
    const wrapper = html.slice(0, html.indexOf(">"));
    expect(wrapper).toContain("font-mono");
    expect(wrapper).toContain("text-xs");
    expect(wrapper).toContain("tabular-nums");
    expect(wrapper).toContain("h-8");
  });

  it("carries no separator, having nothing left to be separated from", () => {
    const html = renderToStaticMarkup(
      <TurnStatus running={false} startedAt={null} lastMs={94_000} />,
    );
    expect(html).toContain("1:34");
    expect(html).not.toContain("·");
    expect(html).not.toContain("$");
  });
});
