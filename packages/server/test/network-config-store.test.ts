import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkConfigSchema } from "../src/contracts";
import { NetworkConfigStore } from "../src/network-config-store";

function tempStore(): { store: NetworkConfigStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "gc-netcfg-"));
  const file = join(dir, "config.toml");
  return { store: new NetworkConfigStore(file), file };
}

// The open default posture, with empty allowlist and no forwarded/host ports.
const DEFAULT = networkConfigSchema.parse({});

describe("NetworkConfigStore", () => {
  it("reads the open default before anything is written", () => {
    const { store } = tempStore();
    expect(store.read()).toEqual(DEFAULT);
  });

  it("reads the default when config.toml has no [network] table", () => {
    const { store, file } = tempStore();
    writeFileSync(file, 'name = "demo"\n');
    expect(store.read()).toEqual(DEFAULT);
  });

  it("round-trips a written config", () => {
    const { store } = tempStore();
    const cfg = {
      internet: "allowlist" as const,
      allowedDomains: ["github.com", "pypi.org"],
      allowLocalNetwork: true,
      allowHost: false,
      ports: [] as number[],
      hostPorts: [] as number[],
    };
    expect(store.write(cfg)).toEqual(cfg);
    expect(store.read()).toEqual(cfg);
  });

  it("round-trips forwarded and host ports in the [network] table", () => {
    const { store, file } = tempStore();
    const cfg = { ...DEFAULT, ports: [5173, 3000], hostPorts: [5432] };
    expect(store.write(cfg)).toEqual(cfg);
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("ports = [5173, 3000]");
    expect(text).toContain("host_ports = [5432]");
    expect(store.read()).toEqual(cfg);
  });

  it("persists to config.toml's [network] table in snake_case", () => {
    const { store, file } = tempStore();
    store.write({ ...DEFAULT, internet: "allowlist", allowedDomains: ["github.com"] });
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("[network]");
    expect(text).toContain('internet = "allowlist"');
    expect(text).toContain('allowed_domains = ["github.com"]');
    expect(text).toContain("allow_local_network = false");
  });

  it("preserves the rest of config.toml (build definition, comments)", () => {
    const { store, file } = tempStore();
    writeFileSync(
      file,
      [
        "# my profile",
        'name = "demo"',
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
    store.write({ ...DEFAULT, allowHost: true });
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("# my profile");
    expect(text).toContain('name = "demo"');
    expect(text).toContain("[[repos]]");
    expect(text).toContain("[build]");
    expect(text).toContain("[network]");
    expect(store.read()).toEqual({ ...DEFAULT, allowHost: true });
  });

  it("edits [network] values in place, keeping inline comments on its keys", () => {
    const { store, file } = tempStore();
    writeFileSync(
      file,
      ["[network]", 'internet = "open" # egress posture', "allow_host = false", ""].join("\n"),
    );
    store.write({ ...DEFAULT, internet: "allowlist" });
    const text = readFileSync(file, "utf-8");
    expect(text).toContain('internet = "allowlist" # egress posture');
  });

  it("treats a corrupt or invalid file as the default rather than throwing", () => {
    const { store, file } = tempStore();
    writeFileSync(file, "not = = toml");
    expect(store.read()).toEqual(DEFAULT);
    writeFileSync(file, '[network]\ninternet = "nonsense"\n');
    expect(store.read()).toEqual(DEFAULT);
  });
});
