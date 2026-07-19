import { describe, expect, test } from "bun:test";
import { parseMountMap, resolveAgainstHome, translateHostPath } from "../src/mount-map";

const HOME = "/home/agent";

describe("parseMountMap", () => {
  test("parses a valid map", () => {
    const raw = JSON.stringify([
      { guestPath: "~/.cache/isolade", hostPath: "/host/caches/dev/.cache__isolade" },
      { guestPath: "/run/isolade-seed", hostPath: "/host/seeds/i-1" },
    ]);
    expect(parseMountMap(raw)).toEqual([
      { guestPath: "~/.cache/isolade", hostPath: "/host/caches/dev/.cache__isolade" },
      { guestPath: "/run/isolade-seed", hostPath: "/host/seeds/i-1" },
    ]);
  });

  test("absent, non-JSON, and malformed shapes all yield null (not nested)", () => {
    expect(parseMountMap(undefined)).toBeNull();
    expect(parseMountMap("")).toBeNull();
    expect(parseMountMap("not json")).toBeNull();
    expect(parseMountMap(JSON.stringify({ guestPath: "x" }))).toBeNull();
    expect(parseMountMap(JSON.stringify([{ guestPath: 1, hostPath: "y" }]))).toBeNull();
  });
});

describe("resolveAgainstHome", () => {
  test("expands ~/ and $HOME/ against the given home", () => {
    expect(resolveAgainstHome("~/.cache/isolade", HOME)).toBe("/home/agent/.cache/isolade");
    expect(resolveAgainstHome("$HOME/.local/share", HOME)).toBe("/home/agent/.local/share");
    expect(resolveAgainstHome("~", HOME)).toBe(HOME);
    expect(resolveAgainstHome("$HOME", HOME)).toBe(HOME);
  });

  test("leaves absolute paths alone", () => {
    expect(resolveAgainstHome("/run/isolade-seed", HOME)).toBe("/run/isolade-seed");
  });
});

describe("translateHostPath", () => {
  const map = [
    { guestPath: "~/.cache/isolade", hostPath: "/host/caches/dev/.cache__isolade" },
    {
      guestPath: "~/.local/share/isolade/profiles",
      hostPath: "/host/caches/dev/.local__share__isolade__profiles",
    },
    { guestPath: "/run/isolade-seed", hostPath: "/host/seeds/i-1" },
  ];

  test("maps a path under a tilde-declared mount (the auth-dir case)", () => {
    // What the nested InstanceManager emits for a profile auth mount.
    expect(
      translateHostPath(map, "/home/agent/.local/share/isolade/profiles/acme/auth", HOME),
    ).toBe("/host/caches/dev/.local__share__isolade__profiles/acme/auth");
  });

  test("maps a path under an absolute mount", () => {
    expect(translateHostPath(map, "/run/isolade-seed/manifest.json", HOME)).toBe(
      "/host/seeds/i-1/manifest.json",
    );
  });

  test("maps the mount root itself", () => {
    expect(translateHostPath(map, "/home/agent/.cache/isolade", HOME)).toBe(
      "/host/caches/dev/.cache__isolade",
    );
  });

  test("double indirection: nested cache mounts under the cached cacheDir resolve", () => {
    // The nested server's own resolveCacheMounts hostPath for a grandchild
    // cache: <guest cacheDir>/caches/<profile>/<slug>.
    expect(
      translateHostPath(map, "/home/agent/.cache/isolade/caches/acme/.cache__ccache", HOME),
    ).toBe("/host/caches/dev/.cache__isolade/caches/acme/.cache__ccache");
  });

  test("longest matching mount wins", () => {
    const nested = [
      { guestPath: "~/.local", hostPath: "/host/broad" },
      { guestPath: "~/.local/share/isolade/profiles", hostPath: "/host/specific" },
    ];
    expect(translateHostPath(nested, "/home/agent/.local/share/isolade/profiles/x", HOME)).toBe(
      "/host/specific/x",
    );
    expect(translateHostPath(nested, "/home/agent/.local/bin", HOME)).toBe("/host/broad/bin");
  });

  test("a path under no mount yields null (caller drops the volume)", () => {
    expect(translateHostPath(map, "/home/agent/.local/share/isolade/isolade.db", HOME)).toBeNull();
    expect(translateHostPath(map, "/etc/passwd", HOME)).toBeNull();
  });

  test("prefix matching is segment-aware, not string-prefix", () => {
    // ~/.cache/isolade must NOT capture ~/.cache/isolade-other.
    expect(translateHostPath(map, "/home/agent/.cache/isolade-other/x", HOME)).toBeNull();
  });
});
