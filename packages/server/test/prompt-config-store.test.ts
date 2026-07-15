import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptConfigStore } from "../src/prompt-config-store";

function tempStore(): { store: PromptConfigStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "gc-promptcfg-"));
  const file = join(dir, "config.toml");
  return { store: new PromptConfigStore(file), file };
}

const read = (file: string) => readFileSync(file, "utf-8");

describe("PromptConfigStore", () => {
  it("reads an empty prelude before anything is written", () => {
    const { store } = tempStore();
    expect(store.read()).toEqual({ prelude: "" });
  });

  it("round-trips a prelude in the [prompt] table", () => {
    const { store, file } = tempStore();
    const cfg = { prelude: "Always write tests." };
    expect(store.write(cfg)).toEqual(cfg);
    expect(store.read()).toEqual(cfg);
    expect(read(file)).toContain("[prompt]");
    expect(read(file)).toContain('prelude = "Always write tests."');
  });

  it("preserves a multi-line prelude as a real-newline literal block", () => {
    const { store, file } = tempStore();
    const prelude = 'Line 1\nLine 2 with "quotes"';
    store.write({ prelude });
    expect(store.read().prelude).toBe(prelude);
    expect(read(file)).not.toContain("\\n");
  });

  it("drops the [prompt] table when the prelude is emptied", () => {
    const { store, file } = tempStore();
    writeFileSync(file, 'name = "demo"\n');
    store.write({ prelude: "hi" });
    expect(read(file)).toContain("[prompt]");
    store.write({ prelude: "" });
    expect(read(file)).not.toContain("[prompt]");
    expect(read(file)).toContain('name = "demo"');
    expect(store.read()).toEqual({ prelude: "" });
  });

  it("treats a corrupt file as an empty prelude rather than throwing", () => {
    const { store, file } = tempStore();
    writeFileSync(file, "not = = toml");
    expect(store.read()).toEqual({ prelude: "" });
  });
});
