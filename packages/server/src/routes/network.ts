import { Hono } from "hono";
import { networkConfigSchema } from "../contracts";
import type { RouteContext } from "./context";

// ---- Sandbox network policy (per profile, applied to that profile's new VMs) ----
export function createNetworkRouter(ctx: RouteContext): Hono {
  const { profiles, queryProfile, NO_PROFILE } = ctx;
  const app = new Hono();

  app.get("/api/network", (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    return c.json(profiles.network(profile).read());
  });

  app.post("/api/network", async (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const body = networkConfigSchema.parse(await c.req.json());
    try {
      return c.json(profiles.network(profile).write(body));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
