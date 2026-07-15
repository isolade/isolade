import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ProfileConfigForm, profileConfigViewSchema } from "../src/contracts";
import { createTestServer } from "./helpers";

// Wiring check for the profile-config routes against the auto-created `default`
// profile. Behavior of the writer itself is covered by config-editor.test.ts.
// This confirms the routes parse bodies, persist, and return the shared view
// shape.
describe("profile config routes", () => {
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    const server = createTestServer();
    baseUrl = server.baseUrl;
    cleanup = server.cleanup;
  });
  afterAll(async () => {
    await cleanup();
  });

  const form = (over: Partial<ProfileConfigForm> = {}): ProfileConfigForm => ({
    repos: [{ name: "app", source: "https://github.com/acme/app" }],
    dockerfile: "./Dockerfile",
    skills: [],
    ...over,
  });

  const putJson = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("GET /config reports no config on a fresh profile", async () => {
    const res = await fetch(`${baseUrl}/api/profiles/default/config`);
    expect(res.status).toBe(200);
    const view = profileConfigViewSchema.parse(await res.json());
    expect(view.hasConfig).toBe(false);
    expect(view.form).toBeNull();
  });

  it("PUT /config creates config.toml and round-trips through the form", async () => {
    const res = await putJson("/api/profiles/default/config", {
      form: form({ skills: ["acme/skills"] }),
    });
    expect(res.status).toBe(200);
    const view = profileConfigViewSchema.parse(await res.json());
    expect(view.hasConfig).toBe(true);
    expect(view.form!.skills).toEqual(["acme/skills"]);
    expect(view.form!.repos[0]!.name).toBe("app");
  });

  it("PUT /config rejects an invalid definition with 400", async () => {
    const res = await putJson("/api/profiles/default/config", {
      form: form({ repos: [{ name: "dockerfile", source: "/x" }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("PUT /dockerfile writes and GET reflects it", async () => {
    const res = await putJson("/api/profiles/default/dockerfile", {
      content: "FROM ubuntu:24.04\nRUN echo hi\n",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const view = profileConfigViewSchema.parse(
      await (await fetch(`${baseUrl}/api/profiles/default/config`)).json(),
    );
    expect(view.dockerfile).toBe("FROM ubuntu:24.04\nRUN echo hi\n");
  });

  it("404s on an unknown profile", async () => {
    const res = await fetch(`${baseUrl}/api/profiles/nope/config`);
    expect(res.status).toBe(404);
  });
});
