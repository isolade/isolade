# Cross-provider chat switching

Status: partially implemented

Implemented: per-message provider identity and the safe legacy migration,
persisted pending-switch state, active-session usage separation with a
transactional reset on target activation, the portable handoff (normalization,
envelope, capacity estimation, decision policy, chunking), explicit fresh
target startup with live-process retirement, and cross-provider switching end
to end (picker to committed target turn). A handoff that fits is transferred in
full; an oversized one is reduced to a compact summary, so an arbitrarily large
conversation still switches. Reduction is source-side: it forks the source
session (which already holds the whole conversation, prompt-cached) and
summarizes it in one turn. When there is no forkable source session it falls
back to re-feeding the transcript through a bounded rolling summary. The
transcript shows a persisted divider at the switch point.

Deviations from the design's exact mechanisms: the fork summarization uses a
normal summarize turn on the fork rather than Claude's native `/compact`
command or Codex's dedicated summary op, so it is one uniform path for both
providers and does not depend on parsing provider-internal compaction formats.
Guest-side native-transcript extraction over `SandboxClient` is not wired (the
host-side Isolade-branch handoff is used, which is also the design's raw
fallback), and reduction summarizes with the source model rather than the
target (the design's target-side chunking is the alternative path).

## Summary

An Isolade chat can switch between Claude Code and Codex without losing its
logical conversation. A switch starts a new session with the target provider
and gives it a provider-neutral handoff derived from the source transcript.
The VM and workspace do not change.

The common path does not make a separate summarization request. It transfers
the source context directly when that context fits comfortably in the target.
Source-side compaction is used only when the direct handoff would make the
target compact or would exceed its context limit.

The two directions differ because their native compaction formats differ:

- Claude to Codex uses Claude's native plaintext compact summary when one
  exists. If more compaction is needed, Isolade forks the Claude session,
  compacts the fork, and reads the new summary from the fork's JSONL transcript.
- Codex to Claude uses the full active Isolade transcript when it fits, even if
  Codex has compacted internally. Codex's native compact item is encrypted and
  not portable. If summarization is needed, Isolade forks the Codex thread and
  requests a plaintext handoff summary in a normal model turn.

If the source provider is unavailable, local transcripts remain usable. A raw
handoff that is below the target's hard limit can still be sent. A handoff above
the hard limit can be processed in bounded chunks by the target.

## Goals

- Switch an existing chat between Anthropic and OpenAI models.
- Preserve the active logical branch and the current workspace.
- Avoid an extra summarization call in the normal case.
- Prefer a source provider's own summary when compaction is necessary.
- Continue to work when the source provider has an API error or no remaining
  subscription usage.
- Never silently discard conversation content.
- Keep provider-specific reasoning and protocol data out of cross-provider
  prompts.
- Make failures transactional so the source session always remains usable.

## Non-goals

- Translating provider-private reasoning into another provider's reasoning
  format.
- Making Codex encrypted compact items readable or portable.
- Preserving prompt-cache identity across providers.
- Reproducing the exact token sequence seen by the source model.
- Moving the chat to a different VM or synchronizing filesystem snapshots.
- Automatically switching providers when one has an outage.

## Terminology

**Logical chat** is the user-visible Isolade message tree.

**Native session** is a Claude session or Codex thread and its provider-owned
transcript.

**Active branch** is the root-to-tip path selected by `activeLeafId`.

**Handoff** is the provider-neutral context injected into the first target
turn.

**Preferred compaction limit** is the point where the target would normally
auto-compact or where Isolade no longer considers a direct handoff safe.

**Hard limit** is the largest estimated target input after reserving space for
the target's instructions, tools, and response.

**Source availability** means that Isolade can complete one additional model
request with the source provider. It is independent of local transcript
availability.

## Invariants

1. The visible Isolade message tree remains the canonical logical chat.
2. Native transcripts remain the source of provider-specific continuation
   state and native compact summaries.
3. A cross-provider switch never mutates or deletes the source native session.
4. A cross-provider switch always creates a fresh target native session.
5. Hidden compaction, summarization, and chunking turns never appear as visible
   Isolade messages.
6. The active provider changes only after the first real target turn starts
   successfully.
7. Thinking blocks and signatures are never transferred.
8. No transcript content is truncated without an explicit user choice.
9. The first target request is checked as a whole, including the handoff and
   the current user message.

## Why every cross-provider switch starts a fresh session

A chat may move from Claude to Codex and later back to Claude. The old Claude
session does not know about the intervening Codex turns. Resuming it directly
would create a context gap.

Starting a fresh target session on every cross-provider switch gives the target
one coherent handoff representing the current logical branch. Old sessions are
retained as source material but are not resumed as the new tip.

Same-provider model changes continue to use the provider's native model-change
behavior and do not use this handoff flow.

## Source data

### Claude as source

Claude JSONL is the primary source. Isolade must:

1. Locate the JSONL for the assistant row's Claude session ID.
2. Reconstruct the active chain using `parentUuid` rather than physical line
   order.
3. Find the newest `isCompactSummary: true` message on that chain.
4. If a summary exists, use that summary and all subsequent model-visible
   conversation content.
5. If no summary exists, use all model-visible conversation content on the
   chain.
6. Apply understood persisted content replacements so transferred tool results
   match Claude's effective continuation context.

The portable summary contains Claude's generated summary body. Isolade removes
the standard Claude continuation wrapper and native transcript-path suggestion
so the target does not treat provider-specific resume instructions as current
user intent.

Claude JSONL stores the thinking summaries returned in Isolade's
`--thinking-display summarized` mode, along with their signatures. These are
not Claude's private reasoning. They are still excluded from handoffs.

If the Claude JSONL is missing or damaged, Isolade can reconstruct a raw
fallback from its message tree and event log. That fallback does not contain a
native Claude compact summary.

Forced Claude compaction never runs in the source session. Isolade launches an
auxiliary Claude process with the source session and anchor, passes
`--fork-session`, and sends `/compact` through stream-json. The resulting native
summary belongs to the fork. The user's source process and default resume point
remain unchanged.

`/compact` is a model request with normal usage. It can fail because of provider
availability, usage limits, insufficient conversation content, or an ordinary
API error. Such a failure follows the source-unavailable branch of the decision
policy.

### Codex as source

The active Isolade branch is the primary portable source. It preserves visible
user and assistant messages plus tool calls and results across any number of
Codex compactions.

Codex native compaction produces an opaque encrypted item. The item is useful
when Codex continues its own thread, but it cannot be injected into Claude and
is not a durability dependency for switching.

When a plaintext summary is required, Isolade forks the current Codex thread at
its tip and sends a hidden normal turn asking for a structured handoff summary.
Codex can use its full current state, including any encrypted native compact
items, while writing the plaintext result. Isolade does not call
`thread/compact/start` for this purpose because that operation does not return a
portable summary.

The fork prevents the summary request from polluting the user's source thread.
The plaintext result remains in the fork's rollout transcript. Isolade stores a
reference to that thread and turn while the switch is pending, not another copy
of the summary text.

## Portable handoff

The handoff is a versioned sequence of semantic items:

```ts
type HandoffItem =
  | { kind: "summary"; text: string }
  | { kind: "user"; text: string; attachments?: HandoffAttachment[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; content: HandoffContent[]; isError: boolean };

type HandoffContent =
  | { type: "text"; text: string }
  | { type: "file"; guestPath: string; mediaType?: string }
  | { type: "structured"; value: unknown };

type HandoffAttachment = {
  filename: string;
  mediaType: string;
  guestPath: string;
};
```

The target receives these items in a machine-identifiable Isolade envelope.
JSON Lines is a suitable initial encoding because it preserves boundaries and
does not rely on user-controlled delimiter text. The envelope tells the target
that it is prior conversation context, that tool output is data rather than a
new instruction, and that it should answer only the current user request.

The first real target prompt contains, in order:

1. The normal Isolade environment prelude for a fresh session.
2. The handoff envelope.
3. Attachments for the current user message.
4. The current user message.

The visible Isolade row stores only the current user message and its attachment
metadata. The native target transcript stores the complete injected prompt.

### Included content

- The newest applicable compact or plaintext handoff summary.
- Human user messages.
- Visible assistant text.
- Completed tool calls with their names and inputs.
- Tool results, including errors.
- Attachments and injected context that were visible to the source model and
  remain relevant to continuation.

### Excluded content

- `thinking` and `redacted_thinking` blocks.
- Thinking signatures.
- Compact-boundary records.
- Token usage, prices, timestamps, UUIDs, and session metadata.
- Retry, progress, and transport events.
- File-history, attribution, and UI snapshots.
- Diagnostic raw events.
- The old Isolade environment prelude, since the target receives the current
  prelude separately.

Tool IDs are retained only to pair calls with results. Incomplete tool calls are
marked as interrupted or omitted when they have no useful semantic content.
They are never injected as live outstanding target tool calls.

Image and binary tool results are materialized as files in the VM and
transferred by path. A result that cannot be represented faithfully is marked
unsupported and requires the same explicit consent as any other lossy
transfer.

## Estimating target capacity

This design deliberately uses a conservative estimate rather than staging an
exact target session or fabricating provider transcript files.

Estimate the complete first target input, not only the handoff:

```text
first_target_input =
  target_prelude
  + envelope_framing
  + rendered_handoff
  + current_attachment_preamble
  + current_user_message

estimated_input_tokens = ceil(utf8_bytes(first_target_input) / 3)
estimated_total_tokens =
  target_baseline_reserve
  + estimated_input_tokens
  + target_output_reserve
```

The byte ratio, baseline reserve, output reserve, and safety margin are named
constants with telemetry. The baseline reserve covers provider instructions and
tool schemas, not user-controlled prompt content. The current user message and
attachment preamble must always be measured explicitly. The constants should be
tuned from rejected requests and observed first-turn usage rather than made
provider-specific without evidence.

The target context window comes from the static catalog for Claude and from
Codex model metadata or its latest usage event for Codex. The target auto-
compaction limit is used when available. Otherwise Isolade estimates it as 90
percent of the effective context window.

The result falls into one of three buckets:

- **Direct:** below 85 percent of the preferred compaction limit.
- **Compaction preferred:** above the direct limit but below the hard limit.
- **Oversized:** above the hard limit.

The percentages are policy defaults, not provider guarantees. A context-limit
rejection always retries through the oversized path.

If the current user message alone exceeds the hard limit, reducing conversation
history cannot make the request valid. Isolade rejects the send and may offer
explicit user-message splitting. It never summarizes a new user instruction
without consent.

## Claude to Codex algorithm

1. Reconstruct the active Claude chain.
2. Build a candidate from the newest native Claude summary plus subsequent
   content. Use the full chain when no summary exists.
3. Render and estimate the candidate for the selected Codex model.
4. For a direct candidate, inject it unchanged.
5. For a compaction-preferred candidate, fork Claude at the source anchor and
   send `/compact` if Claude is available. Read the new summary from the fork's
   JSONL, rebuild, and re-estimate.
6. If Claude is unavailable and the candidate remains below Codex's hard
   limit, inject it unchanged and allow Codex to compact later.
7. For an oversized candidate, compact a Claude fork when available. If Claude
   is unavailable or compaction still does not fit, use target-side chunking.

Only the newest Claude summary is transferred. It supersedes older summaries
and all content that it summarizes.

## Codex to Claude algorithm

1. Reconstruct the complete active logical branch from the Isolade message and
   event stores.
2. Ignore native Codex compact items when constructing the portable candidate.
3. Render and estimate the full raw candidate for the selected Claude model.
4. For a direct candidate, inject the full raw transcript even if Codex has
   compacted internally.
5. For a compaction-preferred or oversized candidate, fork Codex at the tip and
   request a plaintext handoff summary if Codex is available.
6. Re-estimate that summary and inject it when it fits.
7. If Codex is unavailable and the raw candidate remains below Claude's hard
   limit, inject it unchanged and allow Claude to compact.
8. If Codex is unavailable and the candidate is oversized, use target-side
   chunking.

The plaintext Codex summary request is a normal hidden model turn and therefore
has normal usage. It is made only when the raw candidate would cross the target
compaction policy.

## Target-side chunking

Providers do not automatically divide one oversized incoming handoff into
multiple requests. Auto-compaction operates on history the provider has already
accepted. An oversized first input can be rejected before that mechanism can
help.

Chunking is the fallback when the source cannot produce a smaller handoff:

1. Split the portable sequence at conversation-turn boundaries.
2. Keep every tool call with its result where possible.
3. Bound each chunk comfortably below the target's direct limit.
4. Send the first chunk to an auxiliary target session and request a structured
   rolling summary.
5. Send only the previous rolling summary plus the next chunk to another
   auxiliary target session.
6. Repeat until all chunks have been consumed.
7. Start the real target session with the final rolling summary and the current
   user message.
8. Re-estimate the complete final request before sending it.

Using a new auxiliary session for each step prevents the scratch context from
growing until it needs its own unpredictable compaction. Auxiliary sessions are
not shown in the logical chat.

If one user message or tool result exceeds the chunk budget by itself, split
that item into labeled parts. Tool output may instead be explicitly truncated
only when the user chooses a lossy transfer.

Chunking costs one billable target model request per chunk and compounds
summarization loss. It requires a reachable target provider and user
confirmation before the first paid chunk. Source-side compaction is preferred
whenever it is available.

## Availability matrix

| Source request | Target request | Candidate size | Action |
| --- | --- | --- | --- |
| Available | Available | Direct | Transfer directly |
| Unavailable | Available | Direct | Transfer from local transcripts |
| Available | Available | Compaction preferred | Compact or summarize at the source, then transfer |
| Unavailable | Available | Compaction preferred | Transfer raw and allow target compaction |
| Available | Available | Oversized | Compact or summarize at the source, then re-estimate |
| Unavailable | Available | Oversized | Use target-side chunking |
| Any | Unavailable | Any | Keep the pending switch and retry later |
| Unavailable | Unavailable | Any | Keep all local state and wait |

Authentication failures, exhausted subscription usage, API errors, and source
compaction failures all make the affected request unavailable for this matrix.
No separate availability probe is required. Isolade attempts the necessary
operation and classifies the returned error.

Both Claude `/compact` and Codex plaintext handoff generation are billable
source model requests. Target-side chunking is a sequence of billable target
requests. The UI shows this before starting work that is not part of the normal
direct-transfer path.

If the user does not want the cost of chunking, the alternatives are to retry
later, start the target with no history, or explicitly transfer a bounded recent
suffix.

## Switch lifecycle

A provider change is prepared lazily and activated by the next real user turn.
This avoids a throwaway target acknowledgment turn.

Transcript preparation and target activation require a running instance. A
model may be selected while an instance is stopped or archived, but that action
only records the pending switch. Activation waits until the instance has been
unarchived and is running, exactly like an ordinary user turn.

### Selection

When the user chooses a model from another provider, Isolade records a pending
switch containing:

- Source provider, model, active leaf, session ID, and anchor.
- Target provider, model, and effort.
- Status and last error.
- References to any auxiliary source or target sessions created during the
  attempt.

It does not change `chats.provider` yet. Selecting another model before sending
a message replaces the pending switch without making a model request.

### Activation

On the next send:

1. Lock the chat against another turn, branch change, or switch.
2. Verify that the active leaf still matches the pending switch.
3. Reconstruct, estimate, and if necessary reduce the handoff.
4. Start a fresh target session with the handoff and the real user message.
5. Stage the target session ID and buffer target events without changing the
   active provider.
6. Once the provider accepts the model request, atomically commit the target
   provider, model, effort, session ID, visible user row, and active-session
   usage reset. A first model response event or a successful empty result proves
   acceptance. Local process or thread creation alone does not.
7. Replay buffered target events against the committed target configuration and
   clear the pending switch.
8. Commit the assistant row and its provider-native anchor when that metadata
   becomes available, normally at turn finalization.

If target initialization or the model request fails before provider acceptance,
the source remains active and the pending switch remains retryable. Isolade does
not silently send the user's message to the source provider.

If source compaction succeeds and target initialization then fails, the native
summary remains in the auxiliary fork transcript and can be reused. A completed
Codex handoff summary or chunking step is likewise reused through its auxiliary
transcript reference.

If the target request is accepted and the turn later fails, the chat remains on
the target provider. A partial target turn may already have changed the
workspace, and reverting the provider pointer would make the native session and
logical state disagree.

## Storage changes

The current schema assumes that every assistant row belongs to the chat's
current provider. Cross-provider history requires provider identity on each
assistant row.

Add to `chat_messages`:

- `provider` on assistant rows, null on user rows and unknown legacy rows.
- Optionally `model`, for diagnostics and future model-specific replay.
- Existing `session_id` and `anchor_id` remain provider-native values.

The server API has already allowed provider changes while clearing old native
metadata. A migration must therefore backfill `provider = chats.provider` only
for assistant rows with a non-null `session_id` or `anchor_id`. Rows without
enough evidence remain `NULL`.

Add a `provider_switches` table or equivalent persisted state with:

- Chat ID and source active leaf ID.
- Source and target provider configuration.
- State such as `pending`, `preparing`, `activating`, or `failed`.
- Auxiliary native session and turn references.
- Error classification and timestamps.

Do not store duplicate handoff or summary text. Read it from the native
transcript referenced by the switch state. The Isolade message and event stores
remain the fallback raw transcript.

Keep both `claude_session_id` and `codex_thread_id` on the chat. On a successful
switch, overwrite only the target provider's pointer. Do not clear old
per-message session anchors. The new per-message provider field disambiguates
them.

The existing chat usage columns hold one native session's cumulative totals.
They must be reset in the target-session commit before the first target usage
event. Otherwise `updateUsage` compares a fresh target total against a larger
source total, clamps the negative delta to zero, and loses target usage from the
append-only usage log.

Historical usage remains in `usage_events`, attributed to the provider and
model active for each event. If Isolade needs a lifetime total for one logical
chat, `usage_events` must gain a chat ID or a separate logical-chat aggregate
must be maintained. Token counts from different provider tokenizers must not be
presented as one meaningful context total. Dollar cost can be summed across
providers.

## Branching and editing

The provider recorded on each assistant row determines whether a native fork is
valid.

An edit can use a native provider fork only when the selected provider has an
anchored session that represents the entire edited prefix. If another provider
appears between that anchor and the edit point, Isolade starts a fresh session
and uses the same handoff pipeline for the edited prefix.

Switching visible branches invalidates a pending provider switch because its
source leaf no longer identifies the active conversation. The user can select
the target again on the new branch.

The VM filesystem is intentionally not rewound when switching or editing.

## Native transcript access

Claude JSONL and Codex rollout files normally live on the guest VM disk, not on
the host. Profile cache mounts may expose them in some configurations, but the
switch implementation cannot depend on that.

A provider-specific extractor runs inside the guest through `SandboxClient`.
It receives a native session reference and source anchor, then emits only the
normalized handoff items or summary reference needed by the host. It must not
copy an unbounded transcript to the host. Large JSONL files require streaming
or indexed processing with explicit output bounds.

The extractor is version tolerant. Unknown native entries are skipped only
when they are known not to be conversation-bearing. A schema mismatch that
could hide user, assistant, or tool content fails over to the Isolade message
and event stores instead of silently producing a partial handoff.

Fixtures from supported Claude and Codex CLI versions protect the parser from
private transcript format changes.

### Live process ownership

The current Claude backend keeps one live process per chat ID. A cross-provider
round trip must not reuse a process positioned at an older Claude tip. Target
activation therefore uses an explicit fresh-session operation that replaces or
retires any stale chat-keyed process only after the handoff is ready.

Auxiliary Claude compaction forks are managed separately from the ordinary
chat-keyed process. Creating or disposing an auxiliary fork cannot replace,
reconfigure, or shut down the user's source process.

After a successful switch away from Claude, Isolade may retire the old live
process while preserving its transcript. The implementation must define what
happens to provider-owned background tasks and must not imply that preserving a
native session also preserves a running process forever.

## Transcript retention

Native summaries are read from native transcripts, so those transcripts must
outlive the chat.

For Claude, Isolade should set `cleanupPeriodDays` to a very large positive
value such as `365000`. Zero must not be used because current Claude Code treats
it as disabling session persistence. This is effectively permanent retention
without depending on an undocumented infinity sentinel.

Codex rollout files and auxiliary fork transcripts must remain on the instance
disk. Isolade must not depend on remote retention of Codex encrypted compact
items. The local rollout is the durable copy available to Isolade.

Large retention is expected to grow disk usage. Cleanup should be an explicit
user action and must warn when it would make old chats or pending switches
non-resumable.

## Failure handling

- A context-limit rejection retries through source reduction or target
  chunking.
- A source usage or authentication failure follows the source-unavailable row.
- A target usage or authentication failure leaves the switch pending.
- A malformed native transcript falls back to the Isolade transcript.
- A stopped instance does not activate until its normal restart or boot path
  completes.
- An archived instance keeps the switch pending until it is unarchived.
- A missing auxiliary transcript restarts only the missing preparation step.
- A server restart resumes a persisted pending switch from its last completed
  reference.
- Cancellation stops auxiliary work and leaves the source active.
- Partial target output before activation is not added to the visible chat.
- No failure clears source session IDs, message anchors, or transcripts.

Starting fresh or transferring only recent context are explicit recovery
choices. They are never automatic fallbacks.

## Privacy and trust boundaries

A switch sends prior conversation data from one provider to another. This is a
direct consequence of the user selecting the target provider and should be
stated in the UI before the first cross-provider switch.

Tool output is labeled as historical data inside the handoff. It must not be
presented as a system or developer instruction. Existing user instructions
remain user instructions because preserving them is the purpose of the handoff.

Thinking summaries and signatures are retained locally for native resume but
are not shared across providers.

## API and UI outline

The existing model picker may continue to submit the desired model and effort.
The server distinguishes same-provider changes from cross-provider switches.

For a cross-provider selection, the chat response includes pending target
metadata so the picker can show the selected model without claiming that the
native switch has already completed. The composer shows `Transferring context`
while the first target turn prepares its handoff.

The UI must support these outcomes:

- Switch ready and first target turn running.
- Target unavailable, with retry and cancel actions.
- Source unavailable but raw transfer remains possible.
- Additional chunking cost required, with confirmation.
- Lossy recent-context transfer requested explicitly.

The current `PATCH /api/instances/:id/chats/:chatId` behavior must no longer
clear both provider session IDs or all per-message anchors on a cross-provider
selection.

The turn path must use the pending target provider, model, and effort for
backend selection, pricing, usage enrichment, and persistence. It must not use
the stale source configuration captured when the chat was first loaded.

## Backend responsibilities

Extend the provider-neutral backend layer with operations conceptually
equivalent to:

```ts
interface ProviderHandoffBackend {
  extractSourceHandoff(...): Promise<PortableHandoff>;
  compactSourceForHandoff(...): Promise<NativeSummaryReference>;
  summarizeSourceForHandoff(...): Promise<NativeSummaryReference>;
  startFreshWithHandoff(...): Promise<TurnResult>;
}
```

Claude implements guest-side JSONL extraction and native `/compact` on an
auxiliary fork. Codex implements the forked plaintext summary turn. Fresh target
startup bypasses any stale chat-keyed process or thread pointer. A separate
handoff service owns transcript normalization, rendering, estimates, decision
policy, chunking, and switch transactions. These concerns should not be added
to `ChatTurnService` beyond a single pending-switch activation call.

The fresh-start operation reports target session creation separately from
provider request acceptance. The handoff service buffers usage and output until
acceptance commits the switch, then replays those events using the target
provider and model rather than a stale source chat object.

## Testing

### Unit tests

- Claude active-chain reconstruction with branches.
- Latest Claude compact summary selection after multiple compactions.
- Claude content replacement application.
- Filtering of thinking, signatures, metadata, and diagnostics.
- Isolade active-branch reconstruction across Codex compactions.
- Portable rendering and tool call/result pairing.
- Conservative capacity estimation for the complete first target request at
  every boundary.
- A current user message that exceeds the hard limit by itself.
- Every row in the availability matrix.
- Chunk splitting, including one oversized tool result.
- Text, structured, image, and binary tool result normalization.
- Pending-switch state transitions and crash recovery.
- Legacy provider backfill with previously switched chats.
- Active-session usage reset before the first target usage event.
- Native transcript fixtures from every supported provider CLI version.

### Integration tests

- Claude to Codex with no prior compaction.
- Claude to Codex using an existing native compact summary.
- Claude to Codex after forced source compaction.
- Codex to Claude with raw history despite native Codex compaction.
- Codex to Claude through a forked plaintext summary.
- Round trip from Claude to Codex and back to Claude.
- Round trip while an old chat-keyed Claude process is still alive.
- Switch on an edited branch.
- Source unavailable with a direct handoff.
- Source unavailable with target-side chunking.
- Target unavailable before activation.
- Target context rejection after an underestimated handoff.
- Source VM stopped during selection and booted for activation.
- Source VM archived with activation deferred until unarchive.
- Forced Claude compaction on a fork followed by target failure, asserting that
  the original Claude tip remains resumable and unchanged.
- Target turn failure after provider acceptance, asserting that the target
  remains active and its partial state is recoverable.
- Server restart during every persisted switch state.

Each test must assert that hidden preparation turns are absent from the visible
message tree and that the source session remains resumable after failure.

## Rollout

1. Add per-message provider identity, safe legacy migration, and persisted
   pending-switch state.
2. Separate active-session usage from logical-chat usage and make target
   activation reset the active counters transactionally.
3. Implement guest-side transcript extraction, portable normalization, and
   complete-request estimation.
4. Add explicit fresh target startup and auxiliary provider session ownership.
5. Ship direct cross-provider switching for handoffs below the preferred limit.
6. Add Claude native-summary extraction and `/compact` on a fork.
7. Add Codex forked plaintext summaries.
8. Add provider-unavailable fallbacks and target-side chunking.
9. Tune estimates and reserves from telemetry without recording handoff text.
