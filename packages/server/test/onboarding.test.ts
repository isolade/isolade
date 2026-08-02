import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASES,
  composeDockerfile,
  onboardingDemoSchema,
  repoFormSchema,
  repoNamesFor,
  repoPathCheckSchema,
  TOOLCHAINS,
} from "@isolade/shared";
import { DEMO_CONFIG_FORM, DEMO_DOCKERFILE, DEMO_REPO_NAME } from "../src/onboarding-demo";
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

  it("accepts a directory", async () => {
    const dir = join(root, "project");
    mkdirSync(dir);
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

  it("passes a remote source through for the build to resolve", async () => {
    // Reaching a private repository needs credentials the wizard deliberately
    // does not ask for, so the build is what reports whether it worked.
    for (const url of ["https://github.com/owner/repo", "git@github.com:owner/repo.git"]) {
      expect(await check(url)).toMatchObject({ ok: true, remote: true });
    }
  });

  it("serves a demo definition that matches its schema", async () => {
    const res = await app.request("/api/onboarding/demo");
    expect(res.status).toBe(200);
    const demo = onboardingDemoSchema.parse(await res.json());
    expect(demo.form.repos[0]?.source).toContain("excalidraw");
    expect(demo.runtime.start.async[0]).toContain("BROWSER=none");
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
