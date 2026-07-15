import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileConfigForm } from "@isolade/shared";
import {
  readProfileConfigView,
  writeConfigBareKey,
  writeConfigNestedTables,
  writeConfigTable,
  writeDockerfile,
  writeProfileConfigForm,
} from "../src/config-editor";
import { profileConfigPath, profileDir, readProfileConfig } from "../src/profile-config";

const PROFILE = "demo";
let root: string;
let prevConfig: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "isolade-cfgedit-"));
  prevConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  mkdirSync(profileDir(PROFILE), { recursive: true });
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevConfig;
  rmSync(root, { recursive: true, force: true });
});

const readConfig = () => readFileSync(profileConfigPath(PROFILE), "utf-8");
const writeConfig = (body: string) => writeFileSync(profileConfigPath(PROFILE), body);

// A minimal valid build-definition form. Override fields per test. The form now
// owns only the image inputs: repos, the Dockerfile path, and skills. Ports,
// caches, lifecycle commands, and the prelude live in their own tables/stores.
const form = (over: Partial<ProfileConfigForm> = {}): ProfileConfigForm => ({
  repos: [{ name: "app", source: "https://github.com/acme/app" }],
  dockerfile: "./Dockerfile",
  skills: [],
  ...over,
});

describe("writeProfileConfigForm: fresh file", () => {
  it("serializes a form into a loadable config.toml", () => {
    writeProfileConfigForm(PROFILE, form({ skills: ["acme/skills"] }));
    const view = readProfileConfigView(PROFILE);
    expect(view.parseError).toBeNull();
    expect(view.form).toMatchObject({
      skills: ["acme/skills"],
      dockerfile: "./Dockerfile",
      repos: [{ name: "app", source: "https://github.com/acme/app" }],
    });
    // Skills live under [build] alongside the Dockerfile, not as a bare root key.
    const text = readConfig();
    expect(text).toContain("[build]");
    expect(text.indexOf("skills")).toBeGreaterThan(text.indexOf("[build]"));
  });

  it("omits empty optionals entirely", () => {
    writeProfileConfigForm(PROFILE, form());
    const text = readConfig();
    expect(text).not.toContain("skills");
    expect(text).not.toContain("[runtime]");
    expect(text).toContain("[build]");
    expect(text).toContain("[[repos]]");
  });

  it("serializes a Dockerfile-only form (no repos)", () => {
    writeProfileConfigForm(PROFILE, form({ repos: [] }));
    const text = readConfig();
    expect(text).toContain("[build]");
    expect(text).not.toContain("[[repos]]");
    const view = readProfileConfigView(PROFILE);
    expect(view.parseError).toBeNull();
    expect(view.hasConfig).toBe(true);
    expect(view.form!.repos).toEqual([]);
  });
});

describe("writeProfileConfigForm: comment-preserving round-trip", () => {
  const authored = [
    "# my profile, keep this comment",
    "",
    "[build]",
    'dockerfile = "./Dockerfile" # inline comment',
    "",
    "# the app repo",
    "[[repos]]",
    'name = "app"',
    'source = "https://github.com/acme/app"',
    "",
  ].join("\n");

  it("edits an existing value while keeping every comment", () => {
    writeConfig(authored);
    writeProfileConfigForm(PROFILE, form({ dockerfile: "./Dockerfile.dev" }));
    const text = readConfig();
    expect(text).toContain("# my profile, keep this comment");
    expect(text).toContain("# the app repo");
    expect(text).toContain('dockerfile = "./Dockerfile.dev" # inline comment');
  });

  it("adds and removes a skill (a [build] sub-key), keeping comments", () => {
    writeConfig(authored);
    writeProfileConfigForm(PROFILE, form({ skills: ["acme/skills"] }));
    let view = readProfileConfigView(PROFILE);
    expect(view.form!.skills).toEqual(["acme/skills"]);
    expect(readConfig()).toContain("# the app repo");
    expect(readConfig()).toContain('dockerfile = "./Dockerfile" # inline comment');

    writeProfileConfigForm(PROFILE, form({ skills: [] }));
    view = readProfileConfigView(PROFILE);
    expect(view.form!.skills).toEqual([]);
    expect(readConfig()).not.toContain("skills");
    expect(readConfig()).toContain("# my profile, keep this comment");
  });

  it("adds and removes repos", () => {
    writeConfig(authored);
    writeProfileConfigForm(
      PROFILE,
      form({
        repos: [
          { name: "app", source: "https://github.com/acme/app" },
          { name: "docs", source: "https://github.com/acme/docs", branch: "main" },
        ],
      }),
    );
    let view = readProfileConfigView(PROFILE);
    expect(view.form!.repos.map((r) => r.name)).toEqual(["app", "docs"]);
    expect(view.form!.repos[1]!.branch).toBe("main");

    writeProfileConfigForm(
      PROFILE,
      form({ repos: [{ name: "docs", source: "https://github.com/acme/docs" }] }),
    );
    view = readProfileConfigView(PROFILE);
    expect(view.form!.repos.map((r) => r.name)).toEqual(["docs"]);
  });

  it("removes all [[repos]] for a Dockerfile-only profile, keeping comments", () => {
    writeConfig(authored);
    writeProfileConfigForm(PROFILE, form({ repos: [] }));
    const text = readConfig();
    expect(text).not.toContain("[[repos]]");
    expect(text).toContain("# my profile, keep this comment");
    const view = readProfileConfigView(PROFILE);
    expect(view.hasConfig).toBe(true); // still buildable: it has a [build]
    expect(view.form!.repos).toEqual([]);
  });

  it("leaves existing [[secrets]] untouched", () => {
    writeConfig(
      [authored, "[[secrets]]", 'env = "GH_TOKEN"', 'hosts = ["github.com"]', ""].join("\n"),
    );
    writeProfileConfigForm(PROFILE, form({ skills: ["acme/skills"] }));
    const text = readConfig();
    expect(text).toContain('env = "GH_TOKEN"');
    expect(text).toContain('hosts = ["github.com"]');
  });

  it("leaves the profile's identity tables (name, [git]) untouched", () => {
    // The build-definition form owns only [build] + [[repos]]; the identity
    // tables belong to other writers and must survive a form save byte-for-byte.
    writeConfig(
      [
        'name = "demo"',
        authored,
        "[git]",
        'name = "Agent Bot"',
        'email = "agent@example.com" # committer',
        "",
      ].join("\n"),
    );
    writeProfileConfigForm(PROFILE, form({ dockerfile: "./Dockerfile.dev" }));
    const text = readConfig();
    expect(text).toContain('name = "demo"');
    expect(text).toContain("[git]");
    expect(text).toContain('email = "agent@example.com" # committer');
    expect(text).toContain('dockerfile = "./Dockerfile.dev"');
  });

  it("leaves the runtime/prompt/network tables untouched", () => {
    // These tables are owned by their own stores; a build-definition save must
    // not disturb them.
    writeConfig(
      [
        authored,
        "[network]",
        'internet = "allowlist"',
        "ports = [5173]",
        "",
        "[runtime]",
        'caches = ["~/.cache/ccache"]',
        'setup = { sync = ["pnpm i"] }',
        "",
        "[prompt]",
        'prelude = "hello"',
        "",
      ].join("\n"),
    );
    writeProfileConfigForm(PROFILE, form({ skills: ["acme/skills"] }));
    const text = readConfig();
    expect(text).toContain("ports = [5173]");
    expect(text).toContain('caches = ["~/.cache/ccache"]');
    expect(text).toContain('prelude = "hello"');
  });

  it("is stable across an identical re-write", () => {
    writeConfig(authored);
    writeProfileConfigForm(PROFILE, form({ skills: ["acme/skills"] }));
    const once = readConfig();
    writeProfileConfigForm(PROFILE, form({ skills: ["acme/skills"] }));
    expect(readConfig()).toBe(once);
  });

  it("leaves repos alone when only their hand-authored key order differs", () => {
    // sameness must be order-insensitive, or every unrelated save re-renders
    // the repos region and deletes repo-internal comments.
    writeConfig(
      [
        "[build]",
        'dockerfile = "./Dockerfile"',
        "",
        "[[repos]]",
        'source = "https://github.com/acme/app"',
        "# pinned until v2 ships",
        'branch = "release-1.x"',
        'name = "app"',
        "",
      ].join("\n"),
    );
    const repos = readProfileConfigView(PROFILE).form!.repos;
    writeProfileConfigForm(PROFILE, form({ skills: ["acme/skills"], repos }));
    const text = readConfig();
    expect(text).toContain("# pinned until v2 ships");
    expect(text).toContain('source = "https://github.com/acme/app"\n# pinned');
  });

  it("edits repos interleaved with other tables without clobbering them", () => {
    // TOML allows [[repos]] entries to straddle other tables, so dropping the
    // second repo must not take the [build] between them with it.
    writeConfig(
      [
        "[[repos]]",
        'name = "app"',
        'source = "https://github.com/acme/app"',
        "",
        "[build]",
        'dockerfile = "./Dockerfile"',
        "",
        "[[repos]]",
        'name = "docs"',
        'source = "https://github.com/acme/docs"',
        "",
      ].join("\n"),
    );
    const view = readProfileConfigView(PROFILE);
    writeProfileConfigForm(PROFILE, form({ repos: [view.form!.repos[0]!] }));
    const next = readProfileConfigView(PROFILE);
    expect(next.form!.repos.map((r) => r.name)).toEqual(["app"]);
    expect(next.form!.dockerfile).toBe("./Dockerfile");
  });
});

describe("writeProfileConfigForm: validation", () => {
  it("rejects a reserved repo name (server schema is authoritative)", () => {
    expect(() =>
      writeProfileConfigForm(PROFILE, form({ repos: [{ name: "dockerfile", source: "/x" }] })),
    ).toThrow();
  });
});

describe("readProfileConfigView", () => {
  it("reports parseError for a broken build definition", () => {
    // Has repos + a [build] table (so it reads as an attempted build
    // definition), but the required dockerfile is missing → the form can't be
    // built, so parseError is set and the form is null.
    writeConfig(
      [
        "[[repos]]",
        'name = "app"',
        'source = "https://github.com/acme/app"',
        "",
        "[build]",
        "# dockerfile intentionally missing",
        "",
      ].join("\n"),
    );
    const view = readProfileConfigView(PROFILE);
    expect(view.hasConfig).toBe(false);
    expect(view.form).toBeNull();
    expect(view.parseError).toBeTruthy();
  });

  it("reports no config (no error) for an identity-only config.toml", () => {
    writeConfig('name = "demo"\n[git]\nname = "Ada"\nemail = "a@b.c"\n');
    const view = readProfileConfigView(PROFILE);
    expect(view.hasConfig).toBe(false);
    expect(view.form).toBeNull();
    expect(view.parseError).toBeNull();
  });

  it("returns a null form (no error) when there is no config yet", () => {
    const view = readProfileConfigView(PROFILE);
    expect(view.hasConfig).toBe(false);
    expect(view.form).toBeNull();
    expect(view.parseError).toBeNull();
  });
});

describe("dockerfile IO", () => {
  it("reads and writes the Dockerfile the config points at", () => {
    writeProfileConfigForm(PROFILE, form());
    writeDockerfile(PROFILE, "FROM ubuntu:24.04\nRUN echo hi\n");
    const view = readProfileConfigView(PROFILE);
    expect(view.dockerfile).toBe("FROM ubuntu:24.04\nRUN echo hi\n");
    expect(view.dockerfilePath).toBe(join(profileDir(PROFILE), "Dockerfile"));
  });

  it("refuses to write a Dockerfile outside the profile dir", () => {
    writeConfig(
      [
        "[build]",
        'dockerfile = "/etc/evil"',
        "",
        "[[repos]]",
        'name = "app"',
        'source = "/x"',
      ].join("\n"),
    );
    expect(() => writeDockerfile(PROFILE, "FROM scratch")).toThrow(/outside the profile/);
  });
});

describe("writeConfigTable: multi-line strings (e.g. the [prompt] prelude)", () => {
  const prelude = () => readProfileConfig(PROFILE)?.prompt?.prelude;

  it("preserves a multi-line value with special characters as a literal block", () => {
    const value = 'Line 1\nLine 2 with "quotes" and \\ backslash';
    writeConfigTable(profileConfigPath(PROFILE), "prompt", { prelude: value });
    const text = readConfig();
    expect(prelude()).toBe(value);
    // The newline lands on disk as a real newline in a verbatim literal block,
    // not a single-line basic string with an escaped "\n".
    expect(text).toContain(`prelude = '''${value}'''`);
    expect(text).not.toContain("\\n");
  });

  it("falls back to a basic block when the value contains '''", () => {
    // A literal ''' block can't hold a ''' run (e.g. a Python docstring), so this
    // must serialize as a """ block, escaping \\ and " but keeping real newlines.
    const value = "def f():\n    '''doc'''\n    return '\\n'\n";
    writeConfigTable(profileConfigPath(PROFILE), "prompt", { prelude: value });
    const text = readConfig();
    expect(prelude()).toBe(value);
    expect(text).toContain('prelude = """');
    expect(text).toContain("def f():\n    '''doc'''");
  });

  it("never squashes blank lines inside a multi-line value on a later save", () => {
    // Blank runs inside a value are the user's data, not formatting the
    // blank-line hygiene may touch when another store rewrites the file.
    const value = "Intro.\n\n\n\nSecond.";
    writeConfigTable(profileConfigPath(PROFILE), "prompt", { prelude: value });
    // A subsequent unrelated write (adding `name`) tidies the whole file.
    writeConfigBareKey(profileConfigPath(PROFILE), "name", "demo");
    expect(prelude()).toBe(value);
    expect(readConfig()).toContain("Intro.\n\n\n\nSecond.");
  });
});

describe('writeConfigNestedTables: [models."<id>"] sub-tables (model overrides)', () => {
  it("round-trips sub-tables whose ids contain dots", () => {
    writeConfig('name = "Demo"\n');
    writeConfigNestedTables(profileConfigPath(PROFILE), "models", {
      "gpt-5.5": { tier: "hidden" },
      "claude-opus-4-8": { tier: "more" },
    });
    const text = readConfig();
    // Dotted ids must be quoted in the table header.
    expect(text).toContain('[models."gpt-5.5"]');
    expect(text).toContain('tier = "hidden"');
    expect(readProfileConfig(PROFILE)?.models).toEqual({
      "gpt-5.5": { tier: "hidden" },
      "claude-opus-4-8": { tier: "more" },
    });
  });

  it("rewrites the whole region on change and drops it when empty", () => {
    writeConfig('name = "Demo"\n');
    const path = profileConfigPath(PROFILE);
    writeConfigNestedTables(path, "models", {
      "gpt-5.5": { tier: "hidden" },
      "claude-opus-4-8": { tier: "more" },
    });
    // Change one, remove the other.
    writeConfigNestedTables(path, "models", { "gpt-5.5": { tier: "more" } });
    expect(readProfileConfig(PROFILE)?.models).toEqual({ "gpt-5.5": { tier: "more" } });
    // An empty map drops the section entirely, leaving the rest intact.
    writeConfigNestedTables(path, "models", undefined);
    expect(readProfileConfig(PROFILE)?.models).toBeUndefined();
    expect(readConfig()).not.toContain("[models");
    expect(readConfig()).toContain('name = "Demo"');
  });

  it("rejects writing an unknown per-model field", () => {
    writeConfig('name = "Demo"\n');
    // The [models] entry is validated strictly, so an unknown field is a hard
    // error at write time rather than being silently kept.
    expect(() =>
      writeConfigNestedTables(profileConfigPath(PROFILE), "models", {
        "gpt-5.5": { tier: "hidden", note: "future" },
      }),
    ).toThrow();
  });

  it("rejects an unknown per-model field on read (whole config degrades)", () => {
    // A strict violation anywhere fails the schema parse, and readProfileConfig
    // degrades a bad file to null (rather than throwing) — so a stray model
    // field taints the whole config read, not just the [models] table.
    writeConfig('name = "Demo"\n\n[models."gpt-5.5"]\ntier = "hidden"\nnote = "future"\n');
    expect(readProfileConfig(PROFILE)).toBeNull();
  });
});
