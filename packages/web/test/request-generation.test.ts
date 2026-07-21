import { describe, expect, it } from "bun:test";
import { RequestGeneration } from "../src/lib/request-generation";

describe("RequestGeneration", () => {
  it("aborts and rejects every response from a replaced transcript", () => {
    const requests = new RequestGeneration();
    const firstGeneration = requests.invalidate();
    const hydration = requests.createController();
    const olderPage = requests.createController();

    expect(requests.accepts(firstGeneration, hydration)).toBe(true);
    const branchGeneration = requests.invalidate();

    expect(hydration.signal.aborted).toBe(true);
    expect(olderPage.signal.aborted).toBe(true);
    expect(requests.accepts(firstGeneration, hydration)).toBe(false);

    const branch = requests.createController();
    expect(requests.accepts(branchGeneration, branch)).toBe(true);
  });

  it("rejects a late response even when its transport ignores abort", () => {
    const requests = new RequestGeneration();
    const staleGeneration = requests.invalidate();
    const stale = requests.createController();
    requests.release(stale);

    const currentGeneration = requests.invalidate();
    const current = requests.createController();

    expect(stale.signal.aborted).toBe(false);
    expect(requests.accepts(staleGeneration, stale)).toBe(false);
    expect(requests.accepts(currentGeneration, current)).toBe(true);
  });
});
