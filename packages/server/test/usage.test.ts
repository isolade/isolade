import { afterEach, describe, expect, it } from "bun:test";
import {
  __resetUsageCachesForTest,
  fetchCodexUsageFromAppServer,
  getUsageStats,
} from "../src/usage";

describe("usage", () => {
  afterEach(() => {
    __resetUsageCachesForTest();
  });

  it("parses Codex usage from app-server account methods", async () => {
    const calls: string[] = [];
    const result = await fetchCodexUsageFromAppServer(async (method) => {
      calls.push(method);
      if (method === "account/read") {
        return {
          account: {
            type: "chatgpt",
            email: "user@example.com",
            planType: "plus",
          },
        };
      }
      if (method === "account/rateLimits/read") {
        return {
          rateLimitsByLimitId: {
            codex: {
              planType: "team",
              rateLimitReachedType: "workspace_member_usage_limit_reached",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_800_000_000,
              },
              secondary: {
                usedPercent: 7,
                windowDurationMins: 10_080,
                resetsAt: 1_800_100_000_000,
              },
              credits: { hasCredits: true, unlimited: false, balance: "10" },
            },
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    expect(calls.toSorted()).toEqual(["account/rateLimits/read", "account/read"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.email).toBe("user@example.com");
      expect(result.data.planType).toBe("team");
      expect(result.data.activeLimit).toBe("workspace_member_usage_limit_reached");
      expect(result.data.primary?.utilization).toBe(42);
      expect(result.data.primary?.windowSeconds).toBe(18_000);
      expect(result.data.primary?.resetsAt?.getTime()).toBe(1_800_000_000_000);
      expect(result.data.secondary?.resetsAt?.getTime()).toBe(1_800_100_000_000);
      expect(result.data.credits?.balance).toBe("10");
    }
  });

  it("uses the injected Codex fetcher in getUsageStats", async () => {
    let codexCalls = 0;
    const stats = await getUsageStats({
      cacheKey: "profile-test",
      authStore: {
        read() {
          return null;
        },
      },
      fetchCodexUsage: async () => {
        codexCalls += 1;
        return {
          ok: true,
          data: {
            email: null,
            planType: "plus",
            activeLimit: null,
            primary: null,
            secondary: null,
            credits: null,
          },
        };
      },
    });

    expect(codexCalls).toBe(1);
    expect(stats.claude.ok).toBe(false);
    expect(stats.codex.ok).toBe(true);
  });

  it("parses Claude dynamic weekly model windows", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === "https://api.anthropic.com/api/oauth/usage") {
        return new Response(
          JSON.stringify({
            seven_day: {
              utilization: 40,
              resets_at: "2026-07-09T14:00:00.000Z",
            },
            seven_day_opus: null,
            seven_day_sonnet: null,
            limits: [
              {
                kind: "session",
                group: "session",
                percent: 0,
                resets_at: null,
                scope: null,
                is_active: false,
              },
              {
                kind: "weekly_all",
                group: "weekly",
                percent: 40,
                resets_at: "2026-07-09T14:00:00.000Z",
                scope: null,
                is_active: true,
              },
              {
                kind: "weekly_scoped",
                group: "weekly",
                percent: 40,
                resets_at: "2026-07-09T14:00:01.000Z",
                scope: {
                  model: {
                    id: null,
                    display_name: "Fable",
                  },
                  surface: null,
                },
                is_active: false,
              },
            ],
          }),
        );
      }
      if (url === "https://api.anthropic.com/api/oauth/profile") {
        return new Response(
          JSON.stringify({
            account: { email: "claude@example.com" },
            organization: { name: "Team" },
          }),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      const stats = await getUsageStats({
        cacheKey: "claude-dynamic-weekly",
        authStore: {
          read(provider) {
            return provider === "claude"
              ? JSON.stringify({
                  claudeAiOauth: {
                    accessToken: "test-token",
                    rateLimitTier: "max_5x",
                    subscriptionType: "team",
                  },
                })
              : null;
          },
        },
        fetchCodexUsage: async () => ({
          ok: false,
          error: "codex unavailable",
        }),
      });

      expect(stats.claude.ok).toBe(true);
      if (stats.claude.ok) {
        expect(stats.claude.data.account?.email).toBe("claude@example.com");
        expect(stats.claude.data.fiveHour?.utilization).toBe(0);
        expect(stats.claude.data.sevenDay?.utilization).toBe(40);
        expect(stats.claude.data.weeklyWindows.map((window) => window.label)).toEqual([
          "All models",
          "Fable",
        ]);
        expect(stats.claude.data.weeklyWindows.map((window) => window.window.utilization)).toEqual([
          40, 40,
        ]);
        expect(stats.claude.data.sevenDayOpus).toBeNull();
        expect(stats.claude.data.sevenDaySonnet).toBeNull();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes extra_usage amounts from cents to major currency units", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === "https://api.anthropic.com/api/oauth/usage") {
        return new Response(
          JSON.stringify({
            extra_usage: {
              is_enabled: true,
              monthly_limit: 5000, // $50.00, reported in cents
              used_credits: 1234, // $12.34, reported in cents
              currency: "USD",
            },
          }),
        );
      }
      if (url === "https://api.anthropic.com/api/oauth/profile") {
        return new Response(JSON.stringify({ account: {}, organization: {} }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      const stats = await getUsageStats({
        cacheKey: "claude-extra-usage",
        authStore: {
          read(provider) {
            return provider === "claude"
              ? JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } })
              : null;
          },
        },
        fetchCodexUsage: async () => ({ ok: false, error: "codex unavailable" }),
      });

      expect(stats.claude.ok).toBe(true);
      if (stats.claude.ok) {
        const extra = stats.claude.data.extraUsage;
        expect(extra?.enabled).toBe(true);
        expect(extra?.monthlyLimit).toBe(50);
        expect(extra?.usedCredits).toBeCloseTo(12.34, 5);
        expect(extra?.currency).toBe("USD");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
