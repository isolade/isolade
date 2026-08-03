import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../src/chat/system-prompt";
import type { PromptBase } from "../src/contracts";

const claude = (prelude: string | null = null, base: PromptBase = "isolade") =>
  buildSystemPrompt({ provider: "anthropic", model: "claude-opus-5", prelude, base }).text;
const codex = (prelude: string | null = null, base: PromptBase = "isolade") =>
  buildSystemPrompt({ provider: "openai", model: "gpt-5.6-sol", prelude, base }).text;

describe("buildSystemPrompt", () => {
  it("names the model and its exact id", () => {
    // Interpolated rather than left to the model: codex only tells its models
    // they are "based on GPT-5", so a Sol chat cannot name itself.
    expect(codex()).toContain("You are running GPT-5.6 Sol (model ID: gpt-5.6-sol).");
    expect(claude()).toContain("You are running Opus 5 (model ID: claude-opus-5).");
  });

  it("falls back to the raw id for a model missing from the catalog", () => {
    const prompt = buildSystemPrompt({
      provider: "anthropic",
      model: "claude-unreleased-9",
      prelude: null,
      base: "isolade",
    }).text;
    expect(prompt).toContain("You are running claude-unreleased-9 (model ID: claude-unreleased-9)");
  });

  it("puts the model id in the attribution trailer", () => {
    expect(claude()).toContain('--trailer "Assisted-by: Isolade:claude-opus-5"');
    expect(codex()).toContain('--trailer "Assisted-by: Isolade:gpt-5.6-sol"');
  });

  it("explains <system-reminder> to Claude only", () => {
    // Claude Code injects these no matter what prompt we set. Codex has no such
    // mechanism, so the guidance would describe something that never arrives.
    expect(claude()).toContain("<system-reminder> blocks");
    expect(codex()).not.toContain("<system-reminder>");
  });

  it("carries the apply_patch context rules on codex only", () => {
    // Codex's tool spec ships the grammar but not the guidance, and its patch
    // matcher takes the first loose match with no ambiguity check, so replacing
    // its prompt without these silently edits the wrong lines. Claude's Edit tool
    // states its own contract in a tool schema we never touch.
    expect(codex()).toContain("# Editing files");
    expect(codex()).toContain("three lines of unchanged context");
    expect(claude()).not.toContain("# Editing files");
  });

  it("appends the prelude last, under a heading, with explicit precedence", () => {
    const prompt = claude("Commit messages start with a verb.");
    const section = "# Project instructions\nCommit messages start with a verb.";
    expect(prompt).toContain(section);
    // The precedence sentence names the heading, so match the section itself
    // rather than the heading text, which also occurs inside that sentence.
    expect(prompt.indexOf("Where they conflict")).toBeLessThan(prompt.indexOf(section));
    // Last, so it wins on position as well as by the precedence sentence, and so
    // two chats in a profile share the longest possible cache prefix.
    expect(prompt.trimEnd().endsWith("Commit messages start with a verb.")).toBe(true);
  });

  it("omits the precedence sentence when there is no prelude", () => {
    // It would otherwise point at a section that does not exist.
    expect(claude(null)).not.toContain("Where they conflict");
    expect(claude("   ")).not.toContain("Where they conflict");
  });

  it("counterweights the granted freedom with a scope limit", () => {
    // "No permission needed" is not "do more than was asked", and a profile
    // prelude may well tell the agent to be aggressive about changing files.
    expect(claude()).toContain("Deliver the scope asked for");
  });

  it("warns that installed software does not survive the session", () => {
    expect(claude()).toContain("nothing you install survives this session");
  });

  describe("base", () => {
    const build = (prelude: string | null, base: PromptBase) =>
      buildSystemPrompt({ provider: "anthropic", model: "claude-opus-5", prelude, base });

    it('"isolade" replaces the CLI\'s prompt with ours', () => {
      const p = build(null, "isolade");
      expect(p.mode).toBe("replace");
      expect(p.text).toContain("You are a coding agent in Isolade");
    });

    it('"cli" keeps the CLI\'s prompt and layers the prelude on top', () => {
      expect(build("Only my rules.", "cli")).toEqual({
        text: "Only my rules.",
        mode: "append",
      });
    });

    it('"minimal" replaces the CLI\'s prompt with the prelude alone', () => {
      // Leading newline is the adjacency padding, see the block below.
      expect(build("Only my rules.", "minimal")).toEqual({
        text: "\nOnly my rules.",
        mode: "replace",
      });
    });

    it('"minimal" with no prelude asks for no prompt at all', () => {
      // An empty replace is meaningful rather than a no-op: `--system-prompt ""`
      // is what suppresses the CLI's own prompt without substituting anything.
      expect(build(null, "minimal")).toEqual({ text: "", mode: "replace" });
    });

    const codexBase = (prelude: string | null, base: PromptBase) =>
      buildSystemPrompt({ provider: "openai", model: "gpt-5.6-sol", prelude, base });

    it('on codex, "none" replaces the prompt but keeps the patch rules', () => {
      // Which is what makes the option usable there rather than a file shredder.
      const p = codexBase("Only my rules.", "minimal");
      expect(p.mode).toBe("replace");
      expect(p.text).toContain("# Editing files");
      expect(p.text).toContain("Only my rules.");
      expect(p.text).not.toContain("You are a coding agent in Isolade");
    });

    it('on codex, "cli" adds nothing but the prelude', () => {
      // The one option that leaves codex's own prompt, and therefore its own patch
      // guidance, in place — so ours would be redundant.
      expect(codexBase("Only my rules.", "cli")).toEqual({
        text: "Only my rules.",
        mode: "append",
      });
    });

    it('on codex, "isolade" replaces the prompt rather than stacking on it', () => {
      // Layering would hand codex chats the largest prompt of any option: ours on
      // top of their 7-24KB, which is the opposite of the point.
      const p = codexBase(null, "isolade");
      expect(p.mode).toBe("replace");
      expect(p.text).toContain("You are a coding agent in Isolade");
      expect(p.text).toContain("# Editing files");
    });
  });

  describe("adjacency with harness text", () => {
    // Neither provider inserts a separator, so our text has to bring its own.
    it("leads with a newline when replacing Claude's prompt", () => {
      // The SDK identity block sits immediately before ours and concatenates:
      // "...Claude Agent SDK." + "You are a coding agent...". Claude Code's own
      // prompt opens with a bare newline for the same reason.
      for (const base of ["isolade", "minimal"] as PromptBase[]) {
        const text = buildSystemPrompt({
          provider: "anthropic",
          model: "claude-opus-5",
          prelude: "Mine.",
          base,
        }).text;
        expect(text.startsWith("\n")).toBe(true);
        expect(text.startsWith("\n\n")).toBe(false);
      }
    });

    it("adds no padding where the harness already separates", () => {
      // Claude appending: the CLI joins with a blank line itself. Codex either way:
      // it gives each section its own content part rather than one concatenated
      // blob, and does not pad between its own sections either.
      expect(
        buildSystemPrompt({
          provider: "anthropic",
          model: "claude-opus-5",
          prelude: "Mine.",
          base: "cli",
        }).text,
      ).toBe("Mine.");
      for (const base of ["cli", "minimal", "isolade"] as PromptBase[]) {
        const text = buildSystemPrompt({
          provider: "openai",
          model: "gpt-5.6-sol",
          prelude: "Mine.",
          base,
        }).text;
        expect(text.startsWith("\n")).toBe(false);
        expect(text.endsWith("\n")).toBe(false);
      }
    });

    it("leaves an empty prompt empty, since that is a flag rather than content", () => {
      // `--system-prompt ""` is how "no prompt" is expressed; a lone newline
      // would turn it into a content block saying nothing.
      expect(
        buildSystemPrompt({
          provider: "anthropic",
          model: "claude-opus-5",
          prelude: null,
          base: "minimal",
        }).text,
      ).toBe("");
    });
  });

  it("states the sandbox posture both ways round", () => {
    // The two facts the model cannot get anywhere else: nothing will stop it,
    // and the VM boundary is not the credential boundary. Matched against
    // whitespace-collapsed text so hard-wrapping the prompt stays free.
    const prompt = claude().replace(/\s+/g, " ");
    expect(prompt).toContain("no call is denied");
    expect(prompt).toContain("ask first before pushing");
  });
});
