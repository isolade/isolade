import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitConfigStore, type GitIdentity, type SigningConfig } from "../src/git-config-store";

function tempStore(): { store: GitConfigStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "gc-gitcfg-"));
  const file = join(dir, "config.toml");
  return { store: new GitConfigStore(file), file };
}

const identity: GitIdentity = { name: "Agent Bot", email: "agent@example.com" };
const signing: SigningConfig = {
  enabled: true,
  socketPath: "/tmp/agent.sock",
  signingKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA agent@isolade",
};

describe("GitConfigStore", () => {
  it("reads empty (not null) before anything is written", () => {
    const { store } = tempStore();
    expect(store.read()).toEqual({ identity: null, signing: null });
    expect(store.isSigningEnabled()).toBe(false);
  });

  it("reads empty when config.toml has no [git] table", () => {
    const { store, file } = tempStore();
    writeFileSync(file, 'name = "demo"\n');
    expect(store.read()).toEqual({ identity: null, signing: null });
  });

  it("sets identity and signing independently", () => {
    const { store } = tempStore();
    store.setIdentity(identity);
    expect(store.read()).toEqual({ identity, signing: null });
    store.setSigning(signing);
    expect(store.read()).toEqual({ identity, signing });
    expect(store.isSigningEnabled()).toBe(true);
    // changing one preserves the other
    store.setIdentity({ name: "X", email: "x@y.z" });
    expect(store.read().signing).toEqual(signing);
  });

  it("clearing signing keeps identity (and vice versa)", () => {
    const { store } = tempStore();
    store.setIdentity(identity);
    store.setSigning(signing);
    store.setSigning(null);
    expect(store.read()).toEqual({ identity, signing: null });
  });

  it("persists to config.toml's flat [git] table", () => {
    const { store, file } = tempStore();
    store.setIdentity(identity);
    store.setSigning(signing);
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("[git]");
    expect(text).toContain('name = "Agent Bot"');
    expect(text).toContain('email = "agent@example.com"');
    expect(text).toContain("signing_enabled = true");
    expect(text).toContain('signing_socket = "/tmp/agent.sock"');
    expect(text).toContain("signing_key =");
  });

  it("preserves the rest of config.toml when writing [git]", () => {
    const { store, file } = tempStore();
    writeFileSync(file, ["# header comment", 'name = "demo"', ""].join("\n"));
    store.setIdentity(identity);
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("# header comment");
    expect(text).toContain('name = "demo"');
    expect(text).toContain("[git]");
  });

  it("treats a corrupt or partial config as empty rather than throwing", () => {
    const { store, file } = tempStore();
    writeFileSync(file, "not = = toml");
    expect(store.read()).toEqual({ identity: null, signing: null });
    // signing socket present but key missing → signing half reads as unconfigured
    writeFileSync(file, '[git]\nsigning_enabled = true\nsigning_socket = "/s"\n');
    expect(store.read()).toEqual({ identity: null, signing: null });
  });

  it("rejects an invalid identity / signing at write time", () => {
    const { store } = tempStore();
    // Empty strings are valid at the type level but fail the schema's min(1).
    expect(() => store.setIdentity({ name: "x", email: "" })).toThrow();
    expect(() => store.setSigning({ enabled: true, socketPath: "/s", signingKey: "" })).toThrow();
  });

  it("clear() forgets everything and is idempotent", () => {
    const { store } = tempStore();
    store.setIdentity(identity);
    store.clear();
    expect(store.read()).toEqual({ identity: null, signing: null });
    expect(() => store.clear()).not.toThrow();
  });
});
