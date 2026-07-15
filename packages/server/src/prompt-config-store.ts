import { existsSync, readFileSync } from "node:fs";
import { type PromptConfig, promptConfigSchema } from "@isolade/shared";
import { writeConfigTable } from "./config-editor";
import { profileConfigSchema, promptTableSchema } from "./profile-config";

// Per-profile chat augmentation. Its one field, `prelude`, is prepended
// (invisibly) to the first user message of every new chat in the profile — the
// DB stores the original content; only the message sent to the chat backend is
// augmented (see ProfileManager.getPrelude / loadProfileConfig).
//
// It lives in the profile's config.toml as a `[prompt]` table, read/written
// through config-editor (comment-preserving, multi-line-string aware). An empty
// prelude drops the table rather than leaving `prelude = ""` behind.

type PromptTable = ReturnType<typeof promptTableSchema.parse>;

function tableToConfig(table: PromptTable): PromptConfig {
  return { prelude: table.prelude ?? "" };
}

export class PromptConfigStore {
  constructor(private configPath: string) {}

  /** Current config. Never throws: an absent / unreadable / corrupt file (or a
   * config without a `[prompt]` table) reads as an empty prelude. */
  read(): PromptConfig {
    if (!existsSync(this.configPath)) return { prelude: "" };
    try {
      const parsed = profileConfigSchema.parse(
        Bun.TOML.parse(readFileSync(this.configPath, "utf-8")) ?? {},
      );
      return parsed.prompt ? tableToConfig(parsed.prompt) : { prelude: "" };
    } catch {
      return { prelude: "" };
    }
  }

  /** Validate and persist the config, returning the parsed (normalized) value. */
  write(config: PromptConfig): PromptConfig {
    const parsed = promptConfigSchema.parse(config);
    // An empty prelude drops the whole `[prompt]` table.
    writeConfigTable(
      this.configPath,
      "prompt",
      parsed.prelude ? { prelude: parsed.prelude } : undefined,
    );
    return parsed;
  }
}
