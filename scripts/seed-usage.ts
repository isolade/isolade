#!/usr/bin/env bun
// Populate the DB with a year of plausible-looking fake usage so the Usage page
// has something to show — both the contribution-graph heatmap and the Lifetime
// card. Both read from the append-only `usage_events` log (bucketed by day for
// the heatmap, summed per provider for the card), so seeding events is all it
// takes to make the two panels consistent with each other.
//
//   bun run scripts/seed-usage.ts                  # replace this profile's usage with a fresh year
//   bun run scripts/seed-usage.ts --append         # add events on top of what's there
//   bun run scripts/seed-usage.ts --days 540       # change the span (default 371 = the
//                                                  # ~53 weeks the heatmap draws)
//   bun run scripts/seed-usage.ts --profile demo   # seed a profile other than "default"
//
// The data has deliberate structure so it looks organic: a slow-drifting
// "intensity" that creates busy and quiet stretches, more skipped days in quiet
// periods, lighter weekends, and a long-tailed daily cost (lots of small days,
// a few big ones) so the heatmap's four shades are all well populated.

import { randomUUID } from "crypto";
import { createDb, eq, schema } from "../packages/server/src/db";

interface Args {
  append: boolean;
  days: number;
  profile: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { append: false, days: 371, profile: "default" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--append") args.append = true;
    else if (a === "--days") args.days = Math.max(1, Number(argv[++i]) || args.days);
    else if (a === "--profile") args.profile = argv[++i] || args.profile;
  }
  return args;
}

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, n: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + n);
  return next;
}

// Standard exponential variate (mean 1) — gives the long right tail that makes
// a few days much heavier than the rest, the way real usage clusters.
function expRandom(): number {
  return -Math.log(1 - Math.random());
}

// Roughly $4 per million blended tokens — used to back out a token breakdown
// from a generated dollar figure so the tooltip's tokens read sensibly.
const DOLLARS_PER_TOKEN = 4 / 1_000_000;

type Provider = "anthropic" | "openai";

// Real catalog ids so the Lifetime card can resolve pricing for the
// token-weighting / subscription-share columns; a couple per provider so
// per-model views have variety.
const MODELS: Record<Provider, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-8"],
  openai: ["gpt-5.4", "gpt-5.3-codex"],
};

interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface UsageRow extends TokenBreakdown {
  date: Date;
  provider: Provider;
  costUsd: number;
}

// Derive a believable token breakdown from a provider's dollar cost for a day.
function tokensFromCost(cost: number, provider: Provider): TokenBreakdown {
  const totalish = cost / DOLLARS_PER_TOKEN;
  const inputTokens = Math.round(totalish * (0.55 + Math.random() * 0.1));
  const cachedInputTokens = Math.round(inputTokens * (0.5 + Math.random() * 0.3));
  const cacheCreationInputTokens = Math.round(inputTokens * (0.05 + Math.random() * 0.1));
  const outputTokens = Math.round(totalish * (0.12 + Math.random() * 0.08));
  // Only Anthropic reports reasoning separately for our purposes; keep
  // OpenAI's at zero to mirror the real data shape.
  const reasoningOutputTokens =
    provider === "anthropic" ? Math.round(outputTokens * (0.2 + Math.random() * 0.3)) : 0;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

// Pricing-weighted input-equivalent for a turn, mirroring the real recorder's
// `effectiveInputTokens`: output is the dominant cost driver, cache writes cost
// a premium, cache reads are cheap. Rough weights are fine for demo data — it
// only feeds the Lifetime card's subscription-share estimate.
function effectiveInput(t: TokenBreakdown): number {
  return Math.round(
    t.inputTokens +
      t.cachedInputTokens * 0.1 +
      t.cacheCreationInputTokens * 1.25 +
      t.outputTokens * 5,
  );
}

function generate(days: number, today: Date): UsageRow[] {
  const start = addDays(today, -(days - 1));
  const rows: UsageRow[] = [];

  // Slow random walk in [0.2, 1]: the "how into it am I lately" signal. Its
  // momentum produces multi-week busy and quiet stretches rather than uniform
  // noise — the single biggest contributor to an organic-looking graph.
  let intensity = 0.6;
  for (let offset = 0; offset < days; offset++) {
    intensity = Math.min(1, Math.max(0.2, intensity + (Math.random() - 0.5) * 0.16));

    const date = addDays(start, offset);
    date.setHours(12, 0, 0, 0); // midday, so the event lands squarely in its local day
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;

    // A baseline keeps the graph reasonably full even in quiet stretches;
    // weekends are sparser. Power-user-shaped: most weekdays active.
    const activeChance = (0.45 + intensity * 0.5) * (isWeekend ? 0.45 : 1);
    if (Math.random() > activeChance) continue;

    // Long-tailed daily cost scaled by the current intensity: many modest days,
    // the occasional heavy one. Squaring the exponential variate fattens the
    // tail so the top quartile is clearly heavier than the rest.
    const magnitude = expRandom() ** 1.6;
    const weekday = isWeekend ? 0.5 : 1;
    const dayCost = 0.5 + magnitude * intensity * 9 * weekday;

    // Most cost on Anthropic; OpenAI shows up on a subset of days.
    const openaiShare = Math.random() < 0.4 ? Math.random() * 0.45 : 0;
    for (const provider of ["anthropic", "openai"] as const) {
      const cost = provider === "anthropic" ? dayCost * (1 - openaiShare) : dayCost * openaiShare;
      if (cost < 0.01) continue;
      rows.push({
        date,
        provider,
        costUsd: Number(cost.toFixed(4)),
        ...tokensFromCost(cost, provider),
      });
    }
  }
  return rows;
}

// A handful of chat-creation markers per provider, dated across the span, so the
// Lifetime card's "across N chats" figure reads sensibly. They carry zero
// tokens/cost, so the heatmap (which drops token-less days) ignores them.
function chatCreatedMarkers(
  profileId: string,
  provider: Provider,
  count: number,
  today: Date,
  days: number,
): (typeof schema.usageEvents.$inferInsert)[] {
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(today, -Math.floor(Math.random() * days));
    date.setHours(12, 0, 0, 0);
    return {
      id: randomUUID(),
      profileId,
      provider,
      model: MODELS[provider][i % MODELS[provider].length],
      kind: "chat_created" as const,
      createdAt: date,
    };
  });
}

function main() {
  const { append, days, profile } = parseArgs(process.argv.slice(2));
  const db = createDb();

  if (!append) {
    db.delete(schema.usageEvents).where(eq(schema.usageEvents.profileId, profile)).run();
    console.log(`Cleared the "${profile}" profile's usage_events log.`);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = generate(days, today);

  const usageEvents = rows.map((r) => ({
    id: randomUUID(),
    profileId: profile,
    provider: r.provider,
    model: MODELS[r.provider][Math.floor(Math.random() * MODELS[r.provider].length)],
    kind: "usage" as const,
    inputTokens: r.inputTokens,
    cachedInputTokens: r.cachedInputTokens,
    cacheCreationInputTokens: r.cacheCreationInputTokens,
    outputTokens: r.outputTokens,
    reasoningOutputTokens: r.reasoningOutputTokens,
    costUsd: r.costUsd,
    effectiveInputTokens: effectiveInput(r),
    createdAt: r.date,
  }));

  const hasOpenai = rows.some((r) => r.provider === "openai");
  const markers = [
    ...chatCreatedMarkers(profile, "anthropic", 14, today, days),
    ...(hasOpenai ? chatCreatedMarkers(profile, "openai", 6, today, days) : []),
  ];

  db.transaction((tx) => {
    for (const e of [...usageEvents, ...markers]) {
      tx.insert(schema.usageEvents).values(e).run();
    }
  });

  const totalCost = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const activeDays = new Set(rows.map((r) => localDay(r.date))).size;
  console.log(
    `Seeded ${usageEvents.length} usage events across ${activeDays} active days over ${days} days, ` +
      `plus ${markers.length} chat markers ` +
      `(~$${totalCost.toFixed(2)} total) for profile "${profile}". Open Settings → Usage to view.`,
  );
}

main();
