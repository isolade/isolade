import { describe, expect, it } from "bun:test";
import {
  CustomError,
  RuntimeError,
  SandboxNotFoundError,
  SandboxStillRunningError,
} from "microsandbox";
import { VmManager } from "../src/vms";

// Recovery of persisted VM records at boot / restart, exercised through the
// getHandle()/startSandbox() seams so the status-driven state machine runs
// without a live microsandbox. The errors below are the REAL SDK error classes
// (matching what connect()/start() throw in production), so these tests also
// pin the code+message classification the recovery branches depend on.

type Status = "running" | "stopped" | "crashed" | "draining";

// The persisted rootfs of a stopped VM survives, so a cold-boot resumes state.
// This stub stands in for the booted/connected Sandbox that attachExisting reads
// port bindings from and that stop() syncs+stops.
class FakeSandbox {
  synced = false;
  detached = false;
  constructor(
    readonly name: string,
    // { network: { ports } } is the shape readPortsTcp parses.
    private readonly ports: {
      hostPort: number;
      guestPort: number;
      protocol?: string;
    }[] = [],
  ) {}
  async config() {
    return { network: { ports: this.ports } };
  }
  async shell(script: string) {
    if (script === "sync") this.synced = true;
    return { stdout: () => "", stderr: () => "", code: 0 };
  }
  async detach() {
    this.detached = true;
  }
}

// A persisted-record handle (microsandbox's SandboxHandle): carries a reconciled
// status and lets us connect/kill/stop by name.
class FakeHandle {
  killed = false;
  stopped = false;
  constructor(
    public status: Status,
    private readonly connectResult: FakeSandbox | Error,
  ) {}
  async connect(): Promise<FakeSandbox> {
    if (this.connectResult instanceof Error) throw this.connectResult;
    return this.connectResult;
  }
  async kill() {
    this.killed = true;
    this.status = "stopped";
  }
  async stop() {
    this.stopped = true;
    this.status = "stopped";
  }
}

// VmManager with the two microsandbox-static seams faked. getHandle/startSandbox
// consume queued results in order (an Error entry is thrown, a value is
// returned), and every call is logged so tests can assert what ran.
class Harness extends VmManager {
  readonly getHandleLog: string[] = [];
  readonly startLog: string[] = [];
  private readonly handleQueue: (FakeHandle | Error)[];
  private readonly startQueue: (FakeSandbox | Error)[];

  constructor(
    opts: {
      handles?: (FakeHandle | Error)[];
      starts?: (FakeSandbox | Error)[];
    } = {},
  ) {
    super();
    this.handleQueue = opts.handles ?? [];
    this.startQueue = opts.starts ?? [];
  }

  protected override async getHandle(vmId: string): Promise<never> {
    this.getHandleLog.push(vmId);
    const next = this.handleQueue.shift();
    if (next === undefined) throw new Error("test: no handle queued for getHandle");
    if (next instanceof Error) throw next;
    return next as unknown as never;
  }

  protected override async startSandbox(vmId: string): Promise<never> {
    this.startLog.push(vmId);
    const next = this.startQueue.shift() ?? new FakeSandbox(vmId);
    if (next instanceof Error) throw next;
    return next as unknown as never;
  }
}

const VM = "vm-1";
const noAgentEndpoint = () =>
  new RuntimeError(`runtime error: no agent endpoint found for sandbox "${VM}"`);
const notRunning = () => new CustomError(`sandbox '${VM}' is not running (status: Stopped)`);
const stillRunning = () =>
  new SandboxStillRunningError(`cannot start sandbox '${VM}': already running`);
const notFound = () => new SandboxNotFoundError(VM);

describe("VmManager.attachExisting recovery", () => {
  it("attaches to a genuinely-running VM without cold-booting", async () => {
    const sandbox = new FakeSandbox(VM, [{ hostPort: 40000, guestPort: 3000 }]);
    const mgr = new Harness({ handles: [new FakeHandle("running", sandbox)] });

    const ports = await mgr.attachExisting(VM);

    expect(mgr.startLog).toEqual([]); // no cold-boot
    expect(ports).toEqual([{ address: "127.0.0.1", localPort: 40000, remotePort: 3000 }]);
  });

  it("recovers a stale-running record (no agent endpoint) by killing + cold-booting", async () => {
    const handle = new FakeHandle("running", noAgentEndpoint());
    const booted = new FakeSandbox(VM, [{ hostPort: 41000, guestPort: 8080 }]);
    const mgr = new Harness({ handles: [handle], starts: [booted] });

    const ports = await mgr.attachExisting(VM);

    expect(handle.killed).toBe(true); // stale record reset
    expect(mgr.startLog).toEqual([VM]); // then cold-booted
    expect(ports).toEqual([{ address: "127.0.0.1", localPort: 41000, remotePort: 8080 }]);
  });

  it("cold-boots a stopped record without connecting", async () => {
    const handle = new FakeHandle("stopped", new Error("connect must not be called"));
    const mgr = new Harness({
      handles: [handle],
      starts: [new FakeSandbox(VM)],
    });

    await mgr.attachExisting(VM);

    expect(mgr.startLog).toEqual([VM]);
    expect(handle.killed).toBe(false);
  });

  it("cold-boots a crashed record", async () => {
    const handle = new FakeHandle("crashed", new Error("connect must not be called"));
    const mgr = new Harness({
      handles: [handle],
      starts: [new FakeSandbox(VM)],
    });

    await mgr.attachExisting(VM);

    expect(mgr.startLog).toEqual([VM]);
  });

  it("attaches when a concurrent caller boots the VM during a cold-boot (TOCTOU)", async () => {
    // Status reads stopped, but start() loses the race and reports still-running.
    // We re-read (now running) and attach.
    const stoppedHandle = new FakeHandle("stopped", new Error("first connect unused"));
    const runningHandle = new FakeHandle("running", new FakeSandbox(VM));
    const mgr = new Harness({
      handles: [stoppedHandle, runningHandle],
      starts: [stillRunning()],
    });

    await mgr.attachExisting(VM);

    expect(mgr.startLog).toEqual([VM]); // one (failed) start attempt
    expect(mgr.getHandleLog).toEqual([VM, VM]); // re-read after the race
  });

  it("propagates an unrecognized start failure", async () => {
    const handle = new FakeHandle("stopped", new Error("unused"));
    const mgr = new Harness({
      handles: [handle],
      starts: [new Error("image gone")],
    });

    await expect(mgr.attachExisting(VM)).rejects.toThrow("image gone");
  });

  it("propagates an unrecognized connect failure on a running record", async () => {
    const handle = new FakeHandle("running", new Error("kernel panic"));
    const mgr = new Harness({ handles: [handle] });

    await expect(mgr.attachExisting(VM)).rejects.toThrow("kernel panic");
    expect(mgr.startLog).toEqual([]); // not treated as recoverable
  });

  it("cold-boots even if resetting the stale record (kill) hiccups", async () => {
    // kill() is best-effort prep. The cold-boot is the authoritative step.
    const handle = new FakeHandle("running", noAgentEndpoint());
    handle.kill = async () => {
      throw new Error("kill glitch");
    };
    const mgr = new Harness({
      handles: [handle],
      starts: [new FakeSandbox(VM)],
    });

    await mgr.attachExisting(VM); // does not reject
    expect(mgr.startLog).toEqual([VM]);
  });

  it("propagates the boot failure when recovery genuinely cannot complete", async () => {
    const handle = new FakeHandle("running", noAgentEndpoint());
    const mgr = new Harness({
      handles: [handle],
      starts: [new Error("rootfs missing")],
    });

    await expect(mgr.attachExisting(VM)).rejects.toThrow("rootfs missing");
  });
});

describe("VmManager.stop for a record not in the live map", () => {
  it("is a silent no-op for an already-stopped record (no connect, no stop)", async () => {
    // status stopped → early return before touching the guest or the record.
    const handle = new FakeHandle("stopped", new Error("connect must not be called"));
    const mgr = new Harness({ handles: [handle] });

    await mgr.stop(VM);

    expect(handle.stopped).toBe(false);
    expect(handle.killed).toBe(false);
  });

  it("syncs the reachable guest, then stops it by name", async () => {
    const sandbox = new FakeSandbox(VM);
    const handle = new FakeHandle("running", sandbox);
    const mgr = new Harness({ handles: [handle] });

    await mgr.stop(VM);

    expect(sandbox.synced).toBe(true); // flushed before power-off
    expect(sandbox.detached).toBe(true); // sync connection released
    expect(handle.stopped).toBe(true); // stopped via the handle
  });

  it("skips the sync and still stops when the guest is unreachable", async () => {
    // Covers both the stale-running record (agent socket gone) and a race to
    // stopped: connect fails, so there's nothing to flush. We just delegate to
    // handle.stop(), which handles every sub-state itself.
    for (const connectErr of [noAgentEndpoint(), notRunning(), new Error("weird")]) {
      const handle = new FakeHandle("running", connectErr);
      const mgr = new Harness({ handles: [handle] });

      await mgr.stop(VM);

      expect(handle.stopped).toBe(true);
    }
  });

  it("is a no-op when there is no persisted record at all", async () => {
    const mgr = new Harness({ handles: [notFound()] });

    await mgr.stop(VM); // SandboxNotFound swallowed
    expect(mgr.startLog).toEqual([]);
  });

  it("never throws, even on an unexpected lookup failure (best-effort contract)", async () => {
    const mgr = new Harness({ handles: [new Error("db locked")] });

    // stop() is best-effort: an unexpected error is logged, not raised.
    await expect(mgr.stop(VM)).resolves.toBeUndefined();
  });
});
