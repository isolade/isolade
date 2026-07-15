import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execSync } from "child_process";
import { schema } from "../src/db";
import type { SandboxApi } from "../src/sandbox-client";
import { createTestServer } from "./helpers";

// Records the VM-lifecycle calls the archive flow makes, so a no-VM test can
// assert "archive stops (not destroys)" and "clear destroys". Everything else
// returns benign values so restart()'s auth/git plumbing runs without a VM.
function recordingSandbox(calls: string[]): SandboxApi {
  return {
    async createVm() {
      return { vmId: "vm", ports: [] };
    },
    async destroyVm(vmId: string) {
      calls.push(`destroy:${vmId}`);
    },
    async stopVm(vmId: string) {
      calls.push(`stop:${vmId}`);
    },
    async restartVm(vmId: string) {
      calls.push(`restart:${vmId}`);
      return { vmId, ports: [] };
    },
    async ensureVm(vmId: string) {
      return { vmId, ports: [] };
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async writeFile() {},
    async execStream() {
      return { exitCode: 0 };
    },
    async execInteractive() {
      return { exitCode: 0 };
    },
    async build() {
      return "";
    },
    async getStats() {
      return {};
    },
    async waitUntilReady() {
      return true;
    },
    async garbageCollect() {},
  } as unknown as SandboxApi;
}

// Requires a real microsandbox VM + a built workspace image, so it's gated
// behind RUN_INTEGRATION. Unit-test runs without VM infrastructure skip it.
describe.skipIf(!process.env.RUN_INTEGRATION)("instance lifecycle", () => {
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

  it("create → list → get → delete → verify gone", async () => {
    // Create
    const createRes = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-instance" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      name: string;
      vmId: string;
    };
    expect(created.name).toBe("test-instance");
    expect(created.vmId).toBeTruthy();

    // List
    const listRes = await fetch(`${baseUrl}/api/instances`);
    const list = (await listRes.json()) as { id: string }[];
    expect(list.some((i) => i.id === created.id)).toBe(true);

    // Get
    const getRes = await fetch(`${baseUrl}/api/instances/${created.id}`);
    const got = (await getRes.json()) as { id: string; name: string };
    expect(got.name).toBe("test-instance");

    // Delete
    const deleteRes = await fetch(`${baseUrl}/api/instances/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    // Verify gone
    const goneRes = await fetch(`${baseUrl}/api/instances/${created.id}`);
    expect(goneRes.status).toBe(404);
  }, 60_000);

  it("preserves git config user.name and user.email from host", async () => {
    let hostName = "";
    let hostEmail = "";
    try {
      hostName = execSync("git config --global user.name", {
        encoding: "utf-8",
      }).trim();
    } catch {}
    try {
      hostEmail = execSync("git config --global user.email", {
        encoding: "utf-8",
      }).trim();
    } catch {}

    if (!hostName && !hostEmail) {
      console.log("Skipping: no git user.name or user.email configured on host");
      return;
    }

    const createRes = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "git-config-test" }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    try {
      if (hostName) {
        const res = await fetch(`${baseUrl}/api/instances/${id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "git config --global user.name" }),
        });
        const { stdout } = (await res.json()) as { stdout: string };
        expect(stdout.trim()).toBe(hostName);
      }

      if (hostEmail) {
        const res = await fetch(`${baseUrl}/api/instances/${id}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "git config --global user.email" }),
        });
        const { stdout } = (await res.json()) as { stdout: string };
        expect(stdout.trim()).toBe(hostEmail);
      }
    } finally {
      await fetch(`${baseUrl}/api/instances/${id}`, { method: "DELETE" });
    }
  }, 60_000);
});

// 404 paths don't need a VM, so they run in every test pass.
describe("instance 404 paths", () => {
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

  it("returns 404 for unknown instance", async () => {
    const res = await fetch(`${baseUrl}/api/instances/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting unknown instance", async () => {
    const res = await fetch(`${baseUrl}/api/instances/nonexistent`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

// Archive lifecycle drives only the DB + the sandbox stop/restart/destroy
// calls, so a recording fake sandbox lets it run every pass (no real VM).
describe("instance archive lifecycle", () => {
  let server: ReturnType<typeof createTestServer>;
  let baseUrl: string;
  let calls: string[];

  beforeAll(() => {
    calls = [];
    server = createTestServer({ sandbox: recordingSandbox(calls) });
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await server.cleanup();
  });

  const seed = (id: string, profileId: string | null) => {
    server.db
      .insert(schema.instances)
      .values({
        id,
        vmId: `vm-${id}`,
        title: id,
        status: "running",
        image: "img",
        profileId,
      })
      .run();
  };

  it("archives (stops, not destroys), then unarchives (restarts)", async () => {
    seed("arch-1", "p1");
    calls.length = 0;

    const archiveRes = await fetch(`${baseUrl}/api/instances/arch-1/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as {
      archived: boolean;
      status: string;
    };
    expect(archived.archived).toBe(true);
    expect(archived.status).toBe("stopped");
    // Stopped, never destroyed. The VM record must survive for unarchive.
    expect(calls).toContain("stop:vm-arch-1");
    expect(calls).not.toContain("destroy:vm-arch-1");

    // Still listed (hidden by the client, present on the server) and archived.
    const listed = (await (await fetch(`${baseUrl}/api/instances`)).json()) as {
      id: string;
      archived: boolean;
    }[];
    expect(listed.find((i) => i.id === "arch-1")?.archived).toBe(true);

    calls.length = 0;
    const unarchiveRes = await fetch(`${baseUrl}/api/instances/arch-1/unarchive`, {
      method: "POST",
    });
    expect(unarchiveRes.status).toBe(200);
    const unarchived = (await unarchiveRes.json()) as {
      archived: boolean;
      status: string;
    };
    expect(unarchived.archived).toBe(false);
    expect(unarchived.status).toBe("running");
    expect(calls).toContain("restart:vm-arch-1");
  });

  it("clears only the given profile's archived chats", async () => {
    seed("clr-a", "pA");
    seed("clr-b", "pA");
    seed("clr-c", "pB");
    for (const id of ["clr-a", "clr-b", "clr-c"]) {
      await fetch(`${baseUrl}/api/instances/${id}/archive`, { method: "POST" });
    }
    calls.length = 0;

    const res = await fetch(`${baseUrl}/api/instances/archive/clear?profile=pA`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const cleared = (await res.json()) as { ok: boolean; cleared: number };
    expect(cleared).toEqual({ ok: true, cleared: 2 });
    // pA's archived chats are destroyed. pB's is untouched.
    expect(calls).toContain("destroy:vm-clr-a");
    expect(calls).toContain("destroy:vm-clr-b");
    expect(calls).not.toContain("destroy:vm-clr-c");

    expect((await fetch(`${baseUrl}/api/instances/clr-a`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/instances/clr-b`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/instances/clr-c`)).status).toBe(200);
  });

  it("pins/unpins without touching the VM, and archiving clears the pin", async () => {
    seed("pin-1", "p1");
    calls.length = 0;

    const pinRes = await fetch(`${baseUrl}/api/instances/pin-1/pin`, { method: "POST" });
    expect(pinRes.status).toBe(200);
    const pinned = (await pinRes.json()) as { pinned: boolean; status: string };
    expect(pinned.pinned).toBe(true);
    // Pinning is presentational: the VM is never stopped/restarted/destroyed.
    expect(pinned.status).toBe("running");
    expect(calls).toEqual([]);

    const unpinRes = await fetch(`${baseUrl}/api/instances/pin-1/unpin`, { method: "POST" });
    expect(unpinRes.status).toBe(200);
    expect(((await unpinRes.json()) as { pinned: boolean }).pinned).toBe(false);
    expect(calls).toEqual([]);

    // Archiving a pinned chat clears the pin (a chat is pinned XOR archived).
    await fetch(`${baseUrl}/api/instances/pin-1/pin`, { method: "POST" });
    const archiveRes = await fetch(`${baseUrl}/api/instances/pin-1/archive`, { method: "POST" });
    const archived = (await archiveRes.json()) as { pinned: boolean; archived: boolean };
    expect(archived.archived).toBe(true);
    expect(archived.pinned).toBe(false);
  });

  it("404s archiving / unarchiving an unknown instance", async () => {
    expect((await fetch(`${baseUrl}/api/instances/nope/archive`, { method: "POST" })).status).toBe(
      404,
    );
    expect(
      (
        await fetch(`${baseUrl}/api/instances/nope/unarchive`, {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  it("refuses an unscoped clear: no profile can wipe another's archive", async () => {
    seed("clr-guard", "pC");
    await fetch(`${baseUrl}/api/instances/clr-guard/archive`, {
      method: "POST",
    });
    calls.length = 0;

    const res = await fetch(`${baseUrl}/api/instances/archive/clear`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    expect((await fetch(`${baseUrl}/api/instances/clr-guard`)).status).toBe(200);
  });

  // The sandbox layer self-heals VM-touching calls by booting VMs missing
  // from its map, which is exactly what an archived (deliberately stopped) VM must
  // never do. These routes must refuse up front, before any sandbox call.
  it("409s VM-touching routes on an archived chat instead of booting its VM", async () => {
    seed("arch-guard", "p1");
    await fetch(`${baseUrl}/api/instances/arch-guard/archive`, {
      method: "POST",
    });
    calls.length = 0;

    const post = (path: string, body?: unknown) =>
      fetch(`${baseUrl}/api/instances/arch-guard/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    expect((await post("restart")).status).toBe(409);
    expect((await post("exec", { command: "true" })).status).toBe(409);
    expect((await post("terminals", { kind: "shell" })).status).toBe(409);
    expect((await fetch(`${baseUrl}/api/instances/arch-guard/files`)).status).toBe(409);
    expect((await fetch(`${baseUrl}/api/instances/arch-guard/diff`)).status).toBe(409);
    expect((await fetch(`${baseUrl}/api/instances/arch-guard/port-status`)).status).toBe(409);
    // Nothing above reached the sandbox lifecycle API.
    expect(calls).toEqual([]);

    // Viewing stays possible: the DB-backed transcript reads are untouched.
    expect((await fetch(`${baseUrl}/api/instances/arch-guard`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/instances/arch-guard/chats`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/instances/arch-guard/terminals`)).status).toBe(200);
  });
});

// Ordering is pure DB query logic with no VM needed, so it runs every pass.
describe("instance list ordering", () => {
  let server: ReturnType<typeof createTestServer>;

  beforeAll(() => {
    server = createTestServer();
  });

  afterAll(async () => {
    await server.cleanup();
  });

  const at = (seconds: number) => new Date(seconds * 1000);

  it("orders by updatedAt desc, then createdAt desc, then id, total & stable", () => {
    const { db, instances } = server;
    // Inserted in scrambled order to prove the result doesn't depend on it.
    // The T2 group (i-a/i-b/i-d) all share updatedAt and must be disambiguated
    // by createdAt then id. i-c sits in an older second.
    const rows = [
      { id: "i-d", updatedAt: at(2000), createdAt: at(8000) }, // ties i-a fully → id breaks it
      { id: "i-c", updatedAt: at(1000), createdAt: at(5000) }, // older updatedAt → last
      { id: "i-b", updatedAt: at(2000), createdAt: at(9000) }, // newest createdAt in T2 → first
      { id: "i-a", updatedAt: at(2000), createdAt: at(8000) },
    ];
    for (const r of rows) {
      db.insert(schema.instances)
        .values({
          id: r.id,
          vmId: `vm-${r.id}`,
          status: "running",
          image: "test-image",
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })
        .run();
    }

    const expected = ["i-b", "i-a", "i-d", "i-c"];
    expect(instances.list().map((i) => i.id)).toEqual(expected);
    // Stable: a second identical call returns the same order.
    expect(instances.list().map((i) => i.id)).toEqual(expected);
  });

  it("distinguishes sub-second activity (ms precision, not seconds)", () => {
    const { db, instances } = server;
    // Two turns finishing in the same wall-clock second, 300ms apart. Under the
    // old second-precision storage both floored to the same value and tied.
    // Millisecond storage keeps them distinct so the newer one sorts first.
    db.insert(schema.instances)
      .values({
        id: "ms-older",
        vmId: "vm-1",
        status: "running",
        image: "img",
        updatedAt: new Date(1_000_500),
      })
      .run();
    db.insert(schema.instances)
      .values({
        id: "ms-newer",
        vmId: "vm-2",
        status: "running",
        image: "img",
        updatedAt: new Date(1_000_800),
      })
      .run();

    const list = instances.list();
    const order = list.map((i) => i.id);
    expect(order.indexOf("ms-newer")).toBeLessThan(order.indexOf("ms-older"));
    // The value really is millisecond-granular, not floored to a second.
    const newer = list.find((i) => i.id === "ms-newer");
    expect(newer?.updatedAt.getTime()).toBe(1_000_800);
  });
});
