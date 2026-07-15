import { afterEach, describe, expect, it } from "bun:test";
import { createDb } from "../src/db";
import {
  derivePeriods,
  isNewer,
  isoWeek,
  resolveAndMaybeCount,
  utcDate,
} from "../src/update-check";
import { UpdateCheckStore } from "../src/update-check-store";

// All dates are built with Date.UTC so the period math (which is UTC) is
// deterministic regardless of the machine running the tests.
const utc = (y: number, m0: number, d: number, h = 0) => new Date(Date.UTC(y, m0, d, h));

describe("utcDate", () => {
  it("formats UTC Y-M-D zero-padded", () => {
    expect(utcDate(utc(2026, 0, 3))).toBe("2026-01-03");
    expect(utcDate(utc(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("isoWeek", () => {
  it("puts a week in the year of its Thursday", () => {
    // 2021-01-01 is a Friday → ISO week 53 of 2020.
    expect(isoWeek(utc(2021, 0, 1))).toEqual({ year: 2020, week: 53 });
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(isoWeek(utc(2026, 0, 1))).toEqual({ year: 2026, week: 1 });
  });
});

describe("derivePeriods", () => {
  it("returns every period for a first-ever check", () => {
    expect(derivePeriods(null, utc(2026, 5, 10))).toEqual(["day", "week", "month", "year"]);
  });

  it("returns nothing within the same UTC day (resolve-only)", () => {
    expect(derivePeriods(utc(2026, 5, 10, 1), utc(2026, 5, 10, 23))).toEqual([]);
  });

  it("returns only day for the next day in the same week", () => {
    // 2026-06-08 (Mon) -> 2026-06-09 (Tue): same ISO week, month, year.
    expect(derivePeriods(utc(2026, 5, 8), utc(2026, 5, 9))).toEqual(["day"]);
  });

  it("adds week when crossing into a new ISO week", () => {
    // 2026-06-07 (Sun) -> 2026-06-08 (Mon): new ISO week, same month/year.
    expect(derivePeriods(utc(2026, 5, 7), utc(2026, 5, 8))).toEqual(["day", "week"]);
  });

  it("adds week and month when crossing both at once", () => {
    // 2026-06-28 (Sun, ISO wk 26) -> 2026-07-01 (Wed, ISO wk 27): new week and
    // new month, same year.
    expect(derivePeriods(utc(2026, 5, 28), utc(2026, 6, 1))).toEqual(["day", "week", "month"]);
  });

  it("rolls month/year without week when the ISO week is unchanged", () => {
    // 2025-12-31 (Wed) and 2026-01-01 (Thu) are the SAME ISO week (wk 1 of
    // 2026), so month and year roll but week does not. Periods are independent.
    expect(derivePeriods(utc(2025, 11, 31), utc(2026, 0, 1))).toEqual(["day", "month", "year"]);
  });

  it("adds week, month and year when all three cross", () => {
    // 2025-12-28 (Sun, ISO wk 52 of 2025) -> 2026-01-01 (Thu, ISO wk 1 of 2026).
    expect(derivePeriods(utc(2025, 11, 28), utc(2026, 0, 1))).toEqual([
      "day",
      "week",
      "month",
      "year",
    ]);
  });
});

describe("isNewer", () => {
  it("compares numeric components, not lexically", () => {
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
    expect(isNewer("1.9.0", "1.10.0")).toBe(false);
  });

  it("ignores a leading v and prerelease/build suffixes", () => {
    expect(isNewer("v1.2.1", "1.2.0")).toBe(true);
    expect(isNewer("v1.2.0-rc1", "1.2.0")).toBe(false); // equal core → not newer
  });

  it("is false for equal versions", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  });

  it("treats a -dev build like its core version", () => {
    // Non-official builds (anything not built by CI from a v* tag) report
    // "<version>-dev"; they still see genuinely newer releases but aren't
    // offered their own version as an update.
    expect(isNewer("v0.1.1", "0.1.0-dev")).toBe(true);
    expect(isNewer("v0.1.0", "0.1.0-dev")).toBe(false);
  });
});

describe("resolveAndMaybeCount", () => {
  const realFetch = globalThis.fetch;
  let lastUrl = "";

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function tempStore(): UpdateCheckStore {
    return new UpdateCheckStore(createDb(":memory:"));
  }

  function stubOk(
    body: Record<string, unknown> = {
      version: "v2.0.0",
      download: "d",
      notes: "n",
      changes: ["x"],
    },
  ) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      lastUrl = String(input);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("counts the first check of a new day (sends periods) and records the time", async () => {
    stubOk();
    const store = tempStore();
    const status = await resolveAndMaybeCount(store, "0.1.0", "macos", utc(2026, 5, 10));

    expect(new URL(lastUrl).searchParams.get("periods")).toBe("day,week,month,year"); // first-ever
    expect(status.available).toBe(true);
    expect(status.latest).toBe("v2.0.0");
    expect(status.checkedAt).not.toBeNull();
    expect(utcDate(new Date(store.read().lastCheckedAt!))).toBe("2026-06-10");
  });

  it("is resolve-only later the same UTC day: no periods, but refreshes the timestamp", async () => {
    stubOk();
    const store = tempStore();
    await resolveAndMaybeCount(store, "0.1.0", "macos", utc(2026, 5, 10, 1)); // first → counts
    const later = utc(2026, 5, 10, 23);
    const after = await resolveAndMaybeCount(store, "0.1.0", "macos", later); // later, same UTC day

    // Second call sent no periods param → the endpoint records nothing.
    expect(new URL(lastUrl).searchParams.has("periods")).toBe(false);
    expect(after.checkedAt).toBe(later.getTime()); // timestamp still advanced
  });

  it("does not advance state on failure, so the count is retried", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const store = tempStore();
    const status = await resolveAndMaybeCount(store, "0.1.0", "macos", utc(2026, 5, 10));

    expect(status.available).toBe(false);
    expect(status.checkedAt).toBeNull();
    expect(store.read().lastCheckedAt).toBeNull();
  });
});
