import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SecretsStore } from "../src/secrets-store";

function tempStore(): {
  store: SecretsStore;
  pathFor: (profileId: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "isolade-secrets-"));
  const pathFor = (profileId: string) => join(root, profileId, "secrets.json");
  return { store: new SecretsStore(pathFor), pathFor };
}

describe("SecretsStore", () => {
  it("round-trips set → get → has → delete, keyed per profile + env", async () => {
    const { store } = tempStore();

    expect(await store.get("ws1", "GH_TOKEN")).toBeNull();
    expect(await store.has("ws1", "GH_TOKEN")).toBe(false);

    await store.set("ws1", "GH_TOKEN", "secret-a");
    expect(await store.get("ws1", "GH_TOKEN")).toBe("secret-a");
    expect(await store.has("ws1", "GH_TOKEN")).toBe(true);

    // A second env in the same profile coexists in the same file.
    await store.set("ws1", "LINEAR_API_KEY", "secret-lin");
    expect(await store.get("ws1", "GH_TOKEN")).toBe("secret-a");
    expect(await store.get("ws1", "LINEAR_API_KEY")).toBe("secret-lin");

    // Same env in a different profile is independent.
    expect(await store.has("ws2", "GH_TOKEN")).toBe(false);
    await store.set("ws2", "GH_TOKEN", "secret-b");
    expect(await store.get("ws2", "GH_TOKEN")).toBe("secret-b");
    expect(await store.get("ws1", "GH_TOKEN")).toBe("secret-a");

    expect(await store.delete("ws1", "GH_TOKEN")).toBe(true);
    expect(await store.has("ws1", "GH_TOKEN")).toBe(false);
    // Deleting again is a no-op (false). Sibling + other-profile values survive.
    expect(await store.delete("ws1", "GH_TOKEN")).toBe(false);
    expect(await store.get("ws1", "LINEAR_API_KEY")).toBe("secret-lin");
    expect(await store.get("ws2", "GH_TOKEN")).toBe("secret-b");
  });

  it("writes the secrets file with 0600 perms", async () => {
    const { store, pathFor } = tempStore();
    await store.set("ws1", "GH_TOKEN", "secret-a");
    const mode = statSync(pathFor("ws1")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("treats a corrupt secrets file as 'not set' rather than throwing", async () => {
    const { store, pathFor } = tempStore();
    const path = pathFor("ws1");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json");

    expect(await store.get("ws1", "API_KEY")).toBeNull();
    expect(await store.has("ws1", "API_KEY")).toBe(false);
  });
});
