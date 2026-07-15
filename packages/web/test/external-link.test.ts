import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { onExternalLinkClick } from "../src/lib/tauri";

// onExternalLinkClick is the per-element replacement for the document-level
// delegate: inside WKWebView a target="_blank" click otherwise no-ops (the
// window.open path is dead and the delegated listener isn't reached reliably),
// so an anchor handles its own click and hands the URL to the host. These tests
// pin the guard contract (which clicks route to the host vs. which pass through
// to the webview/browser), since that branching is the whole point of the fix.

type ClickArg = Parameters<typeof onExternalLinkClick>[0];

// Records invoke() calls so we can assert the URL was handed to the host.
const invokeCalls: { cmd: string; args: unknown }[] = [];
// Bun has no window, so save whatever is there and restore it so we don't leak the
// stub into other test files sharing the process.
const originalWindow = (globalThis as { window?: unknown }).window;

function stubTauriWindow(native: boolean) {
  (globalThis as { window?: unknown }).window = native
    ? {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: unknown) => {
            invokeCalls.push({ cmd, args });
            return Promise.resolve();
          },
        },
      }
    : {}; // a plain browser: no __TAURI_INTERNALS__
}

// Minimal stand-in for a React click event. Tracks whether the anchor's default
// (the navigation we want to suppress under Tauri) was cancelled.
function fakeClick(overrides: Partial<Record<keyof ClickArg, unknown>> = {}) {
  const e = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {
      (e as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    ...overrides,
  };
  return e as unknown as ClickArg;
}

// openExternal dynamically imports @tauri-apps/api/core, so the invoke lands a
// few ticks after the handler returns, so give it a macrotask to settle.
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeAll(async () => {
  stubTauriWindow(true);
  // Warm the dynamic import openExternal does, so its first invoke isn't racing
  // a cold module load past the per-test flush (which leaked across tests).
  await import("@tauri-apps/api/core");
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("onExternalLinkClick", () => {
  it("routes a plain left click to the host and suppresses navigation", async () => {
    invokeCalls.length = 0;
    const e = fakeClick();
    onExternalLinkClick(e, "https://example.com/");
    expect(e.defaultPrevented).toBe(true);
    await flush();
    expect(invokeCalls).toEqual([{ cmd: "open_url", args: { url: "https://example.com/" } }]);
  });

  it("leaves modifier and middle clicks to the webview", async () => {
    for (const mod of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 }, // middle click
    ]) {
      invokeCalls.length = 0;
      const e = fakeClick(mod);
      onExternalLinkClick(e, "https://example.com/");
      expect(e.defaultPrevented).toBe(false);
      await flush();
      expect(invokeCalls).toHaveLength(0);
    }
  });

  it("does nothing for an already-handled event or a missing href", async () => {
    invokeCalls.length = 0;
    const handled = fakeClick({ defaultPrevented: true });
    onExternalLinkClick(handled, "https://example.com/");

    const noHref = fakeClick();
    onExternalLinkClick(noHref, undefined);
    expect(noHref.defaultPrevented).toBe(false);

    await flush();
    expect(invokeCalls).toHaveLength(0);
  });

  it("does not intercept in a plain browser (native target=_blank works)", async () => {
    stubTauriWindow(false);
    invokeCalls.length = 0;
    const e = fakeClick();
    onExternalLinkClick(e, "https://example.com/");
    expect(e.defaultPrevented).toBe(false);
    await flush();
    expect(invokeCalls).toHaveLength(0);
    stubTauriWindow(true);
  });
});
