import { Hono } from "hono";
import { runtimeConfigSchema } from "../contracts";
import type { RouteContext } from "./context";

// ---- Runtime posture (per profile: caches + setup/start lifecycle) ----
export function createRuntimeRouter(ctx: RouteContext): Hono {
  const { profiles, queryProfile, NO_PROFILE } = ctx;
  const app = new Hono();

  app.get("/api/runtime", (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    return c.json(profiles.runtime(profile).read());
  });

  app.post("/api/runtime", async (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const body = runtimeConfigSchema.parse(await c.req.json());
    try {
      return c.json(profiles.runtime(profile).write(body));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
