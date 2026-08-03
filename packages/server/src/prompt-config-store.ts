import { existsSync, readFileSync } from "node:fs";
import { type PromptConfig, promptConfigSchema } from "@isolade/shared";
import { writeConfigTable } from "./config-editor";
import { profileConfigSchema, promptTableSchema } from "./profile-config";

// Per-profile prompt settings: the `prelude` that always applies, and `base`,
// which picks what precedes it — Isolade's own brief, the agent CLI's stock
// prompt, or nothing (see buildSystemPrompt / ProfileManager.getPromptConfig).
//
// It lives in the profile's config.toml as a `[prompt]` table, read/written
// through config-editor (comment-preserving, multi-line-string aware). A table
// with nothing but defaults is dropped rather than left behind as empty keys.

type PromptTable = ReturnType<typeof promptTableSchema.parse>;

const EMPTY: PromptConfig = { prelude: "", base: "optimized" };

function tableToConfig(table: PromptTable): PromptConfig {
  return { prelude: table.prelude ?? "", base: table.base ?? "optimized" };
}

export class PromptConfigStore {
  constructor(private configPath: string) {}

  /** Current config. Never throws: an absent / unreadable / corrupt file (or a
   * config without a `[prompt]` table) reads as an empty prelude. */
  read(): PromptConfig {
    if (!existsSync(this.configPath)) return EMPTY;
    try {
      const parsed = profileConfigSchema.parse(
        Bun.TOML.parse(readFileSync(this.configPath, "utf-8")) ?? {},
      );
      return parsed.prompt ? tableToConfig(parsed.prompt) : EMPTY;
    } catch {
      return EMPTY;
    }
  }

  /** Validate and persist the config, returning the parsed (normalized) value. */
  write(config: PromptConfig): PromptConfig {
    const parsed = promptConfigSchema.parse(config);
    // Only non-default values are written, so an untouched profile keeps a clean
    // config.toml and the whole `[prompt]` table disappears rather than sitting
    // there restating the defaults.
    const nonDefaultBase = parsed.base !== "optimized";
    const table =
      parsed.prelude || nonDefaultBase
        ? {
            ...(parsed.prelude ? { prelude: parsed.prelude } : {}),
            ...(nonDefaultBase ? { base: parsed.base } : {}),
          }
        : undefined;
    writeConfigTable(this.configPath, "prompt", table);
    return parsed;
  }
}
