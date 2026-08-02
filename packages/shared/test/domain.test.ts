import { describe, expect, it } from "bun:test";
import { provisionalTitle } from "../src/domain";

describe("provisionalTitle", () => {
  it("is the message on a single line", () => {
    expect(provisionalTitle("  why does my   login\nredirect loop?  ")).toBe(
      "why does my login redirect loop?",
    );
  });

  it("keeps a long message down to a sidebar-sized prefix", () => {
    const title = provisionalTitle("a".repeat(200));
    expect(title.length).toBe(60);
  });

  it("falls back to a placeholder when there is nothing to show", () => {
    // A first message can be empty: sending file attachments alone is allowed.
    expect(provisionalTitle("   \n  ")).toBe("Untitled");
  });
});
