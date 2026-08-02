import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { onboardingDemoSchema, repoPathBodySchema, repoPathCheckSchema } from "../contracts";
import {
  DEMO_CONFIG_FORM,
  DEMO_DOCKERFILE,
  DEMO_PROFILE_NAME,
  DEMO_RUNTIME_CONFIG,
} from "../onboarding-demo";
import { expandHomePath, parseGitRemoteUrl } from "../profile-config";
import type { RouteContext } from "./context";

// ---- Onboarding wizard ----
// Both routes are reads. Everything the wizard creates it creates through the
// ordinary profile routes, so a profile it produced is indistinguishable from a
// hand-authored one and an abandoned run leaves nothing behind.
//
// Nothing here inspects a repository's contents. The wizard asks which
// toolchains the image should carry rather than guessing from files, and the
// Dockerfile it writes is composed in @isolade/shared.
export function createOnboardingRouter(_ctx: RouteContext): Hono {
  const app = new Hono();

  // Whether a source is one the build would take, so a mistake is caught while
  // the user is still looking at it rather than several minutes into a build.
  //
  // What counts as a remote is `parseGitRemoteUrl`, the parser the build itself
  // uses, rather than a second opinion here. This route used to call anything
  // with a scheme a remote and everything else a path, which answered "Nothing
  // exists at github.com/owner/repo" to someone typing the form printed in the
  // field as its placeholder, and waved through an `ssh://` remote the build
  // would go on to treat as a directory name.
  //
  // Reachability is still not checked. A private repository needs credentials
  // setup deliberately does not ask for, so the build is what reports whether
  // the clone worked.
  app.post("/api/onboarding/check-path", async (c) => {
    const { path } = repoPathBodySchema.parse(await c.req.json());
    const source = path.trim();
    const answer = (ok: boolean, remote: boolean, problem: string | null) =>
      c.json(repoPathCheckSchema.parse({ ok, remote, problem }));

    if (!source) return answer(false, false, "Enter a path or a URL.");
    if (parseGitRemoteUrl(source)) return answer(true, true, null);

    const local = expandHomePath(source);
    if (!existsSync(local)) {
      // A source meant as a remote gets the rule rather than a line about a
      // path, since it was never a path and "nothing exists there" reads as a
      // typo in one.
      return answer(
        false,
        false,
        looksRemote(source)
          ? `Isolade clones from github.com over HTTPS, as github.com/owner/repo. Anything else has to be a checkout on this machine.`
          : `Nothing exists at ${source}.`,
      );
    }

    let directory = false;
    try {
      directory = statSync(local).isDirectory();
    } catch (err) {
      return answer(false, false, `${source} could not be read: ${(err as Error).message}`);
    }
    if (!directory) return answer(false, false, `${source} is a file, not a directory.`);
    // The build ships a repository's history alongside its tree, so a directory
    // without one fails there. Saying it here costs nothing.
    if (!existsSync(resolve(local, ".git"))) {
      return answer(false, false, `${source} is not a Git checkout.`);
    }
    return answer(true, false, null);
  });

  // The demo definition, served rather than duplicated in the client so the
  // Dockerfile the wizard writes and the one shipped here cannot drift.
  app.get("/api/onboarding/demo", (c) =>
    c.json(
      onboardingDemoSchema.parse({
        name: DEMO_PROFILE_NAME,
        form: DEMO_CONFIG_FORM,
        dockerfile: DEMO_DOCKERFILE,
        runtime: DEMO_RUNTIME_CONFIG,
      }),
    ),
  );

  return app;
}

/** Whether a source was meant as a remote at all, for the message when it is not
 *  one Isolade clones: an ssh remote, a host other than github.com, or a link to
 *  a page rather than to a repository. Only consulted for a source that exists
 *  nowhere on disk, so a directory named like a host is still a directory. */
function looksRemote(source: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ||
    source.startsWith("git@") ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(source)
  );
}
