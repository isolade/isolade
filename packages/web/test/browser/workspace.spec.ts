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

    // A freshly revealed pane lands on its tail, not at scrollTop 0. Wait for it
    // to actually be shown: it is held unpainted while its layout rebuilds, so
    // measuring on a fixed frame count would sample a pane the reader cannot see.
    await pressRow(page, 0);
    expect(
      await page.evaluate(() => window.__isoladeWorkspaceHarness?.waitForActivePaneShown()),
    ).toBe(true);
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
    await page.evaluate(() => window.__isoladeWorkspaceHarness?.waitForActivePaneShown());
    await pressRow(page, 0);
    await page.evaluate(() => window.__isoladeWorkspaceHarness?.waitForActivePaneShown());
    const restored = await page.evaluate(() =>
      window.__isoladeWorkspaceHarness?.activeReadingAnchor(),
    );
    expect(restored?.id).toBe(reading?.id);
    expect(Math.abs((restored?.top ?? 0) - (reading?.top ?? 0))).toBeLessThanOrEqual(2);
  });

  // Ported from the retention test that used to run against InstanceView, the
  // pre-0.3.1 pane component the app no longer renders. Retention only pays for
  // its memory if revisiting a chat is free, and "free" means no Markdown was
  // re-parsed and no historical row was re-rendered. A single panel per instance
  // here, so both chats are tabs in one strip and tab switching is exercised
  // alongside instance switching.
  test("re-parses nothing when revisiting instances and tabs @stress", async ({ page }) => {
    const instances = 6;
    const messages = 120;
    await page.goto(
      `/test/browser/harness/index.html?workspace=1&instances=${instances}` +
        `&chatsPerInstance=2&messages=${messages}`,
    );
    await page.waitForFunction(
      () => document.documentElement.dataset.workspaceHarnessReady === "true",
    );
    await expect(page.locator("[data-retained-instance]")).toHaveCount(instances);

    // Warm every tab of every instance. Panel bodies mount on first activation,
    // so the second tab's transcript only exists once it has been selected.
    const warm = async () => {
      for (let index = 0; index < instances; index++) {
        await pressRow(page, index);
        const tabs = page.locator('[data-retained-instance][aria-hidden="false"] [role="tab"]');
        await expect(tabs).toHaveCount(2);
        for (let tab = 0; tab < 2; tab++) {
          await tabs.nth(tab).click();
          await page.evaluate(() => window.__isoladeWorkspaceHarness?.waitFrames(2));
        }
      }
    };
    await warm();
    await expect(page.locator("[data-message-id]")).toHaveCount(instances * 2 * messages, {
      timeout: 60_000,
    });

    // Guards the assertion below from passing vacuously: warming really did
    // parse this transcript, so a second pass finding zero means something.
    const warmed = await page.evaluate(() => window.__isoladeWorkspaceHarness?.renderMetrics());
    expect(warmed?.markdownRenders ?? 0).toBeGreaterThan(0);
    expect(warmed?.parserInputBytes ?? 0).toBeGreaterThan(0);

    // Everything is now mounted and parsed, so a second pass must do no work.
    await page.evaluate(() => window.__isoladeWorkspaceHarness?.resetProfile());
    await warm();

    const metrics = await page.evaluate(() => window.__isoladeWorkspaceHarness?.renderMetrics());
    expect(metrics?.markdownRenders).toBe(0);
    expect(metrics?.parserInputBytes).toBe(0);
    expect(metrics?.historyMappings).toBe(0);
    expect(metrics?.historicalRowRenders).toBe(0);
  });

  // The point of caching the parse outside the component tree: a row can be
  // unmounted and mounted again without redoing it. Retention tests only show
  // that a retained row is never asked to repeat, which a cache that dies with
  // the row would also satisfy.
  test("re-parses nothing after the whole workspace remounts @stress", async ({ page }) => {
    await openWorkspace(page);
    await pressRow(page, 0);
    await page.evaluate(() => window.__isoladeWorkspaceHarness?.waitForActivePaneShown());

    const warmed = await page.evaluate(() => window.__isoladeWorkspaceHarness?.renderMetrics());
    expect(warmed?.parserInputBytes ?? 0).toBeGreaterThan(0);

    await page.evaluate(() => window.__isoladeWorkspaceHarness?.resetProfile());
    await page.evaluate(() => window.__isoladeWorkspaceHarness?.remountWorkspace());
    await expect(page.locator("[data-message-id]")).toHaveCount(
      MOUNTED_BODIES * MESSAGES_PER_CHAT,
      { timeout: 120_000 },
    );

    const after = await page.evaluate(() => window.__isoladeWorkspaceHarness?.renderMetrics());
    expect(after?.parserInputBytes).toBe(0);
  });
});

// The attached-PR badge is instance-wide status living in panel chrome, so what
// matters is that it appears once per workspace, in the tab strip rather than in
// a row of its own, and that it stays out of the transcript's way.
test.describe("attached PR badge", () => {
  const openInstance = async (page: Page, prs: number, split: boolean) => {
    await page.goto(
      `/test/browser/harness/index.html?workspace=1&instances=2&chatsPerInstance=2` +
        `&messages=6&prs=${prs}${split ? "&split=1" : ""}`,
    );
    await page.waitForFunction(
      () => document.documentElement.dataset.workspaceHarnessReady === "true",
    );
    await pressRow(page, 0);
    await expect(page.locator('[data-retained-instance][aria-hidden="false"]')).toHaveCount(1);
  };

  const visible = (page: Page, selector: string) =>
    page.locator(`[data-retained-instance][aria-hidden="false"] ${selector}`);

  test("sits in one tab strip and leaves the chat body where it was", async ({ page }) => {
    await openInstance(page, 3, true);

    // Two panels, one badge: the PRs belong to the instance, not to a panel.
    const badge = visible(page, '[data-demo="pr-badge"]');
    await expect(visible(page, "[data-strip-id]")).toHaveCount(2);
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveText("3 PRs");

    // In the strip, not above the body: the badge shares the strip's box, and
    // the body still starts where the strip ends.
    const strips = await visible(page, "[data-strip-id]").evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().toJSON()),
    );
    const badgeBox = (await badge.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const host = strips.find((strip) => badgeBox.y >= strip.y && badgeBox.y < strip.bottom);
    expect(host).toBeDefined();
    // Trailing end of the rightmost strip, past the tabs.
    expect(badgeBox.x).toBeGreaterThan(Math.max(...strips.map((strip) => strip.x)));
    const bodyTop = await visible(page, "[data-chat-scroll]")
      .first()
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(bodyTop).toBeCloseTo(host?.bottom ?? -1, 0);
  });

  test("names a single PR, and opens a menu that detaches one", async ({ page }) => {
    await openInstance(page, 1, false);

    const badge = visible(page, '[data-demo="pr-badge"]');
    await expect(badge).toHaveText("#100");
    await badge.click();
    const menu = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(menu).toContainText("acme/isolade#100");

    await menu.getByLabel("Detach PR #100").click();
    // The last PR gone takes the badge (and its menu) with it.
    await expect(visible(page, '[data-demo="pr-badge"]')).toHaveCount(0);
  });

  test("is absent from a chat with no attached PR", async ({ page }) => {
    await openInstance(page, 0, false);
    await expect(visible(page, '[data-demo="pr-badge"]')).toHaveCount(0);
  });
});

test.describe("model picker", () => {
  // The picker is fed from the catalog compiled into the bundle, so nothing it
  // shows waits on the server. Before that it was fed only by
  // GET /api/chat/models, and a page that loaded while the server was still
  // coming up (or restarting under a dev edit) got a picker naming the raw model
  // id with an empty menu behind it, for the rest of the session: the fetch runs
  // once and swallows its error.
  test("names the model and offers the catalog with the server unreachable", async ({ page }) => {
    await page.goto(
      "/test/browser/harness/index.html?workspace=1&instances=1&chatsPerInstance=1" +
        "&messages=4&catalogDown=1",
    );
    await page.waitForFunction(
      () => document.documentElement.dataset.workspaceHarnessReady === "true",
    );
    await pressRow(page, 0);

    const picker = page.locator(
      '[data-retained-instance][aria-hidden="false"] [data-demo="model-picker"]',
    );
    await expect(picker).toHaveText("Sonnet 5 High");

    await picker.click();
    const menu = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(menu.locator('[data-demo="model-claude-opus-5"]')).toHaveText("Opus 5");
    expect(await menu.locator('[data-demo^="model-"]').count()).toBeGreaterThan(1);
  });
});
