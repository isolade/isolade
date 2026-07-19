import { z } from "zod";
import {
  chatEffortSchema,
  chatMessageRoleSchema,
  chatProviderSchema,
  dateLikeSchema,
  instanceStatusSchema,
  secretInjectModeSchema,
} from "./base";

export const portForwardSchema = z.object({
  address: z.string(),
  localPort: z.number(),
  remotePort: z.number(),
});
export const portForwardArraySchema = z.array(portForwardSchema);

// A forwarded port is reachable ("listening") whenever the guest has ANY TCP
// listener on it, wildcard OR loopback. Loopback is no longer a footgun: the
// forward's relay runs inside the guest and dials 127.0.0.1, so a loopback-only
// server (the Vite/Next default) is reachable just the same.
export const portStatusSchema = z.object({
  remotePort: z.number(),
  status: z.enum(["listening", "not-listening"]),
});
export const portStatusArraySchema = z.array(portStatusSchema);
export type PortStatus = z.infer<typeof portStatusSchema>;

// The port panel's live view: the status of each currently-forwarded port plus
// the guest ports that are listening but not yet forwarded (one-click candidates).
export const portProbeSchema = z.object({
  forwarded: portStatusArraySchema,
  detected: z.array(z.number()),
});
export type PortProbe = z.infer<typeof portProbeSchema>;

// A secret the profile declares, paired with whether a value is currently
// stored for it. The value itself is never sent to the client, only its
// presence, so the UI can show "set" vs "not set, won't be injected".
// `inject` mirrors the declaration's delivery mode (see SECRET_INJECT_MODES).
// `hosts` is empty for the `env` mode, where host scoping doesn't apply.
export const profileSecretSchema = z.object({
  env: z.string(),
  hosts: z.array(z.string()),
  hasValue: z.boolean(),
  inject: secretInjectModeSchema,
});
export const profileSecretArraySchema = z.array(profileSecretSchema);
export type ProfileSecret = z.infer<typeof profileSecretSchema>;

// A pull request attached to a chat via the in-VM `isolade pr add` CLI. The
// state is refreshed in the background (PrStatePoller) by running `gh` inside
// the VM, where the user's GitHub auth lives, so the title-bar badge tracks the
// live PR. `state` is "unknown" until the first successful `gh` probe (and for
// non-GitHub hosts, where we can't read it). `host` distinguishes github.com
// from a GitHub Enterprise instance.
export const attachedPrSchema = z.object({
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  // The PR title, null until the first probe fills it in.
  title: z.string().nullable(),
  state: z.enum(["open", "closed", "merged", "unknown"]),
  isDraft: z.boolean(),
  // Canonical web URL, synthesized on attach so the badge links out even before
  // the first probe (which confirms/refreshes it).
  url: z.string(),
});
export const attachedPrArraySchema = z.array(attachedPrSchema);
export type AttachedPr = z.infer<typeof attachedPrSchema>;

// An instance is the user-facing "chat": one VM plus a title (null until the
// auto-summarizer fills it in). Tabs (chats / terminals) hang off
// the VM and are managed independently.
export const instanceSchema = z.object({
  id: z.string(),
  vmId: z.string(),
  title: z.string().nullable(),
  status: instanceStatusSchema,
  // Free-form description of the most recent VM-lifecycle failure
  // (boot-time auto-restart failure, user-triggered restart failure, etc).
  // Cleared on the next successful restart. Null when status === "running".
  lastError: z.string().nullable(),
  image: z.string(),
  // The profile this VM belongs to: its image, config, auth, git, network,
  // secrets. Nullable for VMs created before profiles existed, and optional so
  // producers that predate it (mocks) still parse.
  profileId: z.string().nullable().optional(),
  // Unpushed git work inside the VM (working-tree lines added/deleted vs
  // the nearest commit known to exist on a remote, and untracked files count
  // as additions). Server-refreshed while the VM runs. A stopped VM keeps
  // its last value. Null until the first probe, and for VMs with no git
  // repos.
  diffAdded: z.number().int().nonnegative().nullable(),
  diffDeleted: z.number().int().nonnegative().nullable(),
  // Sidebar activity signals, both derived server-side so the chat list reads
  // as a dashboard of background agents:
  //   working: an assistant turn is streaming right now in one of this
  //     instance's chats (live from the in-memory stream hub, never persisted).
  //   unread:  an assistant turn finished that the user hasn't viewed yet.
  //     Set when a turn completes, and cleared when the instance is opened (the
  //     client POSTs .../read). The two are prioritized working > unread in
  //     the UI: a running chat shows the shimmer, not the unread emphasis.
  working: z.boolean(),
  unread: z.boolean(),
  // Archived chats are hidden from the main sidebar list (collapsed under an
  // "Archived" disclosure) and their VM is kept stopped. Unarchiving boots it
  // back up, and clearing the archive deletes every archived chat.
  archived: z.boolean(),
  // Pinned chats surface under a dedicated "Pinned" heading at the top of the
  // sidebar. Purely presentational: unlike archiving, pinning has no VM
  // lifecycle effect. A chat is pinned XOR archived.
  pinned: z.boolean(),
  createdAt: dateLikeSchema,
  updatedAt: dateLikeSchema,
  ports: portForwardArraySchema.optional(),
  // Pull requests attached to this chat (via `isolade pr add`), in attach
  // order. Surfaced as a live badge in the title bar. Optional so producers
  // that predate it (mocks) still parse.
  prs: attachedPrArraySchema.optional(),
});
export const instanceArraySchema = z.array(instanceSchema);

export const terminalSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  createdAt: dateLikeSchema,
});
export const terminalArraySchema = z.array(terminalSchema);

// Per-chat subscription-window share. Mirrors the SubscriptionShare interface
// in server/src/chat/subscription-share.ts, and declared here so it can ride on
// both the SSE `usage` event and the persisted chat snapshot the GET
// endpoint returns.
export const subscriptionShareSchema = z.object({
  plan: z.object({ id: z.string(), label: z.string() }),
  fiveHourPct: z.number().nullable(),
  sevenDayPct: z.number().nullable(),
  fiveHourCurrentPct: z.number().nullable(),
  sevenDayCurrentPct: z.number().nullable(),
});

export const chatSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  model: z.string(),
  provider: chatProviderSchema,
  effort: chatEffortSchema,
  claudeSessionId: z.string().nullable(),
  codexThreadId: z.string().nullable(),
  // Cumulative per-chat totals, populated by the server after every turn.
  // Null on freshly-created chats that have never received a `usage` event,
  // and on legacy rows that predate the columns.
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  // Most recent turn's breakdown. Null on chats that have never streamed a
  // usage event. Used to rebuild the context-pressure bar after a reload.
  lastInputTokens: z.number().int().nonnegative().nullable(),
  lastCachedInputTokens: z.number().int().nonnegative().nullable(),
  lastCacheCreationInputTokens: z.number().int().nonnegative().nullable(),
  lastOutputTokens: z.number().int().nonnegative().nullable(),
  lastReasoningOutputTokens: z.number().int().nonnegative().nullable(),
  // Provider-reported context window for the last turn (codex only).
  modelContextWindow: z.number().int().positive().nullable(),
  // Whether the underlying CLI session has been auto-compacted. Sticky
  // until the model/provider changes.
  compacted: z.boolean().nullable(),
  // Server-computed (not stored): derived from the cumulative totals + the
  // resolved rate plan at GET time. Omitted when we can't make an estimate.
  subscriptionShare: subscriptionShareSchema.optional(),
  createdAt: dateLikeSchema,
});
export const chatArraySchema = z.array(chatSchema);

// Structured snapshot of Claude's `get_context_usage` control response.
// Codex has no equivalent. `available: false` for codex chats and for Claude
// chats that haven't streamed a turn yet, since there is no thread to probe.
// The upstream CLI estimates each category, so percentages may not sum exactly
// to 100.
export const contextBreakdownCategorySchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  percent: z.number().nonnegative(),
});
export const contextBreakdownSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    totalTokens: z.number().int().nonnegative(),
    contextWindow: z.number().int().positive(),
    percent: z.number().nonnegative(),
    categories: z.array(contextBreakdownCategorySchema),
  }),
  z.object({
    available: z.literal(false),
    reason: z.string(),
  }),
]);

export const chatMessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: chatMessageRoleSchema,
  content: z.string(),
  createdAt: dateLikeSchema,
});
export const chatMessageArraySchema = z.array(chatMessageSchema);

// One persisted SSE event. The payload is the JSON-encoded body of the
// event as it was forwarded to the live client. Replaying these in
// (messageId, seq) order through the chunk reducer reconstructs the
// rendered turn exactly. `type` mirrors the SSE event name.
export const chatEventSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  // Per-turn monotonic. Producer publishes use seq 0, 1, 2, …, and the
  // hub also writes a single `turn_started` marker row at seq=-1 the
  // moment a turn is registered, so chat_events is never empty
  // before the producer's first publish. Resume queries default to
  // `afterSeq=-1`, so the `seq > afterSeq` filter naturally excludes
  // the marker. Only mount-time `listChatEvents` (which returns
  // everything) sees it, and that path treats unknown types as no-ops.
  seq: z.number().int().min(-1),
  type: z.string(),
  // JSON-encoded payload. The shape depends on `type` and matches the
  // corresponding `data:` field on the live SSE stream, parsed lazily
  // client-side so we don't have to embed a discriminated union here.
  payload: z.string(),
  createdAt: dateLikeSchema,
});
export const chatEventArraySchema = z.array(chatEventSchema);

// USD-per-million-token rates for one model. Mirrors the four token buckets
// in TokenUsage. All fields optional: the catalog provides what's publicly
// documented, and missing fields just mean we skip the API-$ contribution for
// that bucket. We use these for two purposes:
//   - Computing the API-equivalent dollar cost for codex (Claude reports
//     `total_cost_usd` directly from its CLI, so we don't need to derive it).
//   - Weighting tokens against the subscription rate-limit window. The
//     ratios approximate the underlying inference cost, which we assume
//     correlates with how the subscription accounts for usage.
export const modelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
  outputPerMTok: z.number().nonnegative(),
});

// Static subscription rate-limit budgets, in *input-equivalent tokens*. We
// express the budget as how many fresh input tokens the plan grants in each
// window. For cache reads and outputs, the consumer scales their tokens by
// the API pricing ratio before dividing by this budget. We have to pick a
// single denominator because Anthropic and OpenAI don't publish per-token
// rate-limit costs, so the ratio idea folds the unknown into the model's
// catalog pricing entry.
//
// All numbers are best-effort from public docs and third-party blog
// estimates, deliberately approximate. The UI labels the resulting share as
// "approximate". `fiveHourTokens` covers Anthropic's 5-hour and ChatGPT's
// primary window, and `sevenDayTokens` covers Anthropic's 7-day and ChatGPT's
// secondary window. `null` means the plan doesn't gate that window for this
// model (e.g. Sonnet has no separate 7-day allowance, which is Opus-only).
export const ratePlanSchema = z.object({
  id: z.string(),
  label: z.string(),
  fiveHourTokens: z.number().int().positive().nullable(),
  sevenDayTokens: z.number().int().positive().nullable(),
});

export const chatModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: chatProviderSchema,
  // Fallback context window in tokens, used when the provider doesn't report
  // its own. Codex sends `modelContextWindow` on every usage update, so OpenAI
  // entries can leave this unset.
  contextWindow: z.number().int().positive().optional(),
  // Reasoning effort levels this model accepts. Anthropic doesn't expose a
  // public per-level capability matrix without an API key, so current 4.x
  // models declare all five levels; older/legacy models omit `max`. Codex
  // entries carry a curated menu (see shared/catalog.ts) drawn from the tiers
  // isolade can render; codex clamps an unsupported value server-side via
  // `nearest_effort`.
  supportedEfforts: z.array(chatEffortSchema).min(1),
  defaultEffort: chatEffortSchema,
  // API list pricing. Optional, since Codex models without published pricing
  // skip the API-$ chip. subscription-share falls back to treating all
  // tokens equally.
  pricing: modelPricingSchema.optional(),
});
export const chatModelArraySchema = z.array(chatModelSchema);

// Response for `GET /api/chat/models`. The full catalog (Claude + Codex) is
// static, so this is provider-agnostic and needs no profile scoping; per-profile
// visibility/tier is applied client-side via the profile's ModelOverrides.
export const chatModelsResponseSchema = z.object({
  models: chatModelArraySchema,
});

// One sliding rate-limit window. `utilization` is a 0-100 percentage of the
// window's budget that has been consumed (can exceed 100 if codex reports
// over-quota). `resetsAt` is when the window rolls over. `windowSeconds` is
// the window length: codex reports it (300 / 10080 minutes), Anthropic
// doesn't, so it's optional.
export const usageWindowSchema = z.object({
  utilization: z.number(),
  resetsAt: dateLikeSchema.nullable(),
  windowSeconds: z.number().int().positive().nullable(),
});

export const usageNamedWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  window: usageWindowSchema,
});

export const usageClaudeSchema = z.object({
  account: z
    .object({
      email: z.string().nullable(),
      organizationName: z.string().nullable(),
      rateLimitTier: z.string().nullable(),
      subscriptionType: z.string().nullable(),
    })
    .nullable(),
  fiveHour: usageWindowSchema.nullable(),
  sevenDay: usageWindowSchema.nullable(),
  weeklyWindows: z.array(usageNamedWindowSchema).default([]),
  sevenDayOpus: usageWindowSchema.nullable(),
  sevenDaySonnet: usageWindowSchema.nullable(),
  extraUsage: z
    .object({
      enabled: z.boolean(),
      monthlyLimit: z.number(),
      usedCredits: z.number(),
      currency: z.string(),
    })
    .nullable(),
});

export const usageCodexSchema = z.object({
  email: z.string().nullable(),
  planType: z.string().nullable(),
  activeLimit: z.string().nullable(),
  primary: usageWindowSchema.nullable(),
  secondary: usageWindowSchema.nullable(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      balance: z.string().nullable(),
      unlimited: z.boolean(),
    })
    .nullable(),
});

// Server returns one of these per provider: `{ data }` on success or
// `{ error }` if credentials are missing / the upstream call failed.
export const usageResultClaudeSchema = z.union([
  z.object({ ok: z.literal(true), data: usageClaudeSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const usageResultCodexSchema = z.union([
  z.object({ ok: z.literal(true), data: usageCodexSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

// Lifetime token + cost totals, summed from the persisted per-chat columns.
// One bucket per provider plus a grand total. `chats` is the number of
// chat rows contributing, useful to surface "across N chats" in the UI.
// Numbers are zero (not null) when there's no data, so the UI can render
// without null guards.
export const aggregateTotalsBucketSchema = z.object({
  chats: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reasoningOutputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  // Lifetime input-equivalent tokens, the same weighting used for the per-chat
  // subscription share, but summed across all chats in this bucket. Each
  // chat's tokens are weighted by its own model's pricing ratios so the
  // sum is consistent even when models differ within a provider.
  effectiveInputTokens: z.number().nonnegative(),
  // Lifetime subscription share, expressed as a percentage of the resolved
  // rate plan's per-window budget. Can exceed 100%, since it's how many windows'
  // worth of usage you've gotten from your subscription over time. Null on
  // the cross-provider `total` bucket (no single plan applies) and on
  // providers where we can't resolve a plan.
  subscriptionShare: subscriptionShareSchema.nullable(),
});
export const aggregateTotalsSchema = z.object({
  total: aggregateTotalsBucketSchema,
  anthropic: aggregateTotalsBucketSchema,
  openai: aggregateTotalsBucketSchema,
});

export const usageStatsSchema = z.object({
  fetchedAtMs: z.number(),
  claude: usageResultClaudeSchema,
  codex: usageResultCodexSchema,
  // Summed token + cost totals across all persisted chats. Null only if
  // the aggregation itself fails (DB lock, schema mismatch on legacy DB).
  // the upstream rate-limit panels keep rendering in that case.
  aggregate: aggregateTotalsSchema.nullable(),
});

// One calendar day of recorded usage, summed across providers (with the cost
// split kept so the heatmap tooltip can show the Anthropic/OpenAI breakdown).
// Days with no activity are simply absent, and the client fills the calendar grid
// and treats a missing day as zero.
export const usageDaySchema = z.object({
  day: z.string(), // local "YYYY-MM-DD"
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reasoningOutputTokens: z.number().nonnegative(),
  anthropicCostUsd: z.number().nonnegative(),
  openaiCostUsd: z.number().nonnegative(),
});

// Full persisted usage time series, ascending by day. Drives the
// contribution-graph heatmap on the Usage page.
export const usageHistorySchema = z.object({
  days: z.array(usageDaySchema),
});

export type PortForward = z.infer<typeof portForwardSchema>;
export type Instance = z.infer<typeof instanceSchema>;
export type Terminal = z.infer<typeof terminalSchema>;
export type Chat = z.infer<typeof chatSchema>;
export type SubscriptionShare = z.infer<typeof subscriptionShareSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatEvent = z.infer<typeof chatEventSchema>;
export type ChatModelDefinition = z.infer<typeof chatModelSchema>;
export type ChatModelsResponse = z.infer<typeof chatModelsResponseSchema>;
export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>;
export type ContextBreakdownCategory = z.infer<typeof contextBreakdownCategorySchema>;
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export type RatePlan = z.infer<typeof ratePlanSchema>;
export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type UsageNamedWindow = z.infer<typeof usageNamedWindowSchema>;
export type UsageClaude = z.infer<typeof usageClaudeSchema>;
export type UsageCodex = z.infer<typeof usageCodexSchema>;
export type UsageResultClaude = z.infer<typeof usageResultClaudeSchema>;
export type UsageResultCodex = z.infer<typeof usageResultCodexSchema>;
export type UsageStats = z.infer<typeof usageStatsSchema>;
export type AggregateTotalsBucket = z.infer<typeof aggregateTotalsBucketSchema>;
export type AggregateTotals = z.infer<typeof aggregateTotalsSchema>;
export type UsageDay = z.infer<typeof usageDaySchema>;
export type UsageHistory = z.infer<typeof usageHistorySchema>;
