import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db";
import { profileConfigPath, profileDir } from "../src/profile-config";
import { ProfileManager } from "../src/profiles";
import type { SandboxApi } from "../src/sandbox-client";

// reconcile() with skipBootSandboxWork never touches the sandbox, so a bare stub
// is enough for these unit tests (none exercise the build/codex paths).
const sandbox = {} as unknown as SandboxApi;
const newManager = (db: ReturnType<typeof createDb>) =>
  new ProfileManager(db, sandbox, { skipBootSandboxWork: true });

function isolateXdg() {
  const root = mkdtempSync(join(tmpdir(), "isolade-profiles-"));
  const prev = { c: process.env.XDG_CONFIG_HOME, d: process.env.XDG_DATA_HOME };
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  return () => {
    if (prev.c === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.c;
    if (prev.d === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev.d;
    rmSync(root, { recursive: true, force: true });
  };
}

describe("ProfileManager", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = isolateXdg();
  });
  afterEach(() => restore());

  it("isolates per-profile auth / git stores by profile id", () => {
    const pm = newManager(createDb(":memory:"));
    const a = pm.create("Work");
    const b = pm.create("Personal");

    expect(pm.auth(a.id).dir()).not.toBe(pm.auth(b.id).dir());
    pm.git(a.id).setIdentity({ name: "Ada", email: "ada@work.test" });
    expect(pm.git(a.id).status().identity?.email).toBe("ada@work.test");
    expect(pm.git(b.id).status().identity).toBeNull();
    pm.auth(a.id).write("claude", '{"claudeAiOauth":{}}');
    expect(pm.auth(a.id).has("claude")).toBe(true);
    expect(pm.auth(b.id).has("claude")).toBe(false);
  });

  it("a fresh profile has no config and pending build state", () => {
    const pm = newManager(createDb(":memory:"));
    const p = pm.create("Work");
    expect(p.hasConfig).toBe(false);
    expect(p.status).toBe("pending");
    expect(p.image).toBeNull();
    expect(p.configPath).toBe(profileConfigPath(p.id));
  });

  it("persists and reads back model overrides, dropping the table when empty", () => {
    const pm = newManager(createDb(":memory:"));
    const p = pm.create("Work");
    expect(pm.modelOverrides(p.id)).toEqual({});

    pm.setModelOverrides(p.id, {
      "gpt-5.5": { tier: "hidden" },
      "claude-opus-4-8": { tier: "more" },
    });
    expect(pm.modelOverrides(p.id)).toEqual({
      "gpt-5.5": { tier: "hidden" },
      "claude-opus-4-8": { tier: "more" },
    });

    pm.setModelOverrides(p.id, {});
    expect(pm.modelOverrides(p.id)).toEqual({});
  });

  it("stores the debug flag alongside appearance", () => {
    const pm = newManager(createDb(":memory:"));
    const p = pm.create("Work");
    pm.setAppearance(p.id, { theme: "dracula", debug: true });
    expect(pm.appearance(p.id).theme).toBe("dracula");
    expect(pm.appearance(p.id).debug).toBe(true);
  });

  it("ensureDefault creates a 'default' profile once", () => {
    const pm = newManager(createDb(":memory:"));
    expect(pm.ensureDefault().id).toBe("default");
    expect(pm.ensureDefault().id).toBe("default");
    expect(pm.list().filter((p) => p.id === "default")).toHaveLength(1);
  });

  it("clones the build definition + identity config, but not auth", () => {
    const pm = newManager(createDb(":memory:"));
    const src = pm.create("Source");
    // Give the source a buildable config.toml + identity + a stored credential.
    writeFileSync(
      profileConfigPath(src.id),
      [
        'name = "Source"',
        "",
        "[[repos]]",
        'name = "app"',
        'source = "file:///tmp/app"',
        "",
        "[build]",
        'dockerfile = "./Dockerfile"',
        "",
      ].join("\n"),
    );
    pm.setAppearance(src.id, { theme: "dracula" });
    pm.git(src.id).setIdentity({ name: "Ada", email: "ada@src.test" });
    pm.auth(src.id).write("claude", "{}");

    const clone = pm.clone(src.id, "Cloned");
    expect(clone.id).not.toBe(src.id);
    // Build definition + identity copied.
    expect(existsSync(profileConfigPath(clone.id))).toBe(true);
    expect(clone.hasConfig).toBe(true);
    expect(pm.appearance(clone.id).theme).toBe("dracula");
    expect(pm.git(clone.id).status().identity?.email).toBe("ada@src.test");
    // Unbuilt, and credentials NOT copied.
    expect(clone.status).toBe("pending");
    expect(clone.image).toBeNull();
    expect(pm.auth(clone.id).has("claude")).toBe(false);
  });

  it("rename and remove", () => {
    const pm = newManager(createDb(":memory:"));
    const p = pm.create("Old");
    expect(pm.rename(p.id, "New").name).toBe("New");
    expect(existsSync(profileDir(p.id))).toBe(true);
    pm.remove(p.id);
    expect(pm.get(p.id)).toBeUndefined();
    expect(existsSync(profileDir(p.id))).toBe(false);
  });
});
