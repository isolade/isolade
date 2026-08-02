import { existsSync, statSync } from "node:fs";
import { Hono } from "hono";
import { onboardingDemoSchema, repoPathBodySchema, repoPathCheckSchema } from "../contracts";
import {
  DEMO_CONFIG_FORM,
  DEMO_DOCKERFILE,
  DEMO_PROFILE_NAME,
  DEMO_RUNTIME_CONFIG,
} from "../onboarding-demo";
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

  // Whether a local source exists, so a mistyped path is caught while the user
  // is still looking at it rather than several minutes into a build. A remote
  // source is not checked: reaching it needs credentials we deliberately do not
  // ask for during setup, and the build reports what it finds.
  app.post("/api/onboarding/check-path", async (c) => {
    const { path } = repoPathBodySchema.parse(await c.req.json());
    const trimmed = path.trim();

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith("git@")) {
      return c.json(repoPathCheckSchema.parse({ ok: true, remote: true, problem: null }));
    }
    if (!trimmed) {
      return c.json(
        repoPathCheckSchema.parse({ ok: false, remote: false, problem: "Enter a path or a URL." }),
      );
    }
    if (!existsSync(trimmed)) {
      return c.json(
        repoPathCheckSchema.parse({
          ok: false,
          remote: false,
          problem: `Nothing exists at ${trimmed}.`,
        }),
      );
    }
    let directory = false;
    try {
      directory = statSync(trimmed).isDirectory();
    } catch (err) {
      return c.json(
        repoPathCheckSchema.parse({
          ok: false,
          remote: false,
          problem: `${trimmed} could not be read: ${(err as Error).message}`,
        }),
      );
    }
    return c.json(
      repoPathCheckSchema.parse({
        ok: directory,
        remote: false,
        problem: directory ? null : `${trimmed} is a file, not a directory.`,
      }),
    );
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
