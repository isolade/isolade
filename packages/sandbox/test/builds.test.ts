import { afterEach, describe, expect, it } from "bun:test";
import {
  deriveHome,
  imageUserName,
  inspectImageConfig,
  parseImageRef,
  runRegistryGarbageCollect,
} from "../src/builds";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("parseImageRef", () => {
  it("parses registry, repository name, and tag", () => {
    expect(parseImageRef("localhost:5000/isolade/image:latest")).toEqual({
      registry: "localhost:5000",
      name: "isolade/image",
      tag: "latest",
    });
  });

  it("accepts registries with dots and rejects implicit Docker Hub refs", () => {
    expect(parseImageRef("ghcr.io/acme/image:v1")).toEqual({
      registry: "ghcr.io",
      name: "acme/image",
      tag: "v1",
    });
    expect(parseImageRef("library/alpine:latest")).toBeNull();
  });

  it("rejects refs without a tag or repository", () => {
    expect(parseImageRef("localhost:5000/isolade/image")).toBeNull();
    expect(parseImageRef("latest")).toBeNull();
  });
});

describe("runRegistryGarbageCollect", () => {
  type RegistryState = {
    repos: string[];
    tags: Record<string, string[]>;
    deletes: { repo: string; digest: string }[];
  };

  function mockRegistry(
    state: Omit<RegistryState, "deletes"> & {
      deletes?: RegistryState["deletes"];
    },
  ): asserts state is RegistryState {
    state.deletes ??= [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/v2/_catalog")) {
        return Response.json({ repositories: state.repos });
      }
      const tagsMatch = url.match(/\/v2\/(.+)\/tags\/list$/);
      if (tagsMatch) {
        return Response.json({ tags: state.tags[tagsMatch[1]!] ?? [] });
      }
      const manifestMatch = url.match(/\/v2\/(.+)\/manifests\/(.+)$/);
      if (manifestMatch) {
        const repo = manifestMatch[1]!;
        const tag = decodeURIComponent(manifestMatch[2]!);
        if (method === "HEAD") {
          if (!(state.tags[repo] ?? []).includes(tag)) {
            return new Response(null, { status: 404 });
          }
          return new Response(null, {
            status: 200,
            headers: {
              "docker-content-digest": `sha256:${repo.replace(/\W/g, "_")}_${tag}`,
            },
          });
        }
        if (method === "DELETE") {
          state.deletes!.push({ repo, digest: tag });
          return new Response(null, { status: 202 });
        }
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  }

  it("deletes every tag not in the keep set", async () => {
    const state = {
      repos: ["isolade-base/aaa", "isolade/aaa", "isolade-base/bbb", "isolade/bbb"],
      tags: {
        "isolade-base/aaa": ["latest"],
        "isolade/aaa": ["latest"],
        "isolade-base/bbb": ["latest"],
        "isolade/bbb": ["latest"],
      } as Record<string, string[]>,
    };
    mockRegistry(state);
    const logs: string[] = [];

    await runRegistryGarbageCollect(
      "192.168.65.1:5001",
      new Set(["isolade/aaa:latest", "isolade-base/aaa:latest"]),
      (line) => logs.push(line),
    );

    expect(state.deletes!.map((d) => d.repo).toSorted()).toEqual([
      "isolade-base/bbb",
      "isolade/bbb",
    ]);
    expect(logs.some((l) => l.includes("scanned 4 tags"))).toBe(true);
    expect(logs.some((l) => l.includes("deleted 2"))).toBe(true);
  });

  it("keeps everything when keep set covers every tag", async () => {
    const state = {
      repos: ["isolade/keep"],
      tags: { "isolade/keep": ["latest"] },
    };
    mockRegistry(state);

    await runRegistryGarbageCollect("host:5001", new Set(["isolade/keep:latest"]), () => {});

    expect(state.deletes).toEqual([]);
  });
});

describe("imageUserName", () => {
  it("returns null when no user is set", () => {
    expect(imageUserName(null)).toBeNull();
    expect(imageUserName({ user: null, env: {}, workingDir: null })).toBeNull();
  });

  it("normalizes uid 0 to root and strips group suffixes", () => {
    expect(imageUserName({ user: "0", env: {}, workingDir: null })).toBe("root");
    expect(imageUserName({ user: "alice:dev", env: {}, workingDir: null })).toBe("alice");
    expect(imageUserName({ user: "root", env: {}, workingDir: null })).toBe("root");
  });
});

describe("deriveHome", () => {
  it("falls back to /root with no config", () => {
    expect(deriveHome(null)).toBe("/root");
  });

  it("uses Env.HOME when present", () => {
    expect(
      deriveHome({
        user: "alice",
        env: { HOME: "/var/lib/alice" },
        workingDir: null,
      }),
    ).toBe("/var/lib/alice");
  });

  it("synthesizes /home/<user> when HOME is unset and user is non-root", () => {
    expect(deriveHome({ user: "agent", env: {}, workingDir: null })).toBe("/home/agent");
  });

  it("returns /root for empty or root user", () => {
    expect(deriveHome({ user: null, env: {}, workingDir: null })).toBe("/root");
    expect(deriveHome({ user: "root", env: {}, workingDir: null })).toBe("/root");
  });
});

describe("inspectImageConfig", () => {
  it("fetches manifest and config blob and returns parsed values", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/manifests/latest")) {
        return Response.json({
          schemaVersion: 2,
          config: { digest: "sha256:cfg" },
          layers: [],
        });
      }
      if (url.endsWith("/blobs/sha256%3Acfg")) {
        return Response.json({
          config: {
            User: "agent",
            Env: ["PATH=/usr/bin", "HOME=/home/agent"],
            WorkingDir: "/workspace",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const cfg = await inspectImageConfig("localhost:5000/isolade/image:latest");
    expect(cfg).toEqual({
      user: "agent",
      env: { PATH: "/usr/bin", HOME: "/home/agent" },
      workingDir: "/workspace",
    });
    expect(calls).toEqual([
      "http://localhost:5000/v2/isolade/image/manifests/latest",
      "http://localhost:5000/v2/isolade/image/blobs/sha256%3Acfg",
    ]);
  });

  it("follows manifest indices to a child manifest", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/manifests/latest")) {
        return Response.json({
          schemaVersion: 2,
          manifests: [{ digest: "sha256:child" }],
        });
      }
      if (url.includes("/manifests/sha256")) {
        return Response.json({
          schemaVersion: 2,
          config: { digest: "sha256:cfg" },
          layers: [],
        });
      }
      if (url.includes("/blobs/")) {
        return Response.json({ config: { User: "alice" } });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const cfg = await inspectImageConfig("localhost:5000/isolade/image:latest");
    expect(cfg?.user).toBe("alice");
  });

  it("returns null on any failure", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await inspectImageConfig("localhost:5000/isolade/image:latest")).toBeNull();

    expect(await inspectImageConfig("not-a-ref")).toBeNull();
  });
});
