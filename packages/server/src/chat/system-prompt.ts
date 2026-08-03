// The system prompt Isolade gives its coding agents, plus the per-profile
// prelude that layers on top of it.
//
// Why we build this ourselves instead of taking the harness default: both CLIs
// ship a prompt written for someone sitting at their own terminal with a
// permission prompt in front of every risky call. Neither is true here. Every
// chat is a disposable microVM running with permission checks off, so the stock
// text spends most of its length on guidance that is either wrong (a terminal
// UI, `/fast`, IDE extensions) or inert (what to do when a call is denied),
// while saying nothing about the two facts that actually matter: nothing will
// stop you, and the VM boundary is not the credential boundary.
//
// Each line below is here for one of two reasons: it is a fact the model cannot
// obtain any other way, or it counters a failure mode the vendor's own prompt
// counters unconditionally across models. Anything that was merely good agent
// hygiene is deliberately absent. Resist adding to this file without one of
// those two justifications.
//
// The two providers are NOT symmetric, and that is deliberate:
//
//   Claude replaces its prompt (`--system-prompt`). Its tool contracts live in
//   the tool schemas, which we leave untouched, so replacing the prompt costs
//   nothing mechanically.
//
//   Codex replaces its prompt too (`thread/start.baseInstructions`), verified by
//   capturing a real request: its own ~16KB prompt, its personality section and
//   its tool guidance all disappear, while the tool SPECS are still sent. So the
//   loss is guidance, not capability — and CODEX_PATCH_RULES covers the one piece
//   of that guidance whose absence is silent rather than loud.
//
// The asymmetry runs deeper than that, and it is why several blocks below are
// per-provider. What each harness still injects once its prompt is replaced,
// measured on the wire rather than read out of either source tree:
//
//   Claude sends three system blocks — a billing header, the SDK identity line,
//   and ours. No environment section, no cwd, no permission-mode text. Nothing
//   else will say where the working tree is or that approvals are off.
//
//   Codex sends `<permissions instructions>` (naming `sandbox_mode`
//   danger-full-access and `approval_policy` never) and `<environment_context>`
//   (cwd, shell, date, timezone, workspace roots) as conversation items. Repeating
//   either would be telling it something it has already read.
import { type ChatProvider, findChatModel, type PromptBase, WORKSPACE_ROOT } from "../contracts";

/**
 * What a chat's system prompt resolves to: the text, and whether it stands in
 * for the CLI's own prompt or layers on top of it.
 *
 * The mode is not cosmetic, and both providers honour it. On Claude it selects
 * between `--system-prompt` and `--append-system-prompt`; on codex between
 * `baseInstructions` (the request's `instructions` slot) and
 * `developerInstructions` (a developer-role message in the input). Either way it
 * is what makes "keep the CLI's own prompt" expressible as a choice.
 *
 * `mode: "replace"` with empty text is meaningful — it is how a profile asks for
 * NO prompt at all, and the empty `--system-prompt ""` is what suppresses the
 * CLI's default. `mode: "append"` with empty text is a no-op.
 */
export interface IsoladeSystemPrompt {
  text: string;
  mode: "replace" | "append";
}

// Header for the per-profile prelude. A heading rather than the `<prelude>`
// tags the old user-message injection used: inside a system prompt the text is
// already distinguishable as instruction, so the tags bought nothing.
const PRELUDE_HEADING = "# Project instructions";

/**
 * No "you read files, run commands, edit code": that restates the tool schemas,
 * which both providers send in full whatever we do here.
 *
 * The working tree is named for Claude only. Its harness sends no environment
 * block once the prompt is replaced, and its file tools want absolute paths, so
 * without this the model has to spend a call on `pwd`. Codex reads the same path
 * out of `<environment_context>`.
 */
function identity(isClaude: boolean): string {
  const tree = isClaude ? `,\nwith the working tree at ${WORKSPACE_ROOT}` : "";
  return `You are a coding agent in Isolade. This chat has its own disposable Linux microVM${tree}.`;
}

/**
 * The same fact for the "extended" overlay, where the harness prompt is still in
 * front of ours. Neither vendor mentions a VM at all, so where the chat runs is
 * still worth saying — but both already supply the working directory, so the
 * tree is not repeated and the sentence is phrased as an addition to a prompt
 * that has already introduced the agent.
 */
const OVERLAY_IDENTITY = `You are running in Isolade, which gives this chat its own disposable Linux microVM.`;

/**
 * Claude only, and load-bearing there: replacing the CLI's prompt leaves nothing
 * that says approvals are off, while the Bash tool description — which
 * `--system-prompt` does not touch — still warns that `cd` in a compound command
 * "can trigger a permission prompt". So this is correcting the tool schema, not
 * just filling a gap.
 *
 * Codex needs none of it. Its `<permissions instructions>` item already reports
 * `sandbox_mode` danger-full-access and `approval_policy` never.
 */
const SANDBOX = `Nothing here prompts for permission and no call is denied. The VM is disposable, so
edit, test, install and delete freely, without asking.`;

/**
 * The counterweight, and the one thing neither harness says. Codex's permissions
 * item mentions only that network access is enabled, which points the wrong way.
 */
const CREDENTIALS = `Pushing, opening or commenting on PRs, and posting anywhere outside the VM use real
credentials, so ask first.`;

/**
 * Both harnesses summarize and continue, so context pressure is never a reason to
 * stop — but the reason this earns its bytes is how the failure plays out here
 * rather than that the vendors also say it.
 *
 * At a terminal, an agent that decides to hand off gets "keep going" typed at it a
 * second later. An isolade chat runs unattended in its own VM, often alongside
 * others, and long autonomous runs are the point of the product; the same wrong
 * instinct is found much later, with the turn already ended. Expensive failure,
 * slow correction loop, one sentence to prevent.
 */
const COMPACTION = `Context is summarized automatically as the session grows, so never wrap up early
because the session is long.`;

/**
 * Scope creep and overclaiming, together because both are about what the turn hands
 * back rather than how it works.
 *
 * The scope half is structural, not stylistic. In an ordinary harness the permission
 * prompt is what bounds an agent's blast radius: every risky call stops and asks,
 * and a user declining is how "that is not what I meant" gets said early. SANDBOX
 * above removes that mechanism outright, and a prelude may push the same way again.
 * Something has to take over the job, and a sentence is the cheapest thing that can.
 * It also matters more here than at a terminal because the output is a branch
 * someone reviews, so extra work converts into review burden rather than visible
 * mess.
 *
 * The reporting half covers what the user actually reads. Tool calls are on screen,
 * but the artifact of a chat is the final message and the diff — so an unverified
 * claim is what survives, and it is what would make the other lines here look
 * satisfied when they are not.
 */
const DELIVERY = `Deliver the scope asked for, no more; if part of it is blocked, finish the rest and
say what you left out. Report what you observed, failures included, and state
verified results without hedging.`;

// Explicit precedence, so a profile can override any default above without us
// having to hedge each individual line.
const PRELUDE_PRECEDENCE = `The ${PRELUDE_HEADING} below are set by whoever configured this environment.
Where they conflict with anything above, follow them instead.`;

/**
 * Claude Code injects <system-reminder> blocks into the conversation no matter what
 * system prompt we set, and delivers CLAUDE.md inside one. Without this line the
 * model receives framing it was never told how to read.
 *
 * Worth being precise about which injections this is for, because the loudest ones
 * do NOT need it. A model switch arrives as three user messages that open with
 * `<local-command-caveat>`, explaining themselves in full, and isolade's own
 * cross-provider handoff carries the framing paragraph in envelope.ts. Anything that
 * announces itself is already handled.
 *
 * What this covers is the rest, which arrives unannounced and mostly inside tool
 * results: `<system-reminder>This file is already in your context`, `Warning: the
 * file exists but the contents are empty`, `GitHub API rate limit exceeded`, the
 * agent-type listing, `<bash-stdout>`/`<bash-stderr>` around background output. None
 * of those say where they came from, and a model that reads one as the user speaking
 * answers the wrong thing.
 *
 * Claude only. Codex has no such injection mechanism, so the line would be
 * describing something that never arrives — its handoff arrives as ordinary input.
 */
const SYSTEM_REMINDERS = `Injected text such as <system-reminder> comes from the harness, not the user, and
bears no relation to the message it sits in.`;

/**
 * The model line and the attribution trailer both interpolate the id rather than
 * leaving it for the model to fill in, which is the whole point on the codex
 * side: its base prompt only says "based on GPT-5" and its
 * `<environment_context>` carries just cwd and shell, so a Sol/Terra/Luna chat
 * cannot name its own model and would write a wrong trailer.
 */
function modelIdentity(modelName: string, modelId: string): string {
  return `You are running ${modelName} (model ID: ${modelId}).`;
}

// Replaces the harness's own attribution. On the Claude side we also blank
// `attribution.commit`/`.pr` via --settings so the Bash tool's commit guidance
// stops advertising a competing Co-Authored-By line; codex adds no attribution
// of its own and needs no equivalent.
function attribution(modelId: string): string {
  return `Commit with git commit --trailer "Assisted-by: Isolade:${modelId}" rather than
adding yourself as a co-author.`;
}

/**
 * Conditional on purpose: whether codex exposes a patch tool at all is decided
 * per model by the server-supplied models manifest
 * (`model_info.apply_patch_tool_type`, checked in core/src/tools/spec_plan.rs).
 * Capturing a real request showed no apply_patch among the tools, so on some models
 * this is inert. Hence a statement about how patches apply rather than an
 * instruction to reach for a tool that may not be there.
 *
 * Worth the bytes where it does apply, because the failure is silent rather than
 * loud: codex-rs/apply-patch/src/seek_sequence.rs takes the FIRST context match,
 * retries with trailing then all whitespace ignored, and never checks whether a
 * second place also matched. There is no ambiguity guard in the crate. So an
 * under-contexted hunk edits the wrong lines and reports success.
 *
 * Claude needs no equivalent: its Edit tool states its own contract in a tool
 * schema, which --system-prompt leaves untouched.
 */
const CODEX_PATCH_RULES = `# Editing files
A patch applies at the FIRST place its context lines match, compared loosely enough
to ignore whitespace, with no warning when more than one place matches, so too
little context edits the wrong lines and still reports success. Give every change
three unchanged lines above and below, and where three are not unique in the file,
name the enclosing function or class.`;

/**
 * Claude concatenates the blocks of its system array with nothing in between, and
 * the block before ours is the SDK identity line ("You are a Claude agent, built
 * on Anthropic's Claude Agent SDK."). Unpadded, the model reads
 * "...Claude Agent SDK.You are a coding agent in Isolade". Claude Code's own
 * prompt opens with a bare newline for exactly this reason — see
 * getSimpleIntroSection in constants/prompts.ts, which carries an eslint-disable
 * for a rule named `custom-rules/prompt-spacing`.
 *
 * Only when replacing: appending is joined by the CLI with a blank line already.
 *
 * Codex needs none of this. It gives each section its own content part rather than
 * one blob, and does not pad between its own sections either, so padding there
 * would only add trailing whitespace. Both facts are pinned in
 * codex-stub-api.test.ts.
 */
function pad(text: string, provider: ChatProvider, mode: IsoladeSystemPrompt["mode"]): string {
  // An empty replace is a flag (`--system-prompt ""`), not content, so leave it be.
  if (text.length === 0 || provider !== "anthropic" || mode !== "replace") return text;
  return `\n${text}`;
}

export function buildSystemPrompt(opts: {
  provider: ChatProvider;
  model: string;
  prelude: string | null;
  // Which base prompt precedes the prelude. See promptTableSchema.
  base: PromptBase;
}): IsoladeSystemPrompt {
  const modelName = findChatModel(opts.model)?.name ?? opts.model;
  const isClaude = opts.provider === "anthropic";
  const prelude = opts.prelude?.trim();
  // Only needed where we are standing in for codex's own prompt. It is the one
  // piece of that prompt whose absence corrupts files rather than annoying anyone.
  const patchRules = isClaude ? [] : [CODEX_PATCH_RULES];
  const preludeBlocks = prelude ? [`${PRELUDE_HEADING}\n${prelude}`] : [];

  // "The agent's own": leave the harness prompt entirely alone and layer only the
  // profile's instructions on top.
  if (opts.base === "unmodified") {
    return { text: pad(prelude ?? "", opts.provider, "append"), mode: "append" };
  }

  // "Extended": keep the harness prompt and append only what it gets wrong or omits
  // about running here. Everything else in this file is deliberately absent, because
  // both vendor prompts were checked for it and both already cover it — scope,
  // reporting, automatic summarization, the injected-text framing, the working
  // directory, and on Claude the model id.
  //
  // What is left is four things:
  //
  //   The VM. Neither prompt mentions one, so neither says the environment is
  //   disposable.
  //
  //   The permission posture, Claude only. Not merely missing there but contradicted:
  //   its prompt says "Tools run behind a user-selected permission mode; a denied
  //   call means the user declined it" and "For actions that are hard to reverse or
  //   outward-facing, confirm first". Under --dangerously-skip-permissions the first
  //   is false and the second is friction with nothing behind it. Codex is told
  //   `approval_policy` never by its own <permissions instructions>, so it needs no
  //   correction.
  //
  //   The credential boundary, both. It has to travel with the sandbox line or that
  //   line reads as "nothing ever needs asking", and it is the precise version of
  //   what Claude's prompt gestures at.
  //
  //   Attribution, both, which is the whole reason a profile might pick this option:
  //   neither prompt mentions a trailer, and the Bash tool's default Co-Authored-By
  //   line is blanked through --settings regardless of base.
  //
  // Plus the exact model id on codex, whose prompt only says "based on GPT-5".
  if (opts.base === "extended") {
    const overlay = [
      OVERLAY_IDENTITY,
      ...(isClaude ? [SANDBOX] : []),
      CREDENTIALS,
      ...(isClaude ? [] : [modelIdentity(modelName, opts.model)]),
      attribution(opts.model),
      ...(prelude ? [PRELUDE_PRECEDENCE, ...preludeBlocks] : []),
    ].join("\n\n");
    return { text: pad(overlay, opts.provider, "append"), mode: "append" };
  }

  // "Minimal": replace the harness prompt with the prelude alone, unheaded — there
  // is nothing above it for a heading to separate it from. Called "minimal" rather
  // than "none" because on codex it still carries the patch rules: dropping those
  // trades a long prompt for wrong edits. Their `# Editing files` heading marks the
  // boundary.
  if (opts.base === "minimal") {
    const minimal = [...patchRules, ...(prelude ? [prelude] : [])].join("\n\n");
    return { text: pad(minimal, opts.provider, "replace"), mode: "replace" };
  }

  // Ordered stable-to-volatile, because the prompt cache matches on the longest
  // identical leading bytes. Everything down to the patch rules is byte-identical
  // across every chat on a provider; the two blocks that interpolate the model id
  // sit together after it, so switching a chat's model invalidates only the tail
  // rather than everything from the second block on. The prelude stays last
  // regardless — PRELUDE_PRECEDENCE gives it the final word, and position should
  // agree with that.
  const text = [
    identity(isClaude),
    ...(isClaude ? [SANDBOX] : []),
    CREDENTIALS,
    ...(isClaude ? [SYSTEM_REMINDERS] : []),
    COMPACTION,
    DELIVERY,
    ...patchRules,
    modelIdentity(modelName, opts.model),
    attribution(opts.model),
    ...(prelude ? [PRELUDE_PRECEDENCE, ...preludeBlocks] : []),
  ].join("\n\n");
  return { text: pad(text, opts.provider, "replace"), mode: "replace" };
}
