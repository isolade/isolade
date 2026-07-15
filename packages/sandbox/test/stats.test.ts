import { describe, expect, it } from "bun:test";
import {
  CpuSampler,
  parseCpuTimeMs,
  VmProcessCpuSampler,
  type VmProcessSample,
} from "../src/stats";

const snap = (entries: Record<string, VmProcessSample>): Map<string, VmProcessSample> =>
  new Map(Object.entries(entries));

describe("parseCpuTimeMs", () => {
  it("parses MM:SS.ss", () => {
    expect(parseCpuTimeMs("0:13.83")).toBe(13_830);
    expect(parseCpuTimeMs("10:00.00")).toBe(600_000);
  });

  it("parses HH:MM:SS", () => {
    expect(parseCpuTimeMs("1:02:03")).toBe(3_723_000);
  });

  it("parses D-HH:MM:SS", () => {
    expect(parseCpuTimeMs("2-03:04:05")).toBe((2 * 86_400 + 3 * 3_600 + 4 * 60 + 5) * 1000);
  });

  it("degrades unparseable input to 0 instead of throwing", () => {
    expect(parseCpuTimeMs("")).toBe(0);
    expect(parseCpuTimeMs("garbage")).toBe(0);
  });
});

describe("VmProcessCpuSampler.account", () => {
  it("yields no reading on the first sample (no baseline yet)", () => {
    const s = new VmProcessCpuSampler();
    const out = s.account(snap({ a: { pid: 1, cpuMs: 0 } }), 1000);
    expect(out.size).toBe(0);
  });

  it("computes percent from the CPU-time delta over wall time", () => {
    const s = new VmProcessCpuSampler();
    s.account(snap({ a: { pid: 1, cpuMs: 0 } }), 1000);
    // 2000ms of CPU over a 2000ms wall window == one full core == 100%.
    const out = s.account(snap({ a: { pid: 1, cpuMs: 2000 } }), 3000);
    expect(out.get("a")).toBeCloseTo(100, 5);
  });

  it("reports >100% for a VM busy on multiple cores", () => {
    const s = new VmProcessCpuSampler();
    s.account(snap({ a: { pid: 1, cpuMs: 0 } }), 0);
    // 4000ms of CPU over a 2000ms wall window == two full cores == 200%.
    const out = s.account(snap({ a: { pid: 1, cpuMs: 4000 } }), 2000);
    expect(out.get("a")).toBeCloseTo(200, 5);
  });

  it("resets (no reading) when the pid changes, then resumes", () => {
    const s = new VmProcessCpuSampler();
    s.account(snap({ a: { pid: 1, cpuMs: 0 } }), 1000);
    // VM restarted: new pid, counter back near zero, so must not diff across pids.
    const restart = s.account(snap({ a: { pid: 2, cpuMs: 10 } }), 3000);
    expect(restart.has("a")).toBe(false);
    // Next tick diffs against the new pid's baseline.
    const out = s.account(snap({ a: { pid: 2, cpuMs: 1010 } }), 5000);
    expect(out.get("a")).toBeCloseTo(50, 5);
  });

  it("clamps a backwards counter to 0 rather than going negative", () => {
    const s = new VmProcessCpuSampler();
    s.account(snap({ a: { pid: 1, cpuMs: 2000 } }), 1000);
    const out = s.account(snap({ a: { pid: 1, cpuMs: 1500 } }), 3000);
    expect(out.get("a")).toBe(0);
  });

  it("drops baselines for processes that vanished (reused name starts fresh)", () => {
    const s = new VmProcessCpuSampler();
    s.account(snap({ a: { pid: 1, cpuMs: 0 }, b: { pid: 2, cpuMs: 0 } }), 0);
    // b's process is gone from this scan, so its baseline should be pruned.
    s.account(snap({ a: { pid: 1, cpuMs: 1000 } }), 1000);
    // b returns with the same pid: because its baseline was pruned, this tick
    // is treated as a first sample and yields no (stale, over-large) reading.
    const out = s.account(snap({ a: { pid: 1, cpuMs: 2000 }, b: { pid: 2, cpuMs: 5000 } }), 2000);
    expect(out.has("b")).toBe(false);
    expect(out.get("a")).toBeCloseTo(100, 5);
  });

  it("ignores a zero/negative wall delta", () => {
    const s = new VmProcessCpuSampler();
    s.account(snap({ a: { pid: 1, cpuMs: 0 } }), 1000);
    const out = s.account(snap({ a: { pid: 1, cpuMs: 500 } }), 1000);
    expect(out.has("a")).toBe(false);
  });
});

describe("CpuSampler", () => {
  it("returns a safe empty snapshot before it has ticked", () => {
    // collectSandboxStats reads snapshot() unconditionally (including in tests
    // and during the first request before any tick), so the cold-start value
    // must be well-formed (0 host, no per-VM readings → guest fallback).
    const snapshot = new CpuSampler().snapshot();
    expect(snapshot.hostCpuPercent).toBe(0);
    expect(snapshot.vmHostCpuByName.size).toBe(0);
  });
});
