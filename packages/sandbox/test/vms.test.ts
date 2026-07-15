import { describe, expect, it } from "bun:test";
import { ESSENTIAL_NETWORK_DOMAINS, type NetworkConfig } from "@isolade/shared";
import { buildNetworkPolicy, getVmMemoryMib, isInsecureRegistryRef } from "../src/vms";

// Compact view of a rule for assertions: "<action> <direction> <destination>".
const ruleSig = (r: {
  action: string;
  direction: string;
  destination: {
    kind: string;
    group?: string;
    suffix?: string;
    domain?: string;
    cidr?: string;
  };
}) => {
  const d = r.destination;
  const dest =
    d.kind === "group"
      ? `group:${d.group}`
      : d.kind === "domainSuffix"
        ? `suffix:${d.suffix}`
        : d.kind === "domain"
          ? `domain:${d.domain}`
          : d.kind;
  return `${r.action} ${r.direction} ${dest}`;
};
const sigs = (p: { rules: readonly any[] }) => p.rules.map(ruleSig);

const cfg = (over: Partial<NetworkConfig> = {}): NetworkConfig => ({
  internet: "open",
  allowedDomains: [],
  allowLocalNetwork: false,
  allowHost: false,
  ports: [],
  hostPorts: [],
  ...over,
});

describe("network helper functions", () => {
  it("detects insecure local registry refs", () => {
    expect(isInsecureRegistryRef("localhost:5000/isolade/image:latest")).toBe(true);
    expect(isInsecureRegistryRef("127.0.0.1:5000/isolade/image:latest")).toBe(true);
    expect(isInsecureRegistryRef("ghcr.io/isolade/image:latest")).toBe(false);
    expect(isInsecureRegistryRef("alpine:latest")).toBe(false);
  });

  it("treats bridge-IP refs as insecure when SANDBOX_HOST is set", () => {
    const original = process.env.SANDBOX_HOST;
    process.env.SANDBOX_HOST = "192.168.64.1";
    try {
      // detectHostIp caches its first answer for the process, so require()-reload
      // gives us a fresh module so SANDBOX_HOST is honoured. The registry's
      // bound port is set per-test rather than read from env now.
      delete require.cache[require.resolve("../src/host-network")];
      delete require.cache[require.resolve("../src/vms")];
      const hostNetwork = require("../src/host-network");
      hostNetwork.setBoundRegistryPort(5001);
      const { isInsecureRegistryRef: fresh } = require("../src/vms");
      expect(fresh("192.168.64.1:5001/isolade/image:latest")).toBe(true);
      expect(fresh("192.168.64.1:5002/isolade/image:latest")).toBe(false);
    } finally {
      if (original === undefined) delete process.env.SANDBOX_HOST;
      else process.env.SANDBOX_HOST = original;
      delete require.cache[require.resolve("../src/host-network")];
      delete require.cache[require.resolve("../src/vms")];
    }
  });
});

describe("VM sizing", () => {
  it("uses three quarters of host memory", () => {
    expect(getVmMemoryMib(65536)).toBe(49152);
    expect(getVmMemoryMib(16384)).toBe(12288);
  });

  it("keeps a positive memory size for tiny host values", () => {
    expect(getVmMemoryMib(1)).toBe(1);
    expect(getVmMemoryMib(2)).toBe(1);
  });
});

describe("buildNetworkPolicy", () => {
  const essentials = ESSENTIAL_NETWORK_DOMAINS.map((d) => `allow egress suffix:${d}`);

  it("defaults (undefined config) to the historical open posture", () => {
    const p = buildNetworkPolicy([]);
    expect(p.defaultEgress).toBe("allow");
    expect(p.defaultIngress).toBe("allow");
    expect(sigs(p)).toEqual([
      "allow egress group:host", // DNS rule (allowDns targets the host group)
      "deny egress group:private",
      "deny egress group:host",
      "deny egress group:loopback",
      "deny egress group:link-local",
      "deny egress group:metadata",
      "deny egress group:multicast",
    ]);
  });

  it("open + explicit config matches the undefined default", () => {
    expect(sigs(buildNetworkPolicy([], cfg()))).toEqual(sigs(buildNetworkPolicy([])));
  });

  it("open mode drops the private/host denies when those zones are enabled", () => {
    const p = buildNetworkPolicy([], cfg({ allowLocalNetwork: true, allowHost: true }));
    expect(p.defaultEgress).toBe("allow");
    expect(sigs(p)).not.toContain("deny egress group:private");
    expect(sigs(p)).not.toContain("deny egress group:host");
    // footguns are still denied under default-allow
    expect(sigs(p)).toContain("deny egress group:metadata");
  });

  it("allowlist mode denies by default and allows essentials + user domains", () => {
    const p = buildNetworkPolicy(
      [],
      cfg({ internet: "allowlist", allowedDomains: ["github.com"] }),
    );
    expect(p.defaultEgress).toBe("deny");
    expect(sigs(p)).toEqual([
      "allow egress group:host", // DNS
      ...essentials,
      "allow egress domain:github.com", // exact host by default
    ]);
    // No explicit footgun denies needed, since default-deny covers them.
    expect(sigs(p)).not.toContain("deny egress group:metadata");
  });

  it("treats a *. user entry as a subdomain suffix, bare entries as exact", () => {
    const p = buildNetworkPolicy(
      [],
      cfg({
        internet: "allowlist",
        allowedDomains: ["*.github.com", "pypi.org"],
      }),
    );
    expect(sigs(p)).toContain("allow egress suffix:github.com"); // *. stripped → suffix
    expect(sigs(p)).toContain("allow egress domain:pypi.org"); // bare → exact
  });

  it("allowlist composes independently with local-network + host toggles", () => {
    const p = buildNetworkPolicy(
      [],
      cfg({ internet: "allowlist", allowLocalNetwork: true, allowHost: true }),
    );
    expect(p.defaultEgress).toBe("deny");
    expect(sigs(p)).toContain("allow egress group:private");
    expect(sigs(p)).toContain("allow egress group:host");
  });

  it("host-port allows come first so a denied host group can't shadow them", () => {
    const p = buildNetworkPolicy([5432], cfg({ internet: "allowlist" }));
    const hostRule = p.rules[0]!;
    expect(hostRule.action).toBe("allow");
    expect(hostRule.ports).toEqual([{ start: 5432, end: 5432 }]);
  });
});
