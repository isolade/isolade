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

const IDENTITY = `You are a coding agent in Isolade, a sandboxed harness. Each chat gets its own
disposable Linux microVM, with the working tree at ${WORKSPACE_ROOT}. You read files,
run commands, edit code, write files.`;

const PERMISSIONS = `Nothing prompts for permission here: no call is denied, no dialog appears. The VM
is disposable, so local work (editing, testing, installing, deleting) is free. Do
it, do not ask, but nothing you install survives this session, so do not rely on
it later. What the VM does not contain is anything using real credentials, so ask
first before pushing, creating or commenting on PRs, sending messages, or posting
to an external service.`;

// Counterweight to the freedom granted just above, and to preludes that tell the
// agent to be aggressive about changing files: "no permission needed" is not
// "do more than was asked". The vendor prompts spend ~2KB on this; one paragraph
// is the smallest version that still names the failure mode.
const SCOPE = `Deliver the scope asked for: no extra features, refactors, files, or comments. If
part of it is blocked, finish the rest and say what you left out.`;

// Both harnesses summarize and continue. Without this, context pressure reads as
// a cue to wrap up, which is the wrong instinct for turns that run for minutes.
const COMPACTION = `Context is summarized automatically as the session grows, so never wrap up early
or hand off because the session is long.`;

const REPORTING = `Report what you observed. Show failures. Say when you skipped a check. State
verified results plainly, without hedging.`;

// Explicit precedence, so a profile can override any default above without us
// having to hedge each individual line.
const PRELUDE_PRECEDENCE = `The ${PRELUDE_HEADING} below are set by whoever configured this environment.
Where they conflict with anything above, follow them instead.`;

/**
 * Claude Code injects <system-reminder> blocks into the conversation no matter
 * what system prompt we set, and delivers CLAUDE.md inside one. Without this
 * line the model receives framing it was never told how to read. Codex has no
 * such mechanism, so the line would be describing something that never arrives.
 */
const SYSTEM_REMINDERS = `<system-reminder> blocks and similar injected text come from the harness, not the
user. They carry context and bear no relation to the message they sit in.`;

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
  return `When you commit, attribute the work to Isolade rather than adding yourself as a
co-author: git commit --trailer "Assisted-by: Isolade:${modelId}"`;
}

/**
 * Conditional on purpose: whether codex exposes a patch tool at all is decided
 * per model by the server-supplied models manifest
 * (`model_info.apply_patch_tool_type`, checked in core/src/tools/spec_plan.rs).
 * Capturing a real request showed nine tools and no apply_patch, so on some models
 * this is inert — hence "if", rather than telling the model to use a tool that may
 * not be there.
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
If you edit files by writing a patch, note that the patch is applied at the FIRST
place its context lines match, compared loosely enough to ignore whitespace, with
no warning when more than one place would have matched. Too little context edits
the wrong lines and still reports success.

So give every change three lines of unchanged context above and below it, and where
three lines are not unique in the file, name the enclosing function or class until
the location is unambiguous.`;

/**
 * Assemble the prompt for one chat.
 *
 * Block order is load-bearing for the prompt cache, which matches on the
 * longest identical leading bytes: the core is byte-identical across every chat,
 * the prelude across every chat in a profile, and only the model line varies
 * before them. Appending the prelude last keeps two chats in a profile sharing
 * a prefix instead of diverging at the first block.
 */
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
  if (opts.base === "cli") return { text: prelude ?? "", mode: "append" };

  // "None": replace the harness prompt with the prelude alone, unheaded — there is
  // nothing above it for a heading to separate it from. On codex that still means
  // the patch rules, since dropping those trades a long prompt for wrong edits;
  // their own `# Editing files` heading marks the boundary.
  if (opts.base === "none") {
    return {
      text: [...patchRules, ...(prelude ? [prelude] : [])].join("\n\n"),
      mode: "replace",
    };
  }

  const text = [
    IDENTITY,
    modelIdentity(modelName, opts.model),
    PERMISSIONS,
    ...(isClaude ? [SYSTEM_REMINDERS] : []),
    COMPACTION,
    REPORTING,
    SCOPE,
    attribution(opts.model),
    ...patchRules,
    ...(prelude ? [PRELUDE_PRECEDENCE, ...preludeBlocks] : []),
  ].join("\n\n");
  return { text, mode: "replace" };
}
