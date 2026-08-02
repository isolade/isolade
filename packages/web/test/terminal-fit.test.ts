import { describe, expect, it } from "bun:test";
import { isMeasurable } from "../src/components/Terminal";

// A terminal tab that is not the selected one is kept mounted behind
// display:none, and FitAddon cannot tell that apart: it sizes the grid from
// getComputedStyle(container), which inside a display:none subtree hands back
// the computed "100%" of h-full/w-full rather than a used pixel length, and its
// parseInt reads that as 100px. The grid it then proposes (14x9) does not stay
// in the browser, because term.onResize forwards it to the PTY, so a shell
// behind an off-screen tab gets SIGWINCH'd to 14 columns and redraws at that
// width. The layout box is what tells the two apart, and every size we either
// fit to or report to the PTY is gated on it.
describe("isMeasurable", () => {
  it("accepts a container that has a layout box", () => {
    expect(isMeasurable({ clientWidth: 1268, clientHeight: 593 })).toBe(true);
  });

  it("rejects a container inside a display:none tab body", () => {
    expect(isMeasurable({ clientWidth: 0, clientHeight: 0 })).toBe(false);
  });

  it("rejects a panel slot collapsed along one axis", () => {
    expect(isMeasurable({ clientWidth: 0, clientHeight: 593 })).toBe(false);
    expect(isMeasurable({ clientWidth: 1268, clientHeight: 0 })).toBe(false);
  });

  it("rejects a container that has not mounted yet", () => {
    expect(isMeasurable(null)).toBe(false);
  });
});
