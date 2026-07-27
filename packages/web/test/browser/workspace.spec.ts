import { expect, type Page, test } from "@playwright/test";

// A large-but-plausible working set: every instance keeps two panels open, and
// every assistant turn carries a reasoning block, one or two tool cards, and
// Markdown with fenced code. All of it stays retained off screen, so these
// numbers are the cost the user pays for chats they are not looking at.
const INSTANCES = 10;
const CHATS_PER_INSTANCE = 2;
const MESSAGES_PER_CHAT = 250;
const MOUNTED_BODIES = INSTANCES * CHATS_PER_INSTANCE;

// Every timing below presses something and reads the clock two animation frames
// later, so ~33ms is the floor even for a no-op.
//
// The primary assertion is a same-page A/B rather than a millisecond budget: the
// harness can put the off-screen panes back into the rendering path, which is
// exactly what the fix takes them out of. Comparing the two on one page survives
// a slow CI runner, where an absolute budget would either flake or be loosened
// until it stopped meaning anything. A generous absolute ceiling still catches a
// change that makes everything slow.
const SKIPPED_SHARE_OF_LAID_OUT = 0.6;
const NO_REGRESSION_MARGIN = 1.3;
const INTERACTION_CEILING_MS = 200;

function median(samples: number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto(
    `/test/browser/harness/index.html?workspace=1&instances=${INSTANCES}` +
      `&chatsPerInstance=${CHATS_PER_INSTANCE}&messages=${MESSAGES_PER_CHAT}&split=1`,
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.workspaceHarnessReady === "true",
  );
  await expect(page.locator("[data-retained-instance]")).toHaveCount(INSTANCES);
  // Hidden chats hydrate through the idle queue. Panel bodies mount lazily, so
  // each of the two panels per instance contributes its active tab's transcript.
  await expect(page.locator("[data-message-id]")).toHaveCount(MOUNTED_BODIES * MESSAGES_PER_CHAT, {
    timeout: 120_000,
  });
  // Guards the fixture itself: a transcript of plain paragraphs would not
  // reproduce what makes a real working set expensive to keep laid out.
  expect(await page.locator("[data-tool-id]").count()).toBeGreaterThan(
    MOUNTED_BODIES * MESSAGES_PER_CHAT * 0.5,
  );
  await page.waitForTimeout(1_000);
}

const pressRow = (page: Page, index: number) =>
  page.evaluate(
    (i) => window.__isoladeWorkspaceHarness?.pressAndTime('[data-demo="instance-row"]', i),
    index,
  );

test.describe("retained workspace", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Timing budgets are calibrated for Chromium",
  );
  // Building the working set takes a while before any measurement starts.
  test.describe.configure({ timeout: 180_000 });

  test("keeps interaction off the critical path of the retained set @stress", async ({ page }) => {
    await openWorkspace(page);

    // The new-chat pane shares nothing with the retained instances, so opening
    // its model picker must not depend on how much history sits behind it.
    const openPicker = async (skipping: boolean) => {
      const samples: number[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        await page.evaluate(
          (on) => window.__isoladeWorkspaceHarness?.setPaneSkipping(on),
          skipping,
        );
        samples.push(
          (await page.evaluate(() =>
            window.__isoladeWorkspaceHarness?.pressAndTime('[data-demo="model-picker"]'),
          )) ?? Number.POSITIVE_INFINITY,
        );
        await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(0);
      }
      return median(samples);
    };

    const laidOut = await openPicker(false);
    const skipped = await openPicker(true);
    expect(skipped).toBeLessThan(laidOut * SKIPPED_SHARE_OF_LAID_OUT);
    expect(skipped).toBeLessThan(INTERACTION_CEILING_MS);

    // Switching is the other side of the trade. Revealing a pane means laying
    // out a transcript that was skipped, which is real work either way, so this
    // is deliberately not asserted to get faster. What it must not do is get
    // slower: skipping off-screen panes must not have bought idle smoothness at
    // the cost of the navigation the user actually asked for.
    const switchInstances = async (skipping: boolean) => {
      const samples: number[] = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.evaluate(
          (on) => window.__isoladeWorkspaceHarness?.setPaneSkipping(on),
          skipping,
        );
        samples.push((await pressRow(page, attempt % 2)) ?? Number.POSITIVE_INFINITY);
      }
      return median(samples);
    };

    const switchLaidOut = await switchInstances(false);
    const switchSkipped = await switchInstances(true);
    expect(switchSkipped).toBeLessThan(switchLaidOut * NO_REGRESSION_MARGIN);
    expect(switchSkipped).toBeLessThan(INTERACTION_CEILING_MS);
  });

  test("holds retained panes still while the instance poll runs @stress", async ({ page }) => {
    await openWorkspace(page);

    // A poll that changes nothing must not commit at all.
    await page.evaluate(() => window.__isoladeWorkspaceHarness?.resetProfile());
    await page.waitForTimeout(3_300);
    const idle = await page.evaluate(() => window.__isoladeWorkspaceHarness?.profile());
    expect(idle?.workspaceRenders).toBe(0);

    // A poll that changes one instance's diff stats redraws its sidebar row,
    // not the workspace of every open chat.
    const changed = await page.evaluate(() => window.__isoladeWorkspaceHarness?.pollWithChange());
    expect(changed?.workspaceRenders).toBe(0);
    expect(changed?.totalDuration ?? Number.POSITIVE_INFINITY).toBeLessThan(15);
  });

  test("skipping an off-screen pane preserves its reading position @stress", async ({ page }) => {
    await openWorkspace(page);

    // A freshly revealed pane lands on its tail, not at scrollTop 0.
    await pressRow(page, 0);
    expect(
      await page.evaluate(() =>
        window.__isoladeWorkspaceHarness?.activeTranscriptDistanceFromBottom(),
      ),
    ).toBeLessThanOrEqual(1);

    // Scroll up to read, leave, come back: the reader is still looking at the
    // same message in the same place, even though the pane was skipped while
    // off screen.
    await page.evaluate(() => window.__isoladeWorkspaceHarness?.scrollActiveTranscript(1_500));
    const reading = await page.evaluate(() =>
      window.__isoladeWorkspaceHarness?.activeReadingAnchor(),
    );
    expect(reading?.id).toBeTruthy();
    expect(
      await page.evaluate(() =>
        window.__isoladeWorkspaceHarness?.activeTranscriptDistanceFromBottom(),
      ),
    ).toBeGreaterThan(100);

    await pressRow(page, 1);
    await pressRow(page, 0);
    const restored = await page.evaluate(() =>
      window.__isoladeWorkspaceHarness?.activeReadingAnchor(),
    );
    expect(restored?.id).toBe(reading?.id);
    expect(Math.abs((restored?.top ?? 0) - (reading?.top ?? 0))).toBeLessThanOrEqual(2);
  });
});
