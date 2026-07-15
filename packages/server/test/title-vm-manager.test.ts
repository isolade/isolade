import { describe, expect, it } from "bun:test";
import { createDb, schema } from "../src/db";
import type { ProfileManager } from "../src/profiles";
import type { SandboxApi } from "../src/sandbox-client";
import { ActiveProfileTracker, TitleVmManager } from "../src/title-vm-manager";

// A sandbox that only implements what TitleVmManager + seedVmAuth touch:
// createVm (hands out vm-1, vm-2, …), destroyVm/writeFile/exec (record / no-op).
function fakeSandbox() {
  const created: string[] = [];
  const destroyed: string[] = [];
  let n = 0;
  const api = {
    async createVm() {
      const vmId = `vm-${++n}`;
      created.push(vmId);
      return { vmId, ports: [] };
    },
    async destroyVm(vmId: string) {
      destroyed.push(vmId);
    },
    async writeFile() {},
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  } as unknown as SandboxApi;
  return { api, created, destroyed };
}

// A profile manager stub: every profile has a built image and trivial
// auth/network stores. Enough for TitleVmManager, which only reads image, the
// auth dir, and the network policy.
function fakeProfiles(): ProfileManager {
  return {
    get: (id: string) => ({ id, image: `img-${id}` }),
    auth: () => ({ ensureDir() {}, dir: () => "/tmp/auth" }),
    network: () => ({ read: () => ({}) }),
  } as unknown as ProfileManager;
}

describe("TitleVmManager", () => {
  it("acquires a warm VM, is idempotent, and exposes its id", async () => {
    const db = createDb(":memory:");
    const { api, created } = fakeSandbox();
    const mgr = new TitleVmManager(db, api, fakeProfiles());

    expect(mgr.getReadyVmId("p1")).toBeNull();
    await mgr.acquire("p1");
    expect(mgr.getReadyVmId("p1")).toBe("vm-1");

    // Second acquire reuses the warm VM, with no second createVm.
    await mgr.acquire("p1");
    expect(created).toEqual(["vm-1"]);
    expect(mgr.getReadyVmId("p1")).toBe("vm-1");

    // Persisted so a crashed server can reap it.
    const rows = db.select().from(schema.titleVms).all();
    expect(rows).toEqual([expect.objectContaining({ profileId: "p1", vmId: "vm-1" })]);
  });

  it("releases the VM: destroys it, forgets it, and clears the row", async () => {
    const db = createDb(":memory:");
    const { api, destroyed } = fakeSandbox();
    const mgr = new TitleVmManager(db, api, fakeProfiles());

    await mgr.acquire("p1");
    await mgr.release("p1");

    expect(destroyed).toEqual(["vm-1"]);
    expect(mgr.getReadyVmId("p1")).toBeNull();
    expect(db.select().from(schema.titleVms).all()).toEqual([]);
  });

  it("reaps orphaned VMs left in the table by a prior run", async () => {
    const db = createDb(":memory:");
    const { api, destroyed } = fakeSandbox();
    db.insert(schema.titleVms).values({ profileId: "p1", vmId: "vm-orphan" }).run();

    const mgr = new TitleVmManager(db, api, fakeProfiles());
    await mgr.reapOrphans();

    expect(destroyed).toEqual(["vm-orphan"]);
    expect(db.select().from(schema.titleVms).all()).toEqual([]);
  });

  it("skips profiles with no built image", async () => {
    const db = createDb(":memory:");
    const { api, created } = fakeSandbox();
    const profiles = {
      get: () => ({ id: "p1", image: null }),
    } as unknown as ProfileManager;
    const mgr = new TitleVmManager(db, api, profiles);

    await mgr.acquire("p1");
    expect(created).toEqual([]);
    expect(mgr.getReadyVmId("p1")).toBeNull();
  });
});

describe("ActiveProfileTracker", () => {
  // Records acquire/release rather than touching VMs, so we can assert the
  // reference-counting decisions directly and synchronously.
  function recordingTitleVms() {
    const acquired: string[] = [];
    const released: string[] = [];
    const titleVms = {
      acquire: async (p: string) => void acquired.push(p),
      release: async (p: string) => void released.push(p),
    } as unknown as TitleVmManager;
    return { titleVms, acquired, released };
  }

  it("warms on activate, releases the old profile only when no window holds it", () => {
    const { titleVms, acquired, released } = recordingTitleVms();
    const tracker = new ActiveProfileTracker(titleVms);

    tracker.activate("c1", "A"); // c1: A
    tracker.activate("c2", "A"); // c2: A (A still held by both)
    tracker.activate("c1", "B"); // c1 moves A→B, A still held by c2 → no release
    tracker.activate("c2", "B"); // c2 moves A→B, A now unused → release A

    expect(acquired).toEqual(["A", "A", "B", "B"]);
    expect(released).toEqual(["A"]);
  });

  it("releases a profile on deactivate once its last window leaves", () => {
    const { titleVms, released } = recordingTitleVms();
    const tracker = new ActiveProfileTracker(titleVms);

    tracker.activate("c1", "A");
    tracker.activate("c2", "A");
    tracker.deactivate("c1"); // A still held by c2 → no release
    expect(released).toEqual([]);
    tracker.deactivate("c2"); // last holder gone → release A
    expect(released).toEqual(["A"]);
  });
});
