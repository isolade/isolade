import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../src/chat/system-prompt";
import type { PromptBase } from "../src/contracts";

const claude = (prelude: string | null = null, base: PromptBase = "optimized") =>
  buildSystemPrompt({ provider: "anthropic", model: "claude-opus-5", prelude, base }).text;
const codex = (prelude: string | null = null, base: PromptBase = "optimized") =>
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
      base: "optimized",
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
    expect(claude()).toContain("such as <system-reminder> comes from the harness");
    expect(codex()).not.toContain("<system-reminder>");
  });

  it("carries the apply_patch context rules on codex only", () => {
    // Codex's tool spec ships the grammar but not the guidance, and its patch
    // matcher takes the first loose match with no ambiguity check, so replacing
    // its prompt without these silently edits the wrong lines. Claude's Edit tool
    // states its own contract in a tool schema we never touch.
    expect(codex()).toContain("# Editing files");
    expect(codex()).toContain("three unchanged lines above and below");
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

  it("says the permission layer is off to Claude only", () => {
    // Codex injects a <permissions instructions> conversation item naming
    // sandbox_mode danger-full-access and approval_policy never, so repeating it
    // spends bytes telling codex something it has already read. Claude gets no
    // environment block at all once --system-prompt replaces the CLI's prompt, and
    // its Bash tool description still warns about permission prompts.
    expect(claude()).toContain("no call is denied");
    expect(codex()).not.toContain("no call is denied");
  });

  it("names the working tree to Claude only", () => {
    // Same split: codex reads cwd and workspace_roots out of <environment_context>.
    expect(claude()).toContain("working tree at /workspace");
    expect(codex()).not.toContain("working tree");
  });

  it("keeps the credential boundary on both, since neither harness states it", () => {
    for (const prompt of [claude(), codex()]) {
      expect(prompt.replace(/\s+/g, " ")).toContain("real credentials, so ask first");
    }
  });

  describe("base", () => {
    const build = (prelude: string | null, base: PromptBase) =>
      buildSystemPrompt({ provider: "anthropic", model: "claude-opus-5", prelude, base });

    it('"optimized" replaces the CLI\'s prompt with ours', () => {
      const p = build(null, "optimized");
      expect(p.mode).toBe("replace");
      expect(p.text).toContain("You are a coding agent in Isolade");
    });

    it('"unmodified" keeps the CLI\'s prompt and layers the prelude on top', () => {
      expect(build("Only my rules.", "unmodified")).toEqual({
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

    it('"extended" keeps the CLI\'s prompt and appends the corrections', () => {
      const p = build(null, "extended");
      expect(p.mode).toBe("append");
      expect(p.text).toContain("You are running in Isolade");
      expect(p.text).toContain("no call is denied");
      expect(p.text).toContain('--trailer "Assisted-by: Isolade:claude-opus-5"');
    });

    it('"extended" carries only what the vendor prompt gets wrong or omits', () => {
      // Every line below was checked against the shipped prompt and found already
      // covered, so repeating it would be paying twice. If a vendor drops one of
      // these, that is when the overlay should grow — not before.
      const p = build(null, "extended").text;
      for (const covered of [
        "Deliver the scope asked for",
        "Report what you observed",
        "Context is summarized automatically",
        "<system-reminder>",
        "working tree at",
      ]) {
        expect(p).not.toContain(covered);
      }
      // Claude's own prompt states its model id; codex's says only "based on GPT-5".
      expect(p).not.toContain("You are running Opus 5");
      expect(
        buildSystemPrompt({
          provider: "openai",
          model: "gpt-5.6-sol",
          prelude: null,
          base: "extended",
        }).text,
      ).toContain("You are running GPT-5.6 Sol (model ID: gpt-5.6-sol)");
    });

    it('"extended" leaves the sandbox correction to Claude and the patch rules to neither', () => {
      // Codex is told `approval_policy` never by its own <permissions instructions>,
      // and keeps its own patch guidance because we keep its prompt.
      const overlay = buildSystemPrompt({
        provider: "openai",
        model: "gpt-5.6-sol",
        prelude: null,
        base: "extended",
      }).text;
      expect(overlay).not.toContain("no call is denied");
      expect(overlay).not.toContain("# Editing files");
      // The credential boundary is the half that stays on both.
      expect(overlay.replace(/\s+/g, " ")).toContain("real credentials, so ask first");
    });

    it('"extended" still gives the prelude the last word', () => {
      const p = build("Commit messages start with a verb.", "extended").text;
      expect(p).toContain("Where they conflict");
      expect(p.trimEnd().endsWith("Commit messages start with a verb.")).toBe(true);
    });

    const codexBase = (prelude: string | null, base: PromptBase) =>
      buildSystemPrompt({ provider: "openai", model: "gpt-5.6-sol", prelude, base });

    it('on codex, "minimal" replaces the prompt but keeps the patch rules', () => {
      // Which is what makes the option usable there rather than a file shredder.
      const p = codexBase("Only my rules.", "minimal");
      expect(p.mode).toBe("replace");
      expect(p.text).toContain("# Editing files");
      expect(p.text).toContain("Only my rules.");
      expect(p.text).not.toContain("You are a coding agent in Isolade");
    });

    it('on codex, "minimal" still heads the prelude, since the patch rules precede it', () => {
      // A heading opens a section rather than closing one, so an unheaded prelude
      // after `# Editing files` reads as further advice about editing files. On
      // Claude, where the prelude IS the whole prompt, it stays bare.
      expect(codexBase("Only my rules.", "minimal").text).toContain(
        "# Project instructions\nOnly my rules.",
      );
      expect(build("Only my rules.", "minimal").text).toBe("\nOnly my rules.");
    });

    it('on codex, "unmodified" adds nothing but the prelude', () => {
      // The one option that leaves codex's own prompt, and therefore its own patch
      // guidance, in place — so ours would be redundant.
      expect(codexBase("Only my rules.", "unmodified")).toEqual({
        text: "Only my rules.",
        mode: "append",
      });
    });

    it('on codex, "optimized" replaces the prompt rather than stacking on it', () => {
      // Layering would hand codex chats the largest prompt of any option: ours on
      // top of their 7-24KB, which is the opposite of the point.
      const p = codexBase(null, "optimized");
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
      for (const base of ["optimized", "minimal"] as PromptBase[]) {
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
          base: "unmodified",
        }).text,
      ).toBe("Mine.");
      // Extended appends too, so it takes the CLI's own separator like unmodified.
      expect(
        buildSystemPrompt({
          provider: "anthropic",
          model: "claude-opus-5",
          prelude: "Mine.",
          base: "extended",
        }).text.startsWith("\n"),
      ).toBe(false);
      for (const base of ["unmodified", "extended", "minimal", "optimized"] as PromptBase[]) {
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
    expect(prompt).toContain("Pushing, opening or commenting on PRs");
  });

  it("puts the model-dependent blocks after the invariant ones", () => {
    // Cache-prefix ordering: the two blocks that interpolate the model id are the
    // only thing switching a chat's model changes, so they belong at the end. With
    // them early, a switch invalidates the cached prefix from that point on.
    const prompt = claude();
    for (const invariant of ["no call is denied", "Context is summarized", "Deliver the scope"]) {
      expect(prompt.indexOf(invariant)).toBeLessThan(prompt.indexOf("You are running Opus 5"));
    }
    expect(prompt.indexOf("You are running Opus 5")).toBeLessThan(prompt.indexOf("--trailer"));
  });
});
