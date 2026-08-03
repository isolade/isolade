import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASES,
  composeDockerfile,
  onboardingDemoSchema,
  repoFormSchema,
  repoNamesFor,
  repoPathCheckSchema,
  TOOL_CATEGORIES,
  TOOLCHAINS,
} from "@isolade/shared";
import {
  DEMO_CONFIG_FORM,
  DEMO_DOCKERFILE,
  DEMO_NETWORK_CONFIG,
  DEMO_PORT,
  DEMO_REPO_NAME,
} from "../src/onboarding-demo";
import { expandHomePath } from "../src/profile-config";
import { createOnboardingRouter } from "../src/routes/onboarding";

// The onboarding wizard. It infers nothing about a repository: the
// user says which toolchains the image should carry, and the Dockerfile composes
// from snippets we own.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "isolade-onboarding-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("naming repositories", () => {
  it("takes the last segment of a path or a URL", () => {
    expect(repoNamesFor(["/home/you/code/my-app"])).toEqual(["my-app"]);
    expect(repoNamesFor(["https://github.com/owner/Repo.git"])).toEqual(["repo"]);
    expect(repoNamesFor(["git@github.com:owner/repo.git"])).toEqual(["repo"]);
    expect(repoNamesFor(["/home/you/code/My Project/"])).toEqual(["my-project"]);
  });

  it("resolves collisions rather than leaving them to fail the build", () => {
    // Two directories called `api` are entirely normal across repositories, and
    // duplicate context names would fail the build with an unhelpful error.
    expect(repoNamesFor(["/a/api", "/b/api", "/c/api"])).toEqual(["api", "api-2", "api-3"]);
  });

  it("always emits a name the profile schema accepts", () => {
    for (const name of repoNamesFor(["/x/---", "/x/.hidden", "/x/UPPER_CASE", "/x/9"])) {
      expect(repoFormSchema.shape.name.safeParse(name).success).toBe(true);
    }
  });
});

describe("composing the Dockerfile", () => {
  it("starts from a base the agent layer can build on", () => {
    // The layer Isolade stacks on top runs apt-get, so every base on offer has
    // to be Debian-family. This is a correctness constraint, not a preference.
    for (const b of BASES) {
      expect(composeDockerfile([], [], b.id)).toContain(`FROM ${b.image}`);
      expect(b.image).toMatch(/^(ubuntu|debian):/);
    }
  });

  it("packages every toolchain under one name across both bases", () => {
    // The offer would be a lie otherwise: picking Debian must not silently
    // change what a checkbox installs.
    const [a, b] = BASES;
    const ids = TOOLCHAINS.map((tool) => tool.id);
    expect(composeDockerfile([], ids, a.id).replace(a.image, "")).toBe(
      composeDockerfile([], ids, b.id).replace(b.image, ""),
    );
  });

  it("builds a profile with no repositories at all", () => {
    // A profile with an empty workspace is valid: the agent clones what it
    // needs. So the file is just a base, with nothing copied in.
    const df = composeDockerfile([], ["python"]);
    expect(df).toContain("python3");
    expect(df).not.toContain("COPY");
  });

  it("copies each repository to its own place under /workspace", () => {
    const df = composeDockerfile(["api", "web"], []);
    expect(df).toContain("COPY --from=api --chown=agent:agent . /workspace/api");
    expect(df).toContain("COPY --from=web --chown=agent:agent . /workspace/web");
  });

  it("installs only what was asked for, in one apt step", () => {
    const df = composeDockerfile(["app"], ["python", "build"]);
    expect(df).toContain("python3");
    expect(df).toContain("build-essential");
    expect(df).not.toContain("golang-go");
    expect(df.match(/apt-get install/g)).toHaveLength(1);
  });

  it("creates the user the agent runs as, before anything is copied", () => {
    // Isolade's layer creates one if a Dockerfile has not, but only a Dockerfile
    // that has the user can COPY --chown to it, and a repository the agent
    // cannot write to is not a workspace.
    const df = composeDockerfile(["app"], []);
    expect(df).toContain("useradd");
    expect(df.indexOf("useradd")).toBeLessThan(df.indexOf("COPY"));
    expect(df).toContain("COPY --from=app --chown=agent:agent . /workspace/app");
  });

  it("installs a toolchain where any user can reach it", () => {
    // rustup into a home directory is a toolchain the agent cannot run, and
    // fetching it needs a curl neither base ships.
    const df = composeDockerfile([], ["rust"]);
    expect(df).toContain("curl");
    expect(df).not.toContain("/root/.cargo");
    expect(df).toContain("CARGO_HOME=/usr/local/cargo");
  });

  it("does not install project dependencies", () => {
    // Same reasoning as ever: how to install them is the project's business, and
    // a failed install is a failed first build. The agent can do it and say what
    // it needed.
    const df = composeDockerfile(["app"], []);
    // Instructions only: blank lines, comments, and the continuation lines of a
    // multi-line RUN are not any of them.
    let continued = false;
    const instructions: string[] = [];
    for (const line of df.split("\n")) {
      const text = line.trim();
      const isContinuation = continued;
      continued = text.endsWith("\\");
      if (!text || text.startsWith("#") || isContinuation) continue;
      instructions.push(text.split(/\s+/)[0]!);
    }
    // The one RUN is the agent user, which is the image's business rather than
    // the project's.
    expect(instructions).toEqual(["FROM", "RUN", "COPY"]);
    expect(df).not.toMatch(/npm|yarn|pnpm|pip install|bundle install|go mod/);
  });

  it("adds the steps a toolchain needs beyond apt", () => {
    const df = composeDockerfile([], ["rust"]);
    expect(df).toContain("rustup");
    expect(df).toContain('PATH="/usr/local/cargo/bin:$PATH"');
  });

  it("offers no toolchain the agent layer already installs", () => {
    // Node arrives in every image regardless, so offering it would suggest a
    // choice that does not exist.
    expect(TOOLCHAINS.map((t) => t.id)).not.toContain("node");
  });

  it("asks apt for a shared package once, however many choices want it", () => {
    // Build tools, CMake and Rust all want build-essential, and apt naming it
    // three times is a Dockerfile nobody would have written by hand.
    const df = composeDockerfile([], ["build", "cmake", "rust"]);
    expect(df.match(/build-essential/g)).toHaveLength(1);
  });

  it("wraps the packages rather than emitting one very long line", () => {
    // The preview sits in a narrow column beside the questions, and two choices
    // can add up to thirty packages.
    const df = composeDockerfile([], ["shell", "browser"]);
    const packageLines = df.split("\n").filter((line) => line.startsWith("        "));
    expect(packageLines.length).toBeGreaterThan(1);
    for (const line of packageLines) expect(line.length).toBeLessThanOrEqual(72);
  });
});

describe("what is on offer", () => {
  it("puts every toolchain in a category, and every category to use", () => {
    const categories = TOOL_CATEGORIES.map((c) => c.id);
    for (const tool of TOOLCHAINS) expect(categories).toContain(tool.category);
    for (const id of categories) expect(TOOLCHAINS.some((t) => t.category === id)).toBe(true);
  });

  it("names each toolchain once", () => {
    const ids = TOOLCHAINS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the list in category order, so the file reads like the questions", () => {
    const order = TOOL_CATEGORIES.map((c) => c.id);
    const seen = TOOLCHAINS.map((t) => order.indexOf(t.category));
    expect(seen).toEqual([...seen].toSorted((a, b) => a - b));
  });

  it("depends on nothing the agent layer adds after this file", () => {
    // The scaffold is the base stage and the agent layer is appended to it, so
    // an npx or a corepack here would run before there is a Node to run it.
    for (const tool of TOOLCHAINS) {
      const steps = (tool.extra ?? "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(steps).not.toMatch(/\b(corepack|node|npm|npx)\b/);
    }
  });

  it("brings its own curl for anything it fetches over the network", () => {
    // Neither base ships curl or ca-certificates, so a step that downloads an
    // installer has to ask for them itself.
    for (const tool of TOOLCHAINS) {
      const fetches = (tool.extra ?? "").split("\n").some((line) => line.includes("curl -"));
      if (!fetches) continue;
      expect(tool.packages ?? []).toContain("ca-certificates");
      expect(tool.packages ?? []).toContain("curl");
    }
  });

  it("only notes what the packages beside the note leave out", () => {
    // A note is emitted under the install step, so a toolchain with a note and
    // nothing to install would have it quietly dropped.
    for (const tool of TOOLCHAINS) {
      if (tool.note) expect(tool.packages ?? []).not.toHaveLength(0);
    }
  });

  it("installs into a shared prefix, never into a home directory", () => {
    // The user that runs the build is not the user that runs the agent, so a
    // toolchain under /root is one the agent cannot see.
    for (const tool of TOOLCHAINS) {
      expect(tool.extra ?? "").not.toContain("/root");
      expect(tool.extra ?? "").not.toContain("$HOME");
    }
  });
});

describe("the routes", () => {
  const app = createOnboardingRouter({} as never);

  const check = async (path: string) => {
    const res = await app.request("/api/onboarding/check-path", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    expect(res.status).toBe(200);
    return repoPathCheckSchema.parse(await res.json());
  };

  it("accepts a checkout on this machine", async () => {
    const dir = join(root, "project");
    mkdirSync(join(dir, ".git"), { recursive: true });
    expect(await check(dir)).toMatchObject({ ok: true, remote: false, problem: null });
  });

  it("catches a mistyped path while the user is still looking at it", async () => {
    const result = await check(join(root, "absent"));
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("Nothing exists at");
  });

  it("rejects a file", async () => {
    const file = join(root, "a-file");
    writeFileSync(file, "");
    expect((await check(file)).problem).toContain("is a file");
  });

  it("catches a directory that is not a checkout", async () => {
    // The build ships a repository's history with its tree, so this one fails
    // there, minutes later, having been waved through here.
    const dir = join(root, "not-a-repo");
    mkdirSync(dir);
    expect((await check(dir)).problem).toContain("not a Git checkout");
  });

  it("takes a remote in the form the field itself suggests", async () => {
    // `github.com/owner/repo` is the placeholder in the input and the build
    // clones it happily. This route used to answer "Nothing exists at" it.
    for (const source of [
      "github.com/owner/repo",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
    ]) {
      expect(await check(source)).toMatchObject({ ok: true, remote: true, problem: null });
    }
  });

  it("says what it takes when a remote is not one the build could clone", async () => {
    // Passing these through was worse than rejecting them: the build treats a
    // source it cannot parse as a directory name, and fails on that instead.
    for (const source of [
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "https://gitlab.com/owner/repo",
      "https://github.com/owner/repo/tree/main",
    ]) {
      const result = await check(source);
      expect(result.ok).toBe(false);
      expect(result.problem).toContain("github.com/owner/repo");
    }
  });

  it("resolves a typed path the way the build will", async () => {
    // Same expansion on both sides, so `~/code/thing` is not reported missing
    // here and then cloned there.
    expect(expandHomePath("~/code/thing")).toBe(join(homedir(), "code/thing"));
    expect(expandHomePath("/tmp/~/keep")).toBe("/tmp/~/keep");
  });

  it("serves a demo definition that matches its schema", async () => {
    const res = await app.request("/api/onboarding/demo");
    expect(res.status).toBe(200);
    const demo = onboardingDemoSchema.parse(await res.json());
    expect(demo.form.repos[0]?.source).toContain("excalidraw");
    expect(demo.network.ports).toEqual([DEMO_PORT]);
  });
});

describe("the demo definition", () => {
  it("names the repo its Dockerfile copies from", () => {
    expect(DEMO_CONFIG_FORM.repos[0]?.name).toBe(DEMO_REPO_NAME);
    expect(DEMO_DOCKERFILE).toContain(`COPY --from=${DEMO_REPO_NAME} --chown=agent:agent . .`);
    expect(repoFormSchema.safeParse(DEMO_CONFIG_FORM.repos[0]).success).toBe(true);
  });

  it("installs dependencies at build time, unlike a scaffold", () => {
    // The demo is a definition we own and test, so it can do what a scaffold for
    // an unknown project must not: run something that can fail.
    expect(DEMO_DOCKERFILE).toContain("yarn install");
  });

  it("forwards the dev server's port without starting the dev server", () => {
    // The demo exists to be watched doing something, and "start the dev server"
    // is that something. The forward is open before anything listens, so the
    // preview has it the moment an agent runs the command, with no trip to the
    // Ports panel in between.
    expect(DEMO_NETWORK_CONFIG.ports).toEqual([DEMO_PORT]);
    const instructions = DEMO_DOCKERFILE.split("\n").filter((line) => !line.trim().startsWith("#"));
    expect(instructions.join("\n")).not.toContain("yarn start");
  });

  it("spares whoever runs that command Vite's attempt to open a browser", () => {
    // Its config sets `open: true`, and a VM has no browser, so every start
    // would end in a failure to launch one.
    expect(DEMO_DOCKERFILE).toContain("ENV BROWSER=none");
  });

  it("hands the checkout to the user the agent runs as", () => {
    // Root-owned sources build fine and then fail at the only thing the demo is
    // for, since the agent cannot edit them and Vite cannot write its cache.
    expect(DEMO_DOCKERFILE).toContain("useradd");
    expect(DEMO_DOCKERFILE).toContain("--chown=agent:agent");
    expect(DEMO_DOCKERFILE).toContain("USER agent");
    // The install runs as that user, so what it writes belongs to it too, which
    // is why the cache mount has to be handed over as well.
    const install = DEMO_DOCKERFILE.slice(DEMO_DOCKERFILE.indexOf("USER agent"));
    expect(install).toContain("yarn install");
    expect(install).toMatch(/type=cache[^\n]*uid=\d+,gid=\d+/);
  });
});
