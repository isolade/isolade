import { Hono } from "hono";
import { setGitIdentityBodySchema, setSigningConfigBodySchema } from "../contracts";
import type { RouteContext } from "./context";

// ---- Agent git config: committer identity + commit signing, per profile ----
// Identity is applied to every agent commit (signed or not). Signing is
// Secretive-backed and the key never enters the VM.
export function createGitRouter(ctx: RouteContext): Hono {
  const { profiles, queryProfile, NO_PROFILE } = ctx;
  const app = new Hono();

  app.get("/api/git", (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    return c.json(profiles.git(profile).status());
  });

  app.post("/api/git/identity", async (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const body = setGitIdentityBodySchema.parse(await c.req.json());
    try {
      return c.json(profiles.git(profile).setIdentity(body));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Keys the SSH agent advertises, for the setup key-picker. Optional ?socket=
  // previews a not-yet-saved socket path.
  app.get("/api/git/signing/keys", (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const socket = c.req.query("socket");
    return c.json(profiles.git(profile).listKeys(socket || undefined));
  });

  app.post("/api/git/signing", async (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    const body = setSigningConfigBodySchema.parse(await c.req.json());
    try {
      return c.json(profiles.git(profile).setSigning(body));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/git/signing/disable", (c) => {
    const profile = queryProfile(c);
    if (!profile) return c.json(NO_PROFILE, 400);
    return c.json(profiles.git(profile).disableSigning());
  });

  return app;
}
