import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addToKeepSet,
  dropVmOwner,
  HOST_CLIENT_ID,
  keepUnion,
  listClientIds,
  recordVmOwner,
  removeClientEntry,
  setKeepSet,
  vmsOwnedBy,
} from "../src/clients";

// The registry resolves its file from stateDir() on every operation, so
// re-rooting XDG_STATE_HOME per test isolates it completely.
let root: string;
let prevStateHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "isolade-clients-"));
  prevStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
});

afterEach(() => {
  if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prevStateHome;
  rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  return join(root, "isolade", "sandbox-clients.json");
}

describe("keep-sets", () => {
  test("union spans every registered client", () => {
    setKeepSet(HOST_CLIENT_ID, ["ref-a", "ref-b"]);
    setKeepSet("dev-vm-1", ["ref-b", "ref-c"]);
    expect(keepUnion().toSorted()).toEqual(["ref-a", "ref-b", "ref-c"]);
  });

  test("registration replaces, so a client's stale refs age out of the union", () => {
    setKeepSet("dev-vm-1", ["old-ref"]);
    setKeepSet("dev-vm-1", ["new-ref"]);
    expect(keepUnion()).toEqual(["new-ref"]);
  });

  test("addToKeepSet appends without disturbing the rest, and dedupes", () => {
    setKeepSet("dev-vm-1", ["ref-a"]);
    addToKeepSet("dev-vm-1", "ref-fresh");
    addToKeepSet("dev-vm-1", "ref-fresh");
    addToKeepSet("dev-vm-2", "ref-other");
    expect(keepUnion().toSorted()).toEqual(["ref-a", "ref-fresh", "ref-other"]);
  });

  test("empty registry yields an empty union", () => {
    expect(keepUnion()).toEqual([]);
  });
});

describe("vm ownership", () => {
  test("records non-host owners and answers vmsOwnedBy", () => {
    recordVmOwner("vm-1", "dev-vm-1");
    recordVmOwner("vm-2", "dev-vm-1");
    recordVmOwner("vm-3", "dev-vm-2");
    expect(vmsOwnedBy("dev-vm-1").toSorted()).toEqual(["vm-1", "vm-2"]);
    expect(vmsOwnedBy("dev-vm-2")).toEqual(["vm-3"]);
  });

  test("host-owned VMs are not recorded", () => {
    recordVmOwner("vm-host", HOST_CLIENT_ID);
    expect(existsSync(storePath())).toBe(false);
    expect(vmsOwnedBy(HOST_CLIENT_ID)).toEqual([]);
  });

  test("dropVmOwner forgets one VM", () => {
    recordVmOwner("vm-1", "dev-vm-1");
    recordVmOwner("vm-2", "dev-vm-1");
    dropVmOwner("vm-1");
    expect(vmsOwnedBy("dev-vm-1")).toEqual(["vm-2"]);
  });

  test("dropVmOwner for an unknown VM is a no-op that creates no file", () => {
    dropVmOwner("vm-unknown");
    expect(existsSync(storePath())).toBe(false);
  });
});

describe("listClientIds", () => {
  test("unions keep-set owners and VM owners", () => {
    setKeepSet(HOST_CLIENT_ID, ["ref-a"]);
    setKeepSet("dev-vm-1", ["ref-b"]);
    // A client known only through a straggler VM (its keep-set already
    // dropped) must still be listed so the boot sweep can retry it.
    recordVmOwner("vm-1", "dev-vm-2");
    expect(listClientIds().toSorted()).toEqual(["dev-vm-1", "dev-vm-2", HOST_CLIENT_ID]);
  });
});

describe("client removal", () => {
  test("drops the keep-set and every ownership row of that client only", () => {
    setKeepSet("dev-vm-1", ["ref-a"]);
    setKeepSet("dev-vm-2", ["ref-b"]);
    recordVmOwner("vm-1", "dev-vm-1");
    recordVmOwner("vm-2", "dev-vm-2");
    removeClientEntry("dev-vm-1");
    expect(keepUnion()).toEqual(["ref-b"]);
    expect(vmsOwnedBy("dev-vm-1")).toEqual([]);
    expect(vmsOwnedBy("dev-vm-2")).toEqual(["vm-2"]);
  });
});

describe("resilience", () => {
  test("a corrupt store is set aside and treated as empty", () => {
    setKeepSet("dev-vm-1", ["ref-a"]);
    writeFileSync(storePath(), "not json{{{");
    expect(keepUnion()).toEqual([]);
    // The corrupt content was preserved for post-mortem.
    expect(readFileSync(`${storePath()}.corrupt`, "utf8")).toBe("not json{{{");
    // And the registry is writable again.
    setKeepSet("dev-vm-1", ["ref-b"]);
    expect(keepUnion()).toEqual(["ref-b"]);
  });
});
