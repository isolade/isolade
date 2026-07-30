import { describe, expect, it } from "bun:test";
import { formatRelativeTime } from "../src/lib/relative-time";

// A fixed "now" so the buckets are exact: 2026-03-14T12:00:00Z.
const NOW = Date.UTC(2026, 2, 14, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return formatRelativeTime(new Date(NOW - ms), NOW);
}

describe("formatRelativeTime", () => {
  it("collapses the last minute, including future timestamps", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(MINUTE - 1)).toBe("just now");
    // Clock skew, or a `now` floored to the minute by useMinuteClock.
    expect(ago(-30_000)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(ago(MINUTE)).toBe("1m ago");
    expect(ago(59 * MINUTE)).toBe("59m ago");
    expect(ago(HOUR)).toBe("1h ago");
    expect(ago(23 * HOUR + 59 * MINUTE)).toBe("23h ago");
    expect(ago(DAY)).toBe("1d ago");
    expect(ago(6 * DAY + 23 * HOUR)).toBe("6d ago");
  });

  it("switches to a date past a week, with the year only when it differs", () => {
    // Locale-dependent formatting, so assert on the parts that must be there.
    const lastMonth = ago(7 * DAY);
    expect(lastMonth).toContain("7");
    expect(lastMonth).not.toContain("ago");
    expect(lastMonth).not.toContain("2026");
    expect(ago(400 * DAY)).toContain("2025");
  });

  it("returns an empty label for an unparseable timestamp", () => {
    expect(formatRelativeTime("not a date", NOW)).toBe("");
  });
});
