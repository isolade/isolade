import { describe, expect, it } from "bun:test";
import { VmManager } from "../src/vms";

// A fake agent connection that faithfully models microsandbox's key property:
// RPCs serialize over a single connection. A second `shell()` on the same
// connection cannot start until the first resolves. This is exactly the
// head-of-line blocking that made one long `claude -p` turn freeze every other
// operation on a VM, so a test built on it will fail loudly if VmManager ever
// regresses to sharing one connection across operations.
class FakeConnection {
  detached = false;
  private tail: Promise<unknown> = Promise.resolve();
  inFlight = 0;
  maxInFlight = 0;

  constructor(
    readonly index: number,
    private readonly gate: (script: string) => Promise<void>,
  ) {}

  // Serialize like the real connection: chain each shell behind the previous.
  shell(script: string) {
    const run = this.tail.then(async () => {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        await this.gate(script);
        return { stdout: () => `out:${script}`, stderr: () => "", code: 0 };
      } finally {
        this.inFlight--;
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async detach() {
    this.detached = true;
  }
}

// VmManager wired to fake connections instead of a live microsandbox.
class TestVmManager extends VmManager {
  readonly connections: FakeConnection[] = [];
  reattachCount = 0;

  constructor(
    private readonly knownVmId: string,
    private readonly gate: (script: string) => Promise<void>,
  ) {
    super();
    this.seed();
  }

  // The stored sandbox is never used for execs (that's the whole point of the
  // fix), so a bare stub is enough for the VM lookup to find.
  private seed() {
    (this as unknown as { vms: Map<string, unknown> }).vms.set(this.knownVmId, {
      sandbox: {},
    });
  }

  // Simulate a sandbox restart: drop the in-memory map.
  clearVms() {
    (this as unknown as { vms: Map<string, unknown> }).vms.clear();
  }

  // Stand-in for the real reattach. Only the known VM has a "persisted
  // record"; anything else fails, exactly like attachExisting on a removed or
  // never-existed VM.
  override async attachExisting(vmId: string): Promise<never> {
    this.reattachCount++;
    if (vmId !== this.knownVmId) throw new Error(`VM ${vmId} not found`);
    this.seed();
    return [] as unknown as never;
  }

  protected override async openConnection(): Promise<never> {
    const conn = new FakeConnection(this.connections.length, this.gate);
    this.connections.push(conn);
    return conn as unknown as never;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("VmManager connection isolation", () => {
  const VM = "vm-1";

  it("does not let a long-running exec block other execs on the same VM", async () => {
    const block = deferred();
    const gate = (script: string) => (script.includes("BLOCK") ? block.promise : Promise.resolve());
    const mgr = new TestVmManager(VM, gate);

    // Start a long exec that parks until we release it.
    let longDone = false;
    const longPromise = mgr.exec(VM, "BLOCK").then((r) => {
      longDone = true;
      return r;
    });

    // A short exec issued while the long one is parked must still complete,
    // because it runs on its own connection.
    const short = await mgr.exec(VM, "echo quick");
    expect(short.stdout).toBe("out:echo quick");
    expect(longDone).toBe(false); // long is still parked

    // Release the long exec and confirm it finishes.
    block.resolve();
    const long = await longPromise;
    expect(long.stdout).toBe("out:BLOCK");

    // Each operation got its own connection, and every one was released.
    expect(mgr.connections.length).toBe(2);
    expect(mgr.connections.every((c) => c.detached)).toBe(true);
    // No single connection ever ran two operations (no HOL blocking).
    expect(mgr.connections.every((c) => c.maxInFlight <= 1)).toBe(true);
  });

  it("detaches the connection even when the operation throws", async () => {
    const gate = (script: string) =>
      script.includes("FAIL") ? Promise.reject(new Error("boom")) : Promise.resolve();
    const mgr = new TestVmManager(VM, gate);

    await expect(mgr.exec(VM, "FAIL")).rejects.toThrow("boom");
    expect(mgr.connections.length).toBe(1);
    expect(mgr.connections[0]!.detached).toBe(true);
  });

  it("rejects operations on an unknown VM before opening a connection", async () => {
    const mgr = new TestVmManager(VM, () => Promise.resolve());
    await expect(mgr.exec("nope", "echo hi")).rejects.toThrow("VM nope not found");
    expect(mgr.connections.length).toBe(0);
  });

  it("self-heals after a sandbox restart by reattaching on cache miss", async () => {
    const mgr = new TestVmManager(VM, () => Promise.resolve());
    // Simulate the sandbox process restarting: the in-memory VM map is gone,
    // but the underlying VM is still running.
    mgr.clearVms();

    const result = await mgr.exec(VM, "echo back");
    expect(result.stdout).toBe("out:echo back");
    expect(mgr.reattachCount).toBe(1);
    expect(mgr.connections.length).toBe(1);
  });

  it("dedupes concurrent reattaches into a single attach", async () => {
    const mgr = new TestVmManager(VM, () => Promise.resolve());
    mgr.clearVms();

    // Three execs race in right after the restart, but only one reattach should
    // run, the other two await it.
    await Promise.all([mgr.exec(VM, "echo a"), mgr.exec(VM, "echo b"), mgr.exec(VM, "echo c")]);
    expect(mgr.reattachCount).toBe(1);
    expect(mgr.connections.length).toBe(3);
  });

  it("coalesces a boot resync (ensure) with a concurrent exec into one attach", async () => {
    // The boot-time race that tore recovered VMs down: resync's ensure() and a
    // diff-stats probe / broker (via ensureAttached) both attaching at once.
    // They must share ONE attach so only one Sandbox handle is ever built.
    const mgr = new TestVmManager(VM, () => Promise.resolve());
    mgr.clearVms();

    const [ports] = await Promise.all([mgr.ensure(VM), mgr.exec(VM, "echo x")]);
    expect(mgr.reattachCount).toBe(1); // single attach, no rival handle
    expect(ports).toEqual([]);
  });
});
