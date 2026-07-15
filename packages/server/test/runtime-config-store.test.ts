import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_RUNTIME_CONFIG, type RuntimeConfig } from "../src/contracts";
import { RuntimeConfigStore } from "../src/runtime-config-store";

function tempStore(): { store: RuntimeConfigStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "gc-runtimecfg-"));
  const file = join(dir, "config.toml");
  return { store: new RuntimeConfigStore(file), file };
}

const read = (file: string) => readFileSync(file, "utf-8");

describe("RuntimeConfigStore", () => {
  it("reads the empty posture before anything is written", () => {
    const { store } = tempStore();
    expect(store.read()).toEqual(EMPTY_RUNTIME_CONFIG);
  });

  it("reads the empty posture when config.toml has no [runtime] table", () => {
    const { store, file } = tempStore();
    writeFileSync(file, 'name = "demo"\n');
    expect(store.read()).toEqual(EMPTY_RUNTIME_CONFIG);
  });

  it("round-trips caches and both lifecycle phases", () => {
    const { store, file } = tempStore();
    const cfg: RuntimeConfig = {
      caches: ["~/.cache/ccache"],
      setup: { sync: ["pnpm install"], async: ["./warm.sh"] },
      start: { sync: [], async: ["./dev.sh"] },
    };
    expect(store.write(cfg)).toEqual(cfg);
    expect(store.read()).toEqual(cfg);
    const text = read(file);
    expect(text).toContain("[runtime]");
    // setup/start render as inline sub-tables; an empty phase array is omitted.
    expect(text).toContain('caches = ["~/.cache/ccache"]');
    expect(text).toContain("setup = {");
    expect(text).not.toContain("sync = []");
  });

  it("drops the [runtime] table entirely when everything is empty", () => {
    const { store, file } = tempStore();
    writeFileSync(file, 'name = "demo"\n');
    store.write({
      caches: ["~/.cache/x"],
      setup: { sync: [], async: [] },
      start: { sync: [], async: [] },
    });
    expect(read(file)).toContain("[runtime]");
    store.write(EMPTY_RUNTIME_CONFIG);
    expect(read(file)).not.toContain("[runtime]");
    expect(read(file)).toContain('name = "demo"');
    expect(store.read()).toEqual(EMPTY_RUNTIME_CONFIG);
  });

  it("rejects a non-HOME cache path on write", () => {
    const { store } = tempStore();
    expect(() => store.write({ ...EMPTY_RUNTIME_CONFIG, caches: ["/var/cache"] })).toThrow();
  });

  it("preserves the rest of config.toml (build definition, comments)", () => {
    const { store, file } = tempStore();
    writeFileSync(
      file,
      ["# my profile", 'name = "demo"', "", "[build]", 'dockerfile = "./Dockerfile"', ""].join(
        "\n",
      ),
    );
    store.write({ ...EMPTY_RUNTIME_CONFIG, caches: ["~/.cache/ccache"] });
    const text = read(file);
    expect(text).toContain("# my profile");
    expect(text).toContain("[build]");
    expect(text).toContain("[runtime]");
  });

  it("treats a corrupt or invalid file as the empty posture rather than throwing", () => {
    const { store, file } = tempStore();
    writeFileSync(file, "not = = toml");
    expect(store.read()).toEqual(EMPTY_RUNTIME_CONFIG);
  });
});
