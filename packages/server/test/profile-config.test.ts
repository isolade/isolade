import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSEMBLED_LAYER_STAGE,
  ASSEMBLED_USER_STAGE,
  loadProfileConfig,
  parseGitRemoteUrl,
  profileConfigPath,
  profileDir,
  requirePreparedProfileSource,
  writeSecretDeclarations,
} from "../src/profile-config";
import { cacheDir } from "../src/xdg";

// A profile's config.toml lives at configDir()/profiles/<id>/config.toml, and
// loadProfileConfig keys on the profile id, so these tests isolate the XDG
// dirs and lay a profile down on disk.
const PROFILE = "demo";

function withProfile(
  run: (ctx: { configBody: (body: string) => void; repoDir: string; cacheRoot: string }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "isolade-envcfg-"));
  const prev = {
    c: process.env.XDG_CONFIG_HOME,
    k: process.env.XDG_CACHE_HOME,
  };
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  try {
    const pdir = profileDir(PROFILE);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "Dockerfile"), "FROM busybox\n");
    const repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, ".git"), "gitdir: /tmp/fake\n");
    run({
      configBody: (body) => writeFileSync(profileConfigPath(PROFILE), body),
      repoDir,
      cacheRoot: cacheDir(),
    });
  } finally {
    if (prev.c === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.c;
    if (prev.k === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev.k;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("parseGitRemoteUrl", () => {
  it("normalizes github.com repository URLs", () => {
    expect(parseGitRemoteUrl("https://github.com/acme/widget")).toEqual({
      url: "https://github.com/acme/widget.git",
    });
    expect(parseGitRemoteUrl("github.com/acme/widget.git")).toEqual({
      url: "https://github.com/acme/widget.git",
    });
    expect(parseGitRemoteUrl("https://example.com/acme/widget")).toBeNull();
  });

  it("rejects /tree/<branch> paths; parses file:// remotes", () => {
    expect(parseGitRemoteUrl("https://github.com/acme/widget/tree/main")).toBeNull();
    expect(parseGitRemoteUrl("file:///Users/me/repo")).toEqual({
      url: "file:///Users/me/repo",
    });
    expect(parseGitRemoteUrl("file:///")).toBeNull();
  });
});

describe("loadProfileConfig (per profile)", () => {
  it("resolves a local repo + dockerfile, keyed on the profile", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(
        [
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "demo"',
          `source = "${repoDir}"`,
          "",
          "[network]",
          "ports = [3000, 5173]",
          "",
        ].join("\n"),
      );
      const config = loadProfileConfig(PROFILE);
      expect(config.profileId).toBe(PROFILE);
      expect(config.repos[0]).toEqual({
        name: "demo",
        source: { kind: "local", path: repoDir },
        sourcePath: repoDir,
      });
      expect(config.build.dockerfilePath).toBe(join(profileDir(PROFILE), "Dockerfile"));
      expect(config.ports).toEqual([3000, 5173]);
    });
  });

  it("rejects repo names that collide with reserved buildkit contexts/stages", () => {
    withProfile(({ configBody, repoDir }) => {
      for (const reserved of [
        "context",
        "dockerfile",
        ASSEMBLED_USER_STAGE,
        ASSEMBLED_LAYER_STAGE,
      ]) {
        configBody(
          [
            "[build]",
            'dockerfile = "./Dockerfile"',
            "",
            "[[repos]]",
            `name = "${reserved}"`,
            `source = "${repoDir}"`,
            "",
          ].join("\n"),
        );
        expect(() => loadProfileConfig(PROFILE)).toThrow(/reserved/);
      }
    });
  });

  it("rejects a config with no build definition (identity-only)", () => {
    withProfile(({ configBody }) => {
      configBody('name = "demo"\n');
      expect(() => loadProfileConfig(PROFILE)).toThrow(/build definition/);
    });
  });

  it("accepts and ignores the identity tables (name / [git] / [network])", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(
        [
          'name = "demo profile"',
          "",
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "demo"',
          `source = "${repoDir}"`,
          "",
          "[git]",
          'name = "Agent Bot"',
          'email = "agent@example.com"',
          "",
          "[network]",
          'internet = "allowlist"',
          "",
        ].join("\n"),
      );
      // The build path loads fine; the identity tables are simply not surfaced.
      expect(loadProfileConfig(PROFILE).repos[0]?.name).toBe("demo");
    });
  });

  it("builds a Dockerfile-only profile (no [[repos]])", () => {
    withProfile(({ configBody }) => {
      configBody(["[build]", 'dockerfile = "./Dockerfile"', ""].join("\n"));
      const config = loadProfileConfig(PROFILE);
      expect(config.repos).toEqual([]);
      expect(config.build.dockerfilePath.endsWith("/Dockerfile")).toBe(true);
    });
  });

  it("resolves git repos to per-profile checkout dirs and rejects dup names", () => {
    withProfile(({ configBody, cacheRoot }) => {
      configBody(
        [
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "app"',
          'source = "https://github.com/acme/app"',
          "",
          "[[repos]]",
          'name = "docs"',
          'source = "https://github.com/acme/docs"',
          "",
        ].join("\n"),
      );
      const config = loadProfileConfig(PROFILE);
      const checkoutRoot = join(cacheRoot, "checkouts", PROFILE);
      for (const repo of config.repos) {
        expect(repo.sourcePath.startsWith(join(checkoutRoot, `${repo.name}-`))).toBe(true);
      }
      expect(new Set(config.repos.map((r) => r.sourcePath)).size).toBe(2);
    });
  });

  it("resolves cache mounts to a slugged host path under the profile's cache dir", () => {
    withProfile(({ configBody, repoDir, cacheRoot }) => {
      configBody(
        [
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "demo"',
          `source = "${repoDir}"`,
          "",
          "[runtime]",
          'caches = ["~/.cache/ccache", "$HOME/.cargo/registry"]',
          "",
        ].join("\n"),
      );
      const config = loadProfileConfig(PROFILE);
      const root = join(cacheRoot, "caches", PROFILE);
      expect(config.caches).toEqual([
        {
          guestPath: "~/.cache/ccache",
          hostPath: join(root, ".cache__ccache"),
        },
        {
          guestPath: "$HOME/.cargo/registry",
          hostPath: join(root, ".cargo__registry"),
        },
      ]);
    });
  });

  it("parses secret declarations and rejects misconfigurations", () => {
    withProfile(({ configBody, repoDir }) => {
      const base = [
        "[build]",
        'dockerfile = "./Dockerfile"',
        "",
        "[[repos]]",
        'name = "demo"',
        `source = "${repoDir}"`,
        "",
      ];
      configBody(
        [...base, "[[secrets]]", 'env = "GH_TOKEN"', 'hosts = ["github.com", "*.github.com"]'].join(
          "\n",
        ),
      );
      // inject defaults to "headers" when omitted.
      expect(loadProfileConfig(PROFILE).secrets).toEqual([
        {
          env: "GH_TOKEN",
          hosts: ["github.com", "*.github.com"],
          inject: "headers",
        },
      ]);

      // inject = "full" widens substitution past headers.
      configBody(
        [
          ...base,
          "[[secrets]]",
          'env = "API_KEY"',
          'hosts = ["api.example.com"]',
          'inject = "full"',
        ].join("\n"),
      );
      expect(loadProfileConfig(PROFILE).secrets).toEqual([
        { env: "API_KEY", hosts: ["api.example.com"], inject: "full" },
      ]);

      // inject = "env" puts the value in the VM and takes no hosts.
      configBody([...base, "[[secrets]]", 'env = "LOCAL_KEY"', 'inject = "env"'].join("\n"));
      expect(loadProfileConfig(PROFILE).secrets).toEqual([
        { env: "LOCAL_KEY", hosts: [], inject: "env" },
      ]);

      // A proxy-mode secret with no hosts is rejected.
      configBody([...base, "[[secrets]]", 'env = "X"', "hosts = []"].join("\n"));
      expect(() => loadProfileConfig(PROFILE)).toThrow();

      // An env-mode secret with hosts is rejected (hosts don't apply).
      configBody(
        [...base, "[[secrets]]", 'env = "Y"', 'hosts = ["a.com"]', 'inject = "env"'].join("\n"),
      );
      expect(() => loadProfileConfig(PROFILE)).toThrow();
    });
  });

  it("defaults [setup]/[start] to empty phases when neither is declared", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(
        [
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "demo"',
          `source = "${repoDir}"`,
          "",
        ].join("\n"),
      );
      expect(loadProfileConfig(PROFILE).init).toEqual({
        setup: { sync: [], async: [] },
        start: { sync: [], async: [] },
      });
    });
  });

  it("parses [runtime] setup/start sync/async lifecycle commands", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(
        [
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "demo"',
          `source = "${repoDir}"`,
          "",
          "[runtime.setup]",
          'sync = ["pnpm install"]',
          'async = ["./warm.sh"]',
          "",
          "[runtime.start]",
          'sync = ["./start-db.sh"]',
          "",
        ].join("\n"),
      );
      expect(loadProfileConfig(PROFILE).init).toEqual({
        setup: { sync: ["pnpm install"], async: ["./warm.sh"] },
        start: { sync: ["./start-db.sh"], async: [] },
      });
    });
  });

  it("rejects unknown keys inside a lifecycle phase", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(
        [
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "demo"',
          `source = "${repoDir}"`,
          "",
          "[runtime.setup]",
          'onCreate = ["x"]',
          "",
        ].join("\n"),
      );
      expect(() => loadProfileConfig(PROFILE)).toThrow();
    });
  });

  it("requires git checkouts to be prepared", () => {
    withProfile(({ configBody }) => {
      configBody(
        [
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "app"',
          'source = "https://github.com/acme/widget"',
          "",
        ].join("\n"),
      );
      expect(() => requirePreparedProfileSource(PROFILE)).toThrow("git checkout is missing");
    });
  });

  it("rejects non-HOME cache paths", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(
        [
          "[build]",
          'dockerfile = "./Dockerfile"',
          "",
          "[[repos]]",
          'name = "demo"',
          `source = "${repoDir}"`,
          "",
          "[runtime]",
          'caches = ["/var/cache/ccache"]',
          "",
        ].join("\n"),
      );
      expect(() => loadProfileConfig(PROFILE)).toThrow("cache paths must start with");
    });
  });
});

describe("writeSecretDeclarations (per profile)", () => {
  const base = (repoDir: string) =>
    [
      "# my profile",
      'name = "demo"',
      "",
      "[build]",
      'dockerfile = "./Dockerfile"',
      "",
      "[[repos]]",
      "# the app repo",
      'name = "demo"',
      `source = "${repoDir}"`,
      "",
    ].join("\n");

  it("adds declarations, preserving other content", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(base(repoDir));
      writeSecretDeclarations(PROFILE, [
        { env: "GH_TOKEN", hosts: ["github.com"], inject: "headers" },
      ]);
      const text = readFileSync(profileConfigPath(PROFILE), "utf-8");
      expect(text).toContain("# my profile");
      expect(text).toContain("# the app repo");
      // "headers" is the default, so inject isn't written out.
      expect(text).not.toContain("inject");
      expect(loadProfileConfig(PROFILE).secrets).toEqual([
        { env: "GH_TOKEN", hosts: ["github.com"], inject: "headers" },
      ]);
    });
  });

  it("writes inject only for non-default modes, and round-trips it", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(base(repoDir));
      writeSecretDeclarations(PROFILE, [
        { env: "API_KEY", hosts: ["api.example.com"], inject: "full" },
      ]);
      const text = readFileSync(profileConfigPath(PROFILE), "utf-8");
      expect(text).toContain('inject = "full"');
      expect(loadProfileConfig(PROFILE).secrets).toEqual([
        { env: "API_KEY", hosts: ["api.example.com"], inject: "full" },
      ]);
      // Stable across a re-write.
      const once = readFileSync(profileConfigPath(PROFILE), "utf-8");
      writeSecretDeclarations(PROFILE, [
        { env: "API_KEY", hosts: ["api.example.com"], inject: "full" },
      ]);
      expect(readFileSync(profileConfigPath(PROFILE), "utf-8")).toBe(once);
    });
  });

  it("writes env-mode secrets without a hosts line, and round-trips them", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(base(repoDir));
      writeSecretDeclarations(PROFILE, [{ env: "LOCAL_KEY", hosts: [], inject: "env" }]);
      const text = readFileSync(profileConfigPath(PROFILE), "utf-8");
      expect(text).toContain('inject = "env"');
      expect(text).not.toContain("hosts");
      expect(loadProfileConfig(PROFILE).secrets).toEqual([
        { env: "LOCAL_KEY", hosts: [], inject: "env" },
      ]);
    });
  });

  it("replaces the set, removes when empty, and is stable across writes", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(
        [base(repoDir), "[[secrets]]", 'env = "OLD"', 'hosts = ["old.com"]', ""].join("\n"),
      );
      writeSecretDeclarations(PROFILE, [{ env: "A", hosts: ["a.com"], inject: "headers" }]);
      expect(loadProfileConfig(PROFILE).secrets).toEqual([
        { env: "A", hosts: ["a.com"], inject: "headers" },
      ]);
      const once = readFileSync(profileConfigPath(PROFILE), "utf-8");
      expect(once).not.toContain("OLD");
      writeSecretDeclarations(PROFILE, [{ env: "A", hosts: ["a.com"], inject: "headers" }]);
      expect(readFileSync(profileConfigPath(PROFILE), "utf-8")).toBe(once);
      writeSecretDeclarations(PROFILE, []);
      expect(loadProfileConfig(PROFILE).secrets).toEqual([]);
    });
  });

  it("rejects invalid input and leaves the file untouched", () => {
    withProfile(({ configBody, repoDir }) => {
      configBody(base(repoDir));
      const before = readFileSync(profileConfigPath(PROFILE), "utf-8");
      expect(() =>
        writeSecretDeclarations(PROFILE, [{ env: "bad name", hosts: ["x"], inject: "headers" }]),
      ).toThrow();
      expect(() =>
        writeSecretDeclarations(PROFILE, [{ env: "OK", hosts: [], inject: "headers" }]),
      ).toThrow();
      expect(() =>
        writeSecretDeclarations(PROFILE, [{ env: "OK", hosts: ["a.com"], inject: "env" }]),
      ).toThrow();
      expect(readFileSync(profileConfigPath(PROFILE), "utf-8")).toBe(before);
    });
  });
});
