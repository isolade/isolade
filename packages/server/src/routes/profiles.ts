import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  appearanceSchema,
  createProfileBodySchema,
  modelOverridesSchema,
  type ProfileSecret,
  profileActivationBodySchema,
  renameProfileBodySchema,
  setDockerfileBodySchema,
  setProfileConfigFormBodySchema,
  setProfileSecretBodySchema,
  setSecretDeclarationsBodySchema,
} from "../contracts";
import type { RouteContext } from "./context";

// ---- Profiles ---- (no "active profile" server state; the client picks)
// A profile is the whole unit: build definition (config.toml + Dockerfile),
// declared secrets, appearance, and, via the auth/git/network routers, its
// credentials and policy. `:id` is the profile id.
export function createProfilesRouter(ctx: RouteContext): Hono {
  const { profiles, secretsStore, titleVmManager, activeProfiles } = ctx;
  const app = new Hono();

  // A profile's environment build + secrets. (`:id` is the profile id, and a
  // profile IS the build unit that owns one image.)
  app.post("/api/profiles/:id/rebuild", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await profiles.rebuild(id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, message.includes("not found") ? 404 : 400);
    }
  });

  app.get("/api/profiles/:id/logs", (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);

    return streamSSE(c, async (stream) => {
      let offset = 0;
      while (true) {
        const logs = profiles.getLogs(id);
        while (offset < logs.length) {
          await stream.writeSSE({ data: logs[offset++] ?? "", event: "log" });
        }
        const profile = profiles.get(id);
        if (profile?.status !== "building") {
          await stream.writeSSE({
            data: profile?.status === "ready" ? "success" : "error",
            event: "done",
          });
          break;
        }
        await stream.sleep(200);
      }
    });
  });

  // The profile's build definition for the editor: the structured form (or a
  // parse error) and the resolved Dockerfile.
  app.get("/api/profiles/:id/config", (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(profiles.readConfigView(id));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Persist the structured form (comment-preserving). Returns the fresh view.
  app.put("/api/profiles/:id/config", async (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    const body = setProfileConfigFormBodySchema.parse(await c.req.json());
    try {
      return c.json(profiles.writeConfigForm(id, body.form));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Persist the profile's Dockerfile.
  app.put("/api/profiles/:id/dockerfile", async (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    const body = setDockerfileBodySchema.parse(await c.req.json());
    try {
      profiles.writeDockerfile(id, body.content);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // The profile's declared secrets, each annotated with whether a value is
  // stored. Values are write-only: entered here, never read back.
  const listProfileSecrets = async (id: string): Promise<ProfileSecret[]> => {
    const declarations = profiles.getSecretDeclarations(id);
    return Promise.all(
      declarations.map(async (d) => ({
        env: d.env,
        hosts: d.hosts,
        inject: d.inject,
        hasValue: await secretsStore.has(id, d.env),
      })),
    );
  };

  app.get("/api/profiles/:id/secrets", async (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await listProfileSecrets(id));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Replace-all of a profile's declared secrets, written back to its
  // config.toml (env var names + host scoping). Values are untouched.
  app.put("/api/profiles/:id/secret-declarations", async (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    const body = setSecretDeclarationsBodySchema.parse(await c.req.json());
    try {
      profiles.setSecretDeclarations(id, body.declarations);
      return c.json(await listProfileSecrets(id));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/api/profiles/:id/secrets/:env", async (c) => {
    const id = c.req.param("id");
    const env = c.req.param("env");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    let declarations: ProfileSecret[];
    try {
      declarations = await listProfileSecrets(id);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const decl = declarations.find((d) => d.env === env);
    if (!decl) return c.json({ error: `secret ${env} is not declared by this profile` }, 404);
    const body = setProfileSecretBodySchema.parse(await c.req.json());
    try {
      await secretsStore.set(id, env, body.value);
    } catch (err) {
      return c.json(
        {
          error: `failed to store secret: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }
    return c.json({ ...decl, hasValue: true } satisfies ProfileSecret);
  });

  app.delete("/api/profiles/:id/secrets/:env", async (c) => {
    const id = c.req.param("id");
    const env = c.req.param("env");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    let declarations: ProfileSecret[];
    try {
      declarations = await listProfileSecrets(id);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const decl = declarations.find((d) => d.env === env);
    if (!decl) return c.json({ error: `secret ${env} is not declared by this profile` }, 404);
    try {
      await secretsStore.delete(id, env);
    } catch (err) {
      return c.json(
        {
          error: `failed to clear secret: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }
    return c.json({ ...decl, hasValue: false } satisfies ProfileSecret);
  });

  app.get("/api/profiles", (c) => c.json(profiles.list()));

  // A window reports that it's using this profile: on boot, on switch, and as
  // a periodic heartbeat. Keeps the profile's warm titling VM alive (warming it
  // if needed) and moves the client off any profile it was previously on. The
  // warmup is fire-and-forget server-side, so this never blocks on a cold boot.
  app.post("/api/profiles/:id/activate", async (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    const { clientId } = profileActivationBodySchema.parse(await c.req.json());
    activeProfiles.activate(clientId, id);
    return c.json({ ok: true });
  });

  // A window is going away (pagehide). Released here so the profile's titling VM
  // is torn down once no window is using it. The body usually arrives via
  // navigator.sendBeacon, so parse leniently and never depend on the profile
  // still existing (it may be mid-delete). The client id alone drives release.
  app.post("/api/profiles/:id/deactivate", async (c) => {
    const parsed = profileActivationBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    activeProfiles.deactivate(parsed.data.clientId);
    return c.json({ ok: true });
  });

  app.post("/api/profiles", async (c) => {
    const { name } = createProfileBodySchema.parse(await c.req.json());
    return c.json(profiles.create(name), 201);
  });

  app.get("/api/profiles/:id", (c) => {
    const profile = profiles.get(c.req.param("id"));
    if (!profile) return c.json({ error: "not found" }, 404);
    return c.json(profile);
  });

  // Deep-copy an existing profile (build definition + appearance/git/network),
  // excluding auth credentials and secret values. `:id` is the source.
  app.post("/api/profiles/:id/clone", async (c) => {
    const { name } = createProfileBodySchema.parse(await c.req.json());
    try {
      return c.json(profiles.clone(c.req.param("id"), name), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, message.includes("not found") ? 404 : 400);
    }
  });

  app.patch("/api/profiles/:id", async (c) => {
    const { name } = renameProfileBodySchema.parse(await c.req.json());
    try {
      return c.json(profiles.rename(c.req.param("id"), name));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.delete("/api/profiles/:id", (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    if (profiles.list().length <= 1) {
      return c.json({ error: "cannot delete the only profile" }, 400);
    }
    // Tear down the profile's warm titling VM before its credential dir is
    // removed. Fire-and-forget: deletion shouldn't block on VM teardown.
    void titleVmManager.disposeForProfile(id);
    profiles.remove(id);
    return c.json({ ok: true });
  });

  app.get("/api/profiles/:id/appearance", (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    return c.json(profiles.appearance(id));
  });

  app.put("/api/profiles/:id/appearance", async (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    const body = appearanceSchema.parse(await c.req.json());
    return c.json(profiles.setAppearance(id, body));
  });

  // Per-profile model catalog overrides (visibility/tier deltas).
  app.get("/api/profiles/:id/models", (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    return c.json(profiles.modelOverrides(id));
  });

  app.put("/api/profiles/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!profiles.get(id)) return c.json({ error: "not found" }, 404);
    const body = modelOverridesSchema.parse(await c.req.json());
    return c.json(profiles.setModelOverrides(id, body));
  });

  return app;
}
