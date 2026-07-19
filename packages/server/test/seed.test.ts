import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, type Db, schema } from "../src/db";
import { profileDir } from "../src/profile-config";
import { importSeedProfiles, removeSeedStaging, seedStagingDir, stageSeed } from "../src/seed";

// Both halves of the seed contract against isolated XDG roots: stageSeed reads
// configDir and writes stateDir on the "host", importSeedProfiles writes
// configDir and the DB in the "guest". Using one XDG root for both sides keeps
// the test simple; the bundle dir stands in for the guest's SEED_MOUNT.
let root: string;
let prev: Map<string, string | undefined>;
let db: Db;

const XDG_VARS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "isolade-seed-"));
  prev = new Map(XDG_VARS.map((v) => [v, process.env[v]] as const));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.XDG_STATE_HOME = join(root, "state");
  db = createDb(":memory:");
});

afterEach(() => {
  for (const [v, value] of prev) {
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function writeProfileFixture(id: string, name: string): void {
  mkdirSync(profileDir(id), { recursive: true });
  writeFileSync(join(profileDir(id), "config.toml"), `name = ${JSON.stringify(name)}\n`);
  writeFileSync(join(profileDir(id), "Dockerfile"), "FROM scratch\n");
}

function profileRow(id: string) {
  return db.select().from(schema.profiles).where(eq(schema.profiles.id, id)).get();
}

describe("stageSeed", () => {
  test("stages config-dir copies plus a manifest, and restages idempotently", () => {
    writeProfileFixture("acme", "Acme");
    const dir = stageSeed("inst-1", [{ id: "acme", name: "Acme", image: "ref-1" }]);
    expect(dir).toBe(seedStagingDir("inst-1"));
    expect(readFileSync(join(dir, "profiles", "acme", "config.toml"), "utf8")).toContain("Acme");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest).toEqual({
      version: 1,
      profiles: { acme: { name: "Acme", image: "ref-1" } },
    });

    // A leftover staging dir from a crashed create is replaced wholesale.
    const again = stageSeed("inst-1", []);
    expect(existsSync(join(again, "profiles", "acme"))).toBe(false);

    removeSeedStaging("inst-1");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("importSeedProfiles", () => {
  function stageBundle(): string {
    writeProfileFixture("acme", "Acme");
    const bundle = stageSeed("inst-1", [{ id: "acme", name: "Acme", image: "ref-1" }]);
    // The "guest" starts without the profile: drop the host-side config dir so
    // the import genuinely materializes it from the bundle.
    rmSync(profileDir("acme"), { recursive: true, force: true });
    return bundle;
  }

  test("no-ops when the mount is absent", () => {
    importSeedProfiles(db, join(root, "does-not-exist"));
    expect(db.select().from(schema.profiles).all()).toEqual([]);
  });

  test("imports config dir + READY row with the seeded image ref", () => {
    const bundle = stageBundle();
    importSeedProfiles(db, bundle);
    expect(existsSync(join(profileDir("acme"), "config.toml"))).toBe(true);
    const row = profileRow("acme");
    expect(row?.status).toBe("ready");
    expect(row?.image).toBe("ref-1");
    expect(row?.name).toBe("Acme");
  });

  test("re-import never downgrades a newer in-guest build", () => {
    const bundle = stageBundle();
    importSeedProfiles(db, bundle);
    // The nested instance rebuilt the profile and memoized a newer ref.
    db.update(schema.profiles).set({ image: "ref-2" }).where(eq(schema.profiles.id, "acme")).run();
    importSeedProfiles(db, bundle);
    expect(profileRow("acme")?.image).toBe("ref-2");
  });

  test("re-import leaves an existing config dir untouched", () => {
    const bundle = stageBundle();
    importSeedProfiles(db, bundle);
    writeFileSync(join(profileDir("acme"), "config.toml"), `name = "Edited inside"\n`);
    importSeedProfiles(db, bundle);
    expect(readFileSync(join(profileDir("acme"), "config.toml"), "utf8")).toContain(
      "Edited inside",
    );
  });

  test("skips manifest entries with invalid ids or missing bundle dirs", () => {
    const bundle = stageBundle();
    const manifest = {
      version: 1,
      profiles: {
        "../escape": { name: "evil", image: "x" },
        ghost: { name: "ghost", image: "y" },
        acme: { name: "Acme", image: "ref-1" },
      },
    };
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest));
    importSeedProfiles(db, bundle);
    expect(profileRow("acme")?.image).toBe("ref-1");
    expect(profileRow("ghost")).toBeUndefined();
    expect(db.select().from(schema.profiles).all()).toHaveLength(1);
  });

  test("an unparseable manifest aborts the import without throwing", () => {
    const bundle = stageBundle();
    writeFileSync(join(bundle, "manifest.json"), "not json");
    importSeedProfiles(db, bundle);
    expect(db.select().from(schema.profiles).all()).toEqual([]);
  });
});
