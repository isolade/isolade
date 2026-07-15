import { Hono } from "hono";
import type { RouteContext } from "./context";

// ---- Agent auth (Claude / Codex in-app login), per profile ----
export function createAuthRouter(ctx: RouteContext): Hono {
  const { profiles, authLogin, queryProfile, NO_PROFILE } = ctx;
  const app = new Hono();

  const parseProvider = (p: string): "claude" | "codex" | null =>
    p === "claude" || p === "codex" ? p : null;

  app.get("/api/auth", (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const store = profiles.auth(profile);
    return c.json({
      claude: authLogin.providerStatus("claude", store),
      codex: authLogin.providerStatus("codex", store),
    });
  });

  app.post("/api/auth/:provider/login", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown provider" }, 404);
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    try {
      return c.json(await authLogin.start(provider, profiles.auth(profile)));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/auth/login/:sessionId", (c) => {
    try {
      return c.json(authLogin.status(c.req.param("sessionId")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.post("/api/auth/login/:sessionId/cancel", (c) => {
    authLogin.cancel(c.req.param("sessionId"));
    return c.json({ ok: true });
  });

  app.post("/api/auth/:provider/logout", (c) => {
    const provider = parseProvider(c.req.param("provider"));
    if (!provider) return c.json({ error: "unknown provider" }, 404);
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const store = profiles.auth(profile);
    authLogin.logout(provider, store);
    return c.json(authLogin.providerStatus(provider, store));
  });

  return app;
}
