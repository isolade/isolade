import { Hono } from "hono";
import { promptConfigSchema } from "../contracts";
import type { RouteContext } from "./context";

// ---- Prompt augmentation (per profile: the chat prelude) ----
export function createPromptRouter(ctx: RouteContext): Hono {
  const { profiles, queryProfile, NO_PROFILE } = ctx;
  const app = new Hono();

  app.get("/api/prompt", (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    return c.json(profiles.prompt(profile).read());
  });

  app.post("/api/prompt", async (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const body = promptConfigSchema.parse(await c.req.json());
    try {
      return c.json(profiles.prompt(profile).write(body));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
