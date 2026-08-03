import { expect, type Page, test } from "@playwright/test";

async function openHarness(
  page: Page,
  options: { chats?: number; messages?: number; legacy?: boolean } = {},
) {
  const parameters = new URLSearchParams({
    chats: String(options.chats ?? 1),
    messages: String(options.messages ?? 400),
  });
  if (options.legacy) parameters.set("legacy", "1");
  await page.goto(`/test/browser/harness/index.html?${parameters}`);
  await page.waitForFunction(() => document.documentElement.dataset.harnessReady === "true");
}

// A two-panel gesture harness whose right panel shows a live browser preview.
// Returns a locator for an input inside the previewed page.
async function openPreviewGestureHarness(page: Page) {
  const previewPort = 4321;
  await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
    await route.fulfill({
      json: {
        layout: {
          type: "split",
          id: "gesture-split",
          direction: "row",
          sizes: [0.5, 0.5],
          children: [
            {
              type: "panel",
              id: "left-panel",
              tabs: [{ id: "left-tab", kind: "ports" }],
              activeTabId: "left-tab",
            },
            {
              type: "panel",
              id: "right-panel",
              tabs: [{ id: "right-tab", kind: "browser" }],
              activeTabId: "right-tab",
            },
          ],
        },
      },
    });
  });
  await page.route("**/api/instances/panel-gesture-instance/port-status", async (route) => {
    await route.fulfill({
      json: { forwarded: [{ remotePort: 3000, status: "listening" }], detected: [] },
    });
  });
  // The previewed app. Served on a different origin than the harness, exactly
  // like a real forward, so the frame is genuinely cross-origin and its events
  // stay inside it.
  await page.route(`http://localhost:${previewPort}/`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body style="margin:0"><input id="field" style="width:100%;height:100px"></body>',
    });
  });
  await page.goto(`/test/browser/harness/index.html?panelGesture=1&previewPort=${previewPort}`);
  return page.frameLocator('iframe[title="Browser preview"]').locator("#field");
}

function transcriptFixture(chatId: string, count = 60, wrapping = false, thoughts = false) {
  const messages = Array.from({ length: count }, (_, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    return {
      id: `${chatId}-production-m${index}`,
      chatId,
      role,
      content:
        role === "user"
          ? `Production question ${index}`
          : `### Production response ${index}\n\nThis **Markdown** came through the transcript API.${
              wrapping
                ? " Long wrapping content makes the retained row substantially taller in a narrow pane.".repeat(
                    6,
                  )
                : ""
            }`,
      parentId: index === 0 ? null : `${chatId}-production-m${index - 1}`,
      createdAt: new Date(index * 1_000).toISOString(),
      version: null,
    };
  });
  const chunksByMessage = thoughts
    ? {
        [`${chatId}-production-m1`]: [
          {
            kind: "thought",
            id: "claude-thinking-0",
            provider: "claude",
            text: "I checked the request, the current state, and the relevant implementation details.",
            tokens: 768,
            status: "done",
          },
          { kind: "text", text: "The implementation is ready." },
        ],
      }
    : {};
  return { messages, hasMore: false, chunksByMessage, inFlight: null };
}

async function openProductionHarness(
  page: Page,
  chatCount: number,
  options: {
    messages?: number;
    wrappingRows?: boolean;
    thoughts?: boolean;
    crossProviderPicker?: boolean;
  } = {},
) {
  const transcriptRequests: string[] = [];
  await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/chats\/([^/]+)\/transcript$/);
    const chatId = match?.[1];
    if (!chatId) {
      await route.abort();
      return;
    }
    transcriptRequests.push(chatId);
    await route.fulfill({
      json: transcriptFixture(
        chatId,
        options.messages ?? 60,
        options.wrappingRows,
        options.thoughts,
      ),
    });
  });
  const parameters = new URLSearchParams({ production: "1", chats: String(chatCount) });
  if (options.crossProviderPicker) parameters.set("crossProviderPicker", "1");
  await page.goto(`/test/browser/harness/index.html?${parameters}`);
  await page.waitForFunction(
    () => document.documentElement.dataset.productionHarnessReady === "true",
  );
  return transcriptRequests;
}

async function resetMetrics(page: Page) {
  await page.evaluate(() => window.__isoladeRendererHarness?.resetMetrics());
}

async function metrics(page: Page) {
  return await page.evaluate(() => window.__isoladeRendererHarness?.metrics());
}

async function rowTop(page: Page, messageId: string): Promise<number> {
  return await page
    .locator(`[data-message-id="${messageId}"]`)
    .evaluate((row) => row.getBoundingClientRect().top);
}

// How far a tab's keep-alive body sits from the slot of the panel that owns it,
// as [left, top, width, height]. The owning panel is resolved through the tab
// strip holding that tab, independently of the body layer's own bookkeeping.
async function gluedDelta(page: Page, tabId: string): Promise<number[] | null> {
  return await page.evaluate((id) => {
    const layer = document.querySelector(`[data-body-layer="${id}"]`);
    const strip = document.querySelector(`[data-tab-id="${id}"]`)?.closest("[data-strip-id]");
    const panelId = strip?.getAttribute("data-strip-id");
    const slot = panelId ? document.querySelector(`[data-body-id="${panelId}"]`) : null;
    if (!layer || !slot) return null;
    const a = layer.getBoundingClientRect();
    const b = slot.getBoundingClientRect();
    return [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height].map((delta) =>
      Math.round(delta),
    );
  }, tabId);
}

test.describe("message renderer browser gate", () => {
  test("renders the thinking indicator and keeps the Claude summary collapsed", async ({
    page,
  }) => {
    await openProductionHarness(page, 1, { messages: 2, thoughts: true });

    const thought = page.locator('[data-thinking-provider="claude"]');
    await expect(thought).toBeVisible();
    await expect(thought).toHaveAttribute("data-thinking-status", "done");
    await expect(thought).toContainText("Thought");
    await expect(thought).toContainText("768 tokens");
    await expect(thought).toContainText(
      "I checked the request, the current state, and the relevant implementation details.",
    );

    // Each separator stands between the two figures it separates rather than
    // leaning against one of them, so the air on its left matches the air on
    // its right.
    const separatorAir = await thought.locator("button").evaluate((row) => {
      // Every glyph on the row in reading order, so the air around a separator
      // is measured as drawn, whether the dot is its own element or a character
      // inside a longer run.
      const glyphs: { char: string; rect: DOMRect }[] = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        for (let index = 0; index < text.length; index++) {
          if (!text[index]?.trim()) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          glyphs.push({ char: text[index]!, rect: range.getBoundingClientRect() });
        }
      }
      const dot = glyphs.findIndex((glyph) => glyph.char === "·");
      return {
        before: glyphs[dot]!.rect.left - glyphs[dot - 1]!.rect.right,
        after: glyphs[dot + 1]!.rect.left - glyphs[dot]!.rect.right,
      };
    });
    expect(separatorAir.before).toBeGreaterThan(0);
    expect(Math.abs(separatorAir.before - separatorAir.after)).toBeLessThanOrEqual(1);

    // Reasoning stays folded away until asked for, so the answer sits directly
    // under the row. Clicking it opens the summary, and the clipped body takes
    // up no height at all until then.
    const body = thought.locator("[data-thinking-body]");
    const toggle = thought.getByRole("button");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect((await body.boundingBox())?.height).toBe(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(body).toHaveAttribute("data-thinking-body", "open");
    await expect.poll(async () => (await body.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  });

  // What lands on the clipboard is the source text, not the rendered page: an
  // answer copies as the Markdown the agent wrote, headings and asterisks
  // intact, and a question copies as the words the reader typed. And only the
  // agent's last utterance: the turn below talked its way to the answer through
  // a remark and a command, neither of which the reader asked for.
  test("copies a message as the text behind it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const answerId = "chat-a-production-m1";
    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      await route.fulfill({
        json: {
          ...transcriptFixture("chat-a", 4),
          chunksByMessage: {
            [answerId]: [
              { kind: "text", text: "Let me check the tests." },
              {
                kind: "tool",
                id: "tool-1",
                name: "Bash",
                summary: "bun test",
                output: "ok",
                status: "done",
              },
              { kind: "reply_start" },
              {
                kind: "text",
                text: "### Production response 1\n\nThis **Markdown** came through the transcript API.",
              },
            ],
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    const answer = page.locator(`[data-message-id="${answerId}"]`);
    const answerCopy = answer.getByRole("button", { name: "Copy message" });
    // A transcript at rest carries no buttons: each one is drawn only once the
    // reader is on the message it belongs to.
    await expect(answerCopy).toHaveCSS("opacity", "0");
    await answer.hover();
    await expect(answerCopy).toHaveCSS("opacity", "1");
    await expect(answer).toContainText("Let me check the tests.");
    await answerCopy.click();
    expect(await clipboard()).toBe(
      "### Production response 1\n\nThis **Markdown** came through the transcript API.",
    );

    const question = page.locator('[data-message-id="chat-a-production-m0"]');
    const questionCopy = question.getByRole("button", { name: "Copy message" });
    await expect(questionCopy).toHaveCSS("opacity", "0");
    await question.getByText("Production question 0").hover();
    await expect(questionCopy).toHaveCSS("opacity", "1");
    await questionCopy.click();
    expect(await clipboard()).toBe("Production question 0");
  });

  // A turn is not always started by the view that shows the chat: a message sent
  // while the agent is working is queued, and the server promotes it into a turn
  // of its own when the current one ends. The chat row is what says so, and a
  // view that ignored it sat there with a settled composer while the answer
  // streamed into nothing and only turned up on a reload.
  test("picks up a turn the server started on its own", async ({ page }) => {
    const promotedTurn = "chat-a-promoted-turn";
    let promoted = false;
    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      const base = transcriptFixture("chat-a", 2);
      await route.fulfill({
        json: promoted
          ? {
              ...base,
              messages: [
                ...base.messages,
                {
                  id: "chat-a-promoted-user",
                  chatId: "chat-a",
                  role: "user",
                  content: "And the question after that one",
                  parentId: base.messages.at(-1)?.id ?? null,
                  createdAt: new Date(9_000).toISOString(),
                  version: null,
                },
              ],
              inFlight: {
                messageId: promotedTurn,
                lastSeq: -1,
                chunks: [],
                startedAt: new Date().toISOString(),
              },
            }
          : base,
      });
    });
    // Held so the turn is still running when the view attaches, which is what
    // the composer has to report.
    let releaseReply!: () => void;
    const heldReply = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    await page.route(`**/messages/${promotedTurn}/stream?*`, async (route) => {
      await heldReply;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          "event: snapshot",
          `data: ${JSON.stringify({
            messageId: promotedTurn,
            lastSeq: -1,
            chunks: [],
            metaEvents: [],
            status: "running",
            message: null,
          })}`,
          "",
          "id: 0",
          "event: delta",
          `data: ${JSON.stringify("The reply nobody was watching.")}`,
          "",
          "event: done",
          "data: ",
          "",
          "",
        ].join("\n"),
      });
    });
    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    // A chat at rest: no turn, and nothing in the composer's send corner.
    await expect(page.locator('[data-message-id="chat-a-production-m1"]')).toBeVisible();
    await expect(page.getByLabel("Working", { exact: false })).toHaveCount(0);

    promoted = true;
    await page.evaluate(
      (id) => window.__isoladeProductionChatHarness?.setChatInFlight("chat-a", id),
      promotedTurn,
    );

    // The view goes and finds the turn: the question it answers arrives, and the
    // composer says the agent is working on it.
    await expect(page.getByText("And the question after that one")).toBeVisible();
    await expect(page.getByLabel("Working", { exact: false })).toHaveCount(1);

    releaseReply();
    await expect(page.getByText("The reply nobody was watching.")).toBeVisible();
    // And it settles like any other turn once the stream ends.
    await expect(page.getByLabel("Working", { exact: false })).toHaveCount(0);
  });

  test("keeps expanded-sidebar tabs flush with the panel edge", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      await route.fulfill({
        json: {
          layout: {
            type: "panel",
            id: "sidebar-gap-panel",
            tabs: [{ id: "sidebar-gap-tab", kind: "browser" }],
            activeTabId: "sidebar-gap-tab",
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1&sidebarExpanded=1");

    const panel = page.locator('[data-panel-id="sidebar-gap-panel"]');
    const tab = page.locator('[data-tab-id="sidebar-gap-tab"]');
    await expect
      .poll(async () => {
        const [panelBounds, tabBounds] = await Promise.all([
          panel.boundingBox(),
          tab.boundingBox(),
        ]);
        if (!panelBounds || !tabBounds) return null;
        return tabBounds.x - panelBounds.x;
      })
      .toBe(0);
  });

  test("keeps collapsed-sidebar tabs clear of the window controls", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      await route.fulfill({
        json: {
          layout: {
            type: "panel",
            id: "chrome-inset-panel",
            tabs: [{ id: "chrome-inset-tab", kind: "browser" }],
            activeTabId: "chrome-inset-tab",
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1&chromeInset=1");

    const settings = page.getByRole("button", { name: "Settings" });
    const tab = page.locator('[data-tab-id="chrome-inset-tab"]');
    await expect
      .poll(async () => {
        const [settingsBounds, tabBounds] = await Promise.all([
          settings.boundingBox(),
          tab.boundingBox(),
        ]);
        if (!settingsBounds || !tabBounds) return null;
        return tabBounds.x - (settingsBounds.x + settingsBounds.width);
      })
      .toBeGreaterThanOrEqual(0);
  });

  test("scrolls overflowing panel tabs and keeps the active tab visible", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ json: {} });
        return;
      }
      await route.fulfill({
        json: {
          layout: {
            type: "panel",
            id: "overflow-panel",
            tabs: Array.from({ length: 12 }, (_, index) => ({
              id: `overflow-tab-${index}`,
              kind: "browser",
            })),
            activeTabId: "overflow-tab-0",
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1");

    const panel = page.locator('[data-panel-id="overflow-panel"]');
    const firstTab = page.locator('[data-tab-id="overflow-tab-0"]');
    const scroller = page.locator('[data-panel-tabs-scroll="overflow-panel"]');
    const scrollRight = page.locator('[data-panel-tabs-scroll-right="overflow-panel"]');
    await expect
      .poll(async () => {
        const [panelBounds, tabBounds] = await Promise.all([
          panel.boundingBox(),
          firstTab.boundingBox(),
        ]);
        if (!panelBounds || !tabBounds) return null;
        return Math.abs(tabBounds.x - panelBounds.x);
      })
      .toBeLessThanOrEqual(1);
    await expect(scrollRight).toBeVisible();
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(0);

    await scrollRight.click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expect(page.locator('[data-panel-tabs-scroll-left="overflow-panel"]')).toBeVisible();

    await scroller.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await scroller.dispatchEvent("wheel", { deltaX: 0, deltaY: 100 });
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    // Two equal reads in a row, so the strip has stopped moving. A scroll still
    // in flight can outrun the scroll-into-view the next click triggers and
    // leave the strip somewhere neither of them intended, which no amount of
    // polling afterwards recovers from.
    const scrollAtRest = async () => {
      let previous = Number.NaN;
      await expect
        .poll(async () => {
          const current = await scroller.evaluate((element) => element.scrollLeft);
          const settled = current === previous;
          previous = current;
          return settled;
        })
        .toBe(true);
    };
    await scrollAtRest();

    const lastTab = page.locator('[data-tab-id="overflow-tab-11"]');
    await lastTab.evaluate((element) => element.click());
    await expect(lastTab).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        lastTab.evaluate((tab) => {
          const viewport = tab.parentElement;
          if (!viewport) return false;
          const tabRect = tab.getBoundingClientRect();
          const viewportRect = viewport.getBoundingClientRect();
          // Subpixel flex rounding can put an edge fractionally outside the
          // viewport even though every rendered pixel is visible.
          return tabRect.left >= viewportRect.left - 1 && tabRect.right <= viewportRect.right + 1;
        }),
      )
      .toBe(true);

    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await scrollAtRest();
    const addButton = page.getByRole("button", { name: "New tab" });
    await expect
      .poll(async () => {
        const [lastBounds, addBounds] = await Promise.all([
          lastTab.boundingBox(),
          addButton.boundingBox(),
        ]);
        if (!lastBounds || !addBounds) return null;
        return addBounds.x - (lastBounds.x + lastBounds.width);
      })
      .toBeGreaterThanOrEqual(-1);
    // Poll the upper bounds too, rather than reading the boxes once: the strip's
    // scroll and the resize observation that follows it can land a frame apart,
    // and a single read can catch the add button mid-settle.
    await expect
      .poll(async () => {
        const [lastBounds, addBounds, panelBounds] = await Promise.all([
          lastTab.boundingBox(),
          addButton.boundingBox(),
          panel.boundingBox(),
        ]);
        if (!lastBounds || !addBounds || !panelBounds) return null;
        return Math.max(
          addBounds.x - (lastBounds.x + lastBounds.width),
          Math.abs(panelBounds.x + panelBounds.width - (addBounds.x + addBounds.width)),
        );
      })
      .toBeLessThanOrEqual(1);
  });

  test("scrolls chat messages inside a keep-alive panel body", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      await route.fulfill({
        json: {
          layout: {
            type: "panel",
            id: "chat-scroll-panel",
            tabs: [
              {
                id: "chat-scroll-tab",
                kind: "chat",
                resourceId: "panel-gesture-chat",
              },
            ],
            activeTabId: "chat-scroll-tab",
          },
        },
      });
    });
    await page.route(
      "**/api/instances/panel-gesture-instance/chats/panel-gesture-chat/transcript?*",
      async (route) => {
        await route.fulfill({ json: transcriptFixture("panel-gesture-chat", 60, true) });
      },
    );
    await page.goto("/test/browser/harness/index.html?panelGesture=1&chat=1");

    const body = page.locator('[data-body-layer="chat-scroll-tab"]');
    const scrollElement = body.locator("[data-chat-scroll]");
    await expect(body.locator("[data-message-id]")).toHaveCount(60);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    const initial = await scrollElement.evaluate((element) => ({
      scrollTop: element.scrollTop,
      maxScrollTop: element.scrollHeight - element.clientHeight,
    }));
    expect(initial.scrollTop).toBeGreaterThan(0);
    expect(initial.maxScrollTop).toBeGreaterThan(0);

    await body.locator('[data-message-id="panel-gesture-chat-production-m58"]').hover();
    await page.mouse.wheel(0, -500);
    await expect
      .poll(() => scrollElement.evaluate((element) => element.scrollTop))
      .toBeLessThan(initial.scrollTop);
    await expect(body.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  });

  test("emphasizes the active tab only in the focused panel", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      await route.fulfill({
        json: {
          layout: {
            type: "split",
            id: "gesture-split",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [
              {
                type: "panel",
                id: "left-panel",
                tabs: [{ id: "left-tab", kind: "browser" }],
                activeTabId: "left-tab",
              },
              {
                type: "panel",
                id: "right-panel",
                tabs: [{ id: "right-tab", kind: "browser" }],
                activeTabId: "right-tab",
              },
            ],
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1");

    const leftPanel = page.locator('[data-panel-id="left-panel"]');
    const rightPanel = page.locator('[data-panel-id="right-panel"]');
    const leftTab = page.locator('[data-tab-id="left-tab"]');
    const rightTab = page.locator('[data-tab-id="right-tab"]');
    await expect(leftTab).toBeVisible();
    expect(await leftTab.evaluate((tab) => getComputedStyle(tab).transitionDuration)).toBe("0s");
    expect(
      await leftTab
        .getByRole("button", { name: "Close tab" })
        .evaluate((button) => getComputedStyle(button).transitionDuration),
    ).toBe("0s");
    await expect(leftPanel).toHaveAttribute("data-panel-focused", "true");
    await expect(rightPanel).toHaveAttribute("data-panel-focused", "false");
    expect(await leftTab.evaluate((tab) => getComputedStyle(tab, "::after").opacity)).toBe("1");
    expect(await rightTab.evaluate((tab) => getComputedStyle(tab, "::after").opacity)).toBe("0.35");

    // Bodies are rendered in the keep-alive layer at the workspace root, not
    // inside their panel, so this click has to travel out of the panel subtree
    // to move the focused panel.
    await page.locator('[data-body-layer="right-tab"]').click({ position: { x: 100, y: 100 } });
    await expect(leftPanel).toHaveAttribute("data-panel-focused", "false");
    await expect(rightPanel).toHaveAttribute("data-panel-focused", "true");
    await expect
      .poll(() => leftTab.evaluate((tab) => getComputedStyle(tab, "::after").opacity))
      .toBe("0.35");
    await expect
      .poll(() => rightTab.evaluate((tab) => getComputedStyle(tab, "::after").opacity))
      .toBe("1");
  });

  test("follows focus into the browser preview iframe", async ({ page }) => {
    const field = await openPreviewGestureHarness(page);
    const leftPanel = page.locator('[data-panel-id="left-panel"]');
    const rightPanel = page.locator('[data-panel-id="right-panel"]');
    await expect(field).toBeVisible();
    await expect(leftPanel).toHaveAttribute("data-panel-focused", "true");

    // A click inside the frame raises no pointer or focus event in this
    // document, so the highlight has to follow the window blur instead.
    await field.click();
    await expect(rightPanel).toHaveAttribute("data-panel-focused", "true");
    await expect(leftPanel).toHaveAttribute("data-panel-focused", "false");
  });

  test("keeps the focused panel when the whole window loses focus", async ({ page }) => {
    const field = await openPreviewGestureHarness(page);
    const leftPanel = page.locator('[data-panel-id="left-panel"]');
    const rightPanel = page.locator('[data-panel-id="right-panel"]');
    await expect(field).toBeVisible();

    await field.click();
    await expect(rightPanel).toHaveAttribute("data-panel-focused", "true");
    // Moving the highlight back to the other panel leaves the <iframe> as
    // activeElement, because a tab's pointerdown is preventDefaulted to stop
    // native drags and so never moves the real focus.
    await page.locator('[data-tab-id="left-tab"]').click();
    await expect(leftPanel).toHaveAttribute("data-panel-focused", "true");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");

    // Switching to another app blurs the window with activeElement untouched,
    // and unlike focus descending into the frame, drops document.hasFocus().
    // The highlight has to stay where the reader put it.
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new Event("blur"));
    });
    await expect(leftPanel).toHaveAttribute("data-panel-focused", "true");
    await expect(rightPanel).toHaveAttribute("data-panel-focused", "false");
  });

  test("resizes panels and ends resizing when the window loses focus", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ json: {} });
        return;
      }
      await route.fulfill({
        json: {
          layout: {
            type: "split",
            id: "resize-split",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [
              {
                type: "panel",
                id: "resize-left-panel",
                tabs: [{ id: "resize-left-tab", kind: "browser" }],
                activeTabId: "resize-left-tab",
              },
              {
                type: "panel",
                id: "resize-right-panel",
                tabs: [{ id: "resize-right-tab", kind: "browser" }],
                activeTabId: "resize-right-tab",
              },
            ],
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1");

    const divider = page.getByRole("separator", { name: "Resize panels" });
    const leftPanel = page.locator('[data-panel-id="resize-left-panel"]');
    const bounds = await divider.boundingBox();
    if (!bounds) throw new Error("Missing panel divider bounds");
    const initialWidth = await leftPanel.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 50, bounds.y + bounds.height / 2);
    await expect(page.locator("[data-panel-resize-overlay]")).toBeVisible();
    await expect
      .poll(() => leftPanel.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(initialWidth + 25);
    // A drag writes flex-grow straight to the DOM without a re-render, so the
    // keep-alive bodies have to follow their slots mid-gesture, not on release.
    await expect.poll(() => gluedDelta(page, "resize-left-tab")).toEqual([0, 0, 0, 0]);
    await expect.poll(() => gluedDelta(page, "resize-right-tab")).toEqual([0, 0, 0, 0]);

    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.locator("[data-panel-resize-overlay]")).toHaveCount(0);
    await page.mouse.up();

    const resumedBounds = await divider.boundingBox();
    if (!resumedBounds) throw new Error("Missing resized panel divider bounds");
    const resumedWidth = await leftPanel.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    await page.mouse.move(
      resumedBounds.x + resumedBounds.width / 2,
      resumedBounds.y + resumedBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(resumedBounds.x - 30, resumedBounds.y + resumedBounds.height / 2);
    await expect(page.locator("[data-panel-resize-overlay]")).toBeVisible();
    await expect
      .poll(() => leftPanel.evaluate((element) => element.getBoundingClientRect().width))
      .toBeLessThan(resumedWidth - 15);
    await page.mouse.up();
    await expect(page.locator("[data-panel-resize-overlay]")).toHaveCount(0);
  });

  test("presents each panel's out-of-tree body inside that panel", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ json: {} });
        return;
      }
      await route.fulfill({
        json: {
          layout: {
            type: "split",
            id: "aria-split",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [
              {
                type: "panel",
                id: "aria-left-panel",
                tabs: [{ id: "aria-left-tab", kind: "ports" }],
                activeTabId: "aria-left-tab",
              },
              {
                type: "panel",
                id: "aria-right-panel",
                tabs: [{ id: "aria-right-tab", kind: "browser" }],
                activeTabId: "aria-right-tab",
              },
            ],
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1");
    await expect(page.locator('[data-body-layer="aria-left-tab"]')).toBeVisible();

    // A body is a DOM sibling of every panel, so only `aria-owns` puts it back
    // under the panel it fills. Without it a screen reader reads both tab strips
    // and then both bodies, in the order the bodies happened to be activated.
    await expect(page.locator('[data-panel-id="aria-left-panel"]')).toMatchAriaSnapshot(`
      - tablist "Panel tabs":
        - tab "Ports Close tab" [selected]
      - tabpanel "Ports"
    `);
    await expect(page.locator('[data-panel-id="aria-right-panel"]')).toMatchAriaSnapshot(`
      - tablist "Panel tabs":
        - tab "Browser Close tab" [selected]
      - tabpanel "Browser"
    `);
  });

  test("keeps a panel body mounted and glued to its slot across a split and a move", async ({
    page,
  }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ json: {} });
        return;
      }
      await route.fulfill({
        json: {
          layout: {
            type: "panel",
            id: "keepalive-panel",
            tabs: [
              { id: "keepalive-tab", kind: "ports" },
              { id: "split-off-tab", kind: "browser" },
            ],
            activeTabId: "keepalive-tab",
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1");

    const body = page.locator('[data-body-layer="keepalive-tab"]');
    await expect(body).toBeVisible();
    await expect(page.locator("[data-panel-id]")).toHaveCount(1);
    // Tag the live DOM node. A remount would replace it with a fresh element
    // that React never gave this attribute, taking the panel's state with it.
    await body
      .locator("> *")
      .first()
      .evaluate((element) => element.setAttribute("data-keepalive-probe", "1"));

    // Drag the other tab onto the body's right edge: the panel splits, which
    // used to swap the tree root and remount every body under it.
    const tab = await page.locator('[data-tab-id="split-off-tab"]').boundingBox();
    const slot = await page.locator('[data-body-id="keepalive-panel"]').boundingBox();
    if (!tab || !slot) throw new Error("Missing panel tab or body bounds");
    await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
    await page.mouse.down();
    await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2 + 8);
    await page.mouse.move(slot.x + slot.width * 0.92, slot.y + slot.height / 2, { steps: 5 });
    await page.mouse.up();

    const otherBody = page.locator('[data-body-layer="split-off-tab"]');
    await expect(page.locator("[data-panel-id]")).toHaveCount(2);
    await expect(body.locator('[data-keepalive-probe="1"]')).toHaveCount(1);
    await expect(otherBody).toBeVisible();
    // The surviving body has to end up over its (now narrower) panel's slot.
    await expect.poll(() => gluedDelta(page, "keepalive-tab")).toEqual([0, 0, 0, 0]);

    // Now move the tagged tab itself into the other panel, which reparents its
    // panel and prunes the one it came from.
    const taggedTab = await page.locator('[data-tab-id="keepalive-tab"]').boundingBox();
    const target = await otherBody.boundingBox();
    if (!taggedTab || !target) throw new Error("Missing tagged tab or target body bounds");
    await page.mouse.move(taggedTab.x + taggedTab.width / 2, taggedTab.y + taggedTab.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      taggedTab.x + taggedTab.width / 2,
      taggedTab.y + taggedTab.height / 2 + 8,
    );
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect(page.locator("[data-panel-id]")).toHaveCount(1);
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(body.locator('[data-keepalive-probe="1"]')).toHaveCount(1);
    await expect(otherBody).toBeHidden();
    await expect.poll(() => gluedDelta(page, "keepalive-tab")).toEqual([0, 0, 0, 0]);
  });

  test("offers Opus in a fresh Codex chat's composer", async ({ page }) => {
    let createBody: Record<string, unknown> | null = null;
    await page.route("**/api/instances/instance-production-harness/chats/chat-a", async (route) => {
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        json: {
          id: "chat-a",
          instanceId: "instance-production-harness",
          model: "claude-opus-5",
          provider: "anthropic",
          effort: "high",
          fastMode: false,
          claudeSessionId: null,
          codexThreadId: null,
          inputTokens: null,
          cachedInputTokens: null,
          cacheCreationInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          costUsd: null,
          lastInputTokens: null,
          lastCachedInputTokens: null,
          lastCacheCreationInputTokens: null,
          lastOutputTokens: null,
          lastReasoningOutputTokens: null,
          modelContextWindow: null,
          compacted: null,
          activeLeafId: null,
          createdAt: new Date(0).toISOString(),
        },
      });
    });
    await openProductionHarness(page, 1, { messages: 0, crossProviderPicker: true });

    await page.locator('[data-demo="model-picker"]').click();
    await expect(page.getByRole("radio", { name: "Opus 5" })).toBeVisible();
    await page.getByRole("radio", { name: "Opus 5" }).click();

    await expect.poll(() => createBody).toEqual({ model: "claude-opus-5" });
    expect(await page.evaluate(() => window.localStorage.getItem("isolade.lastModelId"))).toBe(
      "claude-opus-5",
    );
  });

  test("fills a flex creation container without a narrow intermediate width", async ({ page }) => {
    await openProductionHarness(page, 1, { messages: 0 });

    const pane = page.locator('[data-production-chat="chat-a"]');
    const chat = pane.locator("[data-chat-root]");
    await expect
      .poll(async () => {
        const [paneBounds, chatBounds] = await Promise.all([
          pane.boundingBox(),
          chat.boundingBox(),
        ]);
        if (!paneBounds || !chatBounds) return null;
        return Math.abs(paneBounds.width - chatBounds.width);
      })
      .toBeLessThanOrEqual(1);
  });

  test("keeps the composer tall enough as its available space changes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openProductionHarness(page, 1, { messages: 0 });

    const textarea = page.getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)");
    await textarea.fill(
      "A multiline composer draft should remain fully visible when its panel becomes narrower. ".repeat(
        5,
      ),
    );
    const wideHeight = await textarea.evaluate((element) => element.clientHeight);

    await page.setViewportSize({ width: 520, height: 720 });
    await expect
      .poll(() => textarea.evaluate((element) => element.clientHeight >= element.scrollHeight))
      .toBe(true);
    const narrowSize = await textarea.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(narrowSize.clientHeight).toBeGreaterThan(wideHeight);
    expect(narrowSize.clientHeight).toBeGreaterThanOrEqual(narrowSize.scrollHeight);

    // Even a viewport shorter than one rendered line must not make the
    // textarea itself clip that line.
    await page.setViewportSize({ width: 520, height: 40 });
    await textarea.evaluate((element) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setValue?.call(element, "One line");
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect
      .poll(() =>
        textarea.evaluate((element) => {
          const styles = window.getComputedStyle(element);
          const firstLineHeight = Math.ceil(
            Number.parseFloat(styles.lineHeight) +
              Number.parseFloat(styles.paddingTop) +
              Number.parseFloat(styles.paddingBottom),
          );
          return element.clientHeight >= firstLineHeight;
        }),
      )
      .toBe(true);
    const oneLineSize = await textarea.evaluate((element) => {
      const styles = window.getComputedStyle(element);
      return {
        clientHeight: element.clientHeight,
        firstLineHeight: Math.ceil(
          Number.parseFloat(styles.lineHeight) +
            Number.parseFloat(styles.paddingTop) +
            Number.parseFloat(styles.paddingBottom),
        ),
      };
    });
    expect(oneLineSize.clientHeight).toBeGreaterThanOrEqual(oneLineSize.firstLineHeight);
  });

  test("keeps a panel's only tab when it is dragged within its own strip", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ json: {} });
        return;
      }
      await route.fulfill({
        json: {
          layout: {
            type: "panel",
            id: "single-tab-panel",
            tabs: [{ id: "single-tab", kind: "browser" }],
            activeTabId: "single-tab",
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1");

    const tab = page.locator('[data-tab-id="single-tab"]');
    await expect(tab).toBeVisible();
    for (const horizontalPosition of [0.1, 0.5, 0.9]) {
      const bounds = await tab.boundingBox();
      if (!bounds) throw new Error("Missing single panel tab bounds");
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX, centerY + 8);
      await page.mouse.move(bounds.x + bounds.width * horizontalPosition, centerY);
      await page.mouse.up();
      await expect(tab).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(1);
    }
  });

  test("prevents text selection throughout a panel tab drag", async ({ page }) => {
    await page.route("**/api/instances/panel-gesture-instance/layout", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ json: {} });
        return;
      }
      await route.fulfill({
        json: {
          layout: {
            type: "panel",
            id: "gesture-panel",
            tabs: [
              { id: "gesture-tab-1", kind: "browser" },
              { id: "gesture-tab-2", kind: "browser" },
            ],
            activeTabId: "gesture-tab-1",
          },
        },
      });
    });
    await page.goto("/test/browser/harness/index.html?panelGesture=1");

    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    const firstTab = await tabs.first().boundingBox();
    if (!firstTab) throw new Error("Missing first panel tab bounds");
    await page.mouse.move(firstTab.x + firstTab.width / 2, firstTab.y + firstTab.height / 2);
    await page.mouse.down();

    expect(await page.evaluate(() => document.documentElement.style.userSelect)).toBe("none");
    await page.mouse.move(30, 20, { steps: 5 });
    await expect(page.locator("[data-panel-drag-ghost]")).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");

    await page.mouse.up();
    expect(await page.evaluate(() => document.documentElement.style.userSelect)).toBe("");
    await expect(page.locator("[data-panel-drag-ghost]")).toHaveCount(0);

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  });

  test("positions panel drag feedback in viewport coordinates", async ({ page }) => {
    await page.goto("/test/browser/harness/index.html?dragLayer=1");

    const preview = page.locator("[data-panel-drag-preview]");
    const ghost = page.locator("[data-panel-drag-ghost]");
    await expect(preview).toHaveCSS("position", "fixed");
    expect(await preview.evaluate((element) => element.parentElement === document.body)).toBe(true);
    expect(await preview.boundingBox()).toEqual({ x: 160, y: 120, width: 240, height: 180 });
    expect(await ghost.boundingBox()).toMatchObject({ x: 212, y: 172, height: 28 });
  });

  test("positions a hydrated tail in its first populated commit", async ({ page }) => {
    let releaseTranscript!: () => void;
    const transcriptGate = new Promise<void>((resolve) => {
      releaseTranscript = resolve;
    });
    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      await transcriptGate;
      await route.fulfill({ json: transcriptFixture("chat-a") });
    });
    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    await page.evaluate(() => {
      const scrollElement = document.querySelector<HTMLElement>(
        '[data-production-chat="chat-a"] [data-chat-scroll]',
      );
      if (!scrollElement) throw new Error("Missing chat scroll element");
      const observer = new MutationObserver(() => {
        if (!scrollElement.querySelector("[data-message-id]")) return;
        observer.disconnect();
        document.documentElement.dataset.firstHydrationDistance = String(
          scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight,
        );
      });
      observer.observe(scrollElement, { childList: true, subtree: true });
    });

    releaseTranscript();
    await page.waitForFunction(
      () => document.documentElement.dataset.firstHydrationDistance !== undefined,
    );
    const distance = await page.evaluate(() =>
      Number(document.documentElement.dataset.firstHydrationDistance),
    );
    expect(distance).toBeLessThanOrEqual(1);
  });

  test("production Chat retains warm panes without repeating parser work", async ({ page }) => {
    const chatCount = 4;
    const transcriptRequests = await openProductionHarness(page, chatCount);

    await expect(page.locator('[data-production-chat="chat-a"] [data-message-id]')).toHaveCount(60);
    expect(transcriptRequests[0]).toBe("chat-a");
    await expect(page.locator("[data-production-chat] [data-message-id]")).toHaveCount(
      chatCount * 60,
    );
    expect(new Set(transcriptRequests).size).toBe(chatCount);
    const warmRequestCount = transcriptRequests.length;

    // A retained pinned pane can have a stale scroll offset if its hidden
    // warm-up or layout work has not published a frame yet. The switch must
    // establish the bottom during React's commit, before a passive effect or
    // animation frame gets a chance to repair a visible top-of-chat paint.
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames());
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-production-chat="chat-b"] [data-chat-scroll]',
      );
      if (!target) throw new Error("Missing hidden chat scroll element");
      target.scrollTop = 0;
    });
    // Let the hidden scroll event fire. It must not poison the pane's logical
    // pinned state before the immediate reveal.
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(1));
    const immediateSwitch = await page.evaluate(() =>
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-b"),
    );
    expect(immediateSwitch?.distanceFromBottom).toBeLessThanOrEqual(1);

    // A reader-selected position has the opposite policy. Switching away and
    // back must preserve it instead of treating every hot reveal as pinned.
    const readingScrollTop = await page.evaluate(async () => {
      const target = document.querySelector<HTMLElement>(
        '[data-production-chat="chat-b"] [data-chat-scroll]',
      );
      if (!target) throw new Error("Missing active chat scroll element");
      target.scrollTop = Math.floor((target.scrollHeight - target.clientHeight) / 2);
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      // Let content-visibility replace intrinsic estimates for the newly
      // exposed middle rows before recording the reader's stable position.
      await window.__isoladeProductionChatHarness?.waitFrames(3);
      return target.scrollTop;
    });
    await page.evaluate(() =>
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-a"),
    );
    const restoredReadingPosition = await page.evaluate(() =>
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-b"),
    );
    expect(
      Math.abs((restoredReadingPosition?.scrollTop ?? 0) - readingScrollTop),
    ).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(3));
    const settledReadingPosition = await page
      .locator('[data-production-chat="chat-b"] [data-chat-scroll]')
      .evaluate((element) => element.scrollTop);
    expect(Math.abs(settledReadingPosition - readingScrollTop)).toBeLessThanOrEqual(1);

    const retainedRow = page.locator('[data-message-id="chat-a-production-m1"]');
    const retainedNode = await retainedRow.elementHandle();
    expect(retainedNode).not.toBeNull();

    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(2));
    await page.evaluate(() => window.__isoladeProductionChatHarness?.resetMetrics());
    for (let iteration = 0; iteration < chatCount * 2; iteration++) {
      const chatId = `chat-${String.fromCharCode(97 + (iteration % chatCount))}`;
      await page.evaluate((id) => window.__isoladeProductionChatHarness?.switchChat(id), chatId);
      await expect(
        page.locator(`[data-production-chat="${chatId}"][data-active="true"]`),
      ).toHaveCSS("opacity", "1");
    }

    expect(await retainedRow.evaluate((row, previous) => row === previous, retainedNode)).toBe(
      true,
    );
    expect(transcriptRequests.length).toBe(warmRequestCount);
    const switchWork = await page.evaluate(() => window.__isoladeProductionChatHarness?.metrics());
    expect(switchWork?.markdownRenders).toBe(0);
    expect(switchWork?.markdownInputBytes).toBe(0);
    expect(switchWork?.parserInputBytes).toBe(0);
    expect(switchWork?.historyMappings).toBe(0);
    expect(switchWork?.historicalRowRenders).toBe(0);
    expect(switchWork?.codeHighlightRuns).toBe(0);
  });

  test("production Chat preserves a live row across hidden detach and resume", async ({ page }) => {
    const messageId = "chat-a-live-production";
    let streamRequests = 0;
    let releaseFirstStream!: () => void;
    const firstStreamRelease = new Promise<void>((resolve) => {
      releaseFirstStream = resolve;
    });

    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      const match = new URL(route.request().url()).pathname.match(/\/chats\/([^/]+)\/transcript$/);
      const chatId = match?.[1];
      if (!chatId) {
        await route.abort();
        return;
      }
      const transcript = transcriptFixture(chatId, 5);
      await route.fulfill({
        json:
          chatId === "chat-a"
            ? {
                ...transcript,
                inFlight: {
                  messageId,
                  lastSeq: 0,
                  chunks: [{ kind: "text", text: "Retained partial" }],
                },
              }
            : transcript,
      });
    });
    await page.route("**/messages/*/stream?*", async (route) => {
      streamRequests++;
      if (streamRequests === 1) {
        await firstStreamRelease;
        await route.abort("connectionaborted").catch(() => {});
        return;
      }
      const content = `Retained partial after resume ${"hidden catch-up content ".repeat(
        40,
      )}HIDDEN-CATCHUP-END`;
      const snapshot = {
        messageId,
        lastSeq: 1,
        chunks: [{ kind: "text", text: content }],
        metaEvents: [],
        status: "done",
        message: {
          id: messageId,
          chatId: "chat-a",
          role: "assistant",
          content,
          parentId: "chat-a-production-m4",
          createdAt: new Date(10_000).toISOString(),
        },
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\nevent: done\ndata: null\n\n`,
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=2");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    const liveRow = page.locator(`[data-message-id="${messageId}"]`);
    await expect(liveRow).toContainText("Retained partial");
    const retainedNode = await liveRow.elementHandle();
    expect(retainedNode).not.toBeNull();
    await expect.poll(() => streamRequests).toBe(1);

    await page.evaluate(() => window.__isoladeProductionChatHarness?.switchChat("chat-b"));
    releaseFirstStream();
    await page.evaluate(() => window.__isoladeProductionChatHarness?.switchChat("chat-a"));

    await expect.poll(() => streamRequests).toBeGreaterThanOrEqual(2);
    await expect(liveRow).toContainText("HIDDEN-CATCHUP-END", { timeout: 750 });
    expect(await liveRow.evaluate((row, previous) => row === previous, retainedNode)).toBe(true);
  });

  test("production Chat does not follow live output after the reader leaves the bottom", async ({
    page,
  }) => {
    const messageId = "chat-a-reader-production";
    let releaseStream!: () => void;
    const streamRelease = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const initial = "Initial live fragment.";
    const appended = `\n\n${"A newly arriving paragraph grows below the reader. ".repeat(6)}`;

    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      await route.fulfill({
        json: {
          ...transcriptFixture("chat-a"),
          inFlight: {
            messageId,
            lastSeq: 0,
            chunks: [{ kind: "text", text: initial }],
          },
        },
      });
    });
    await page.route("**/messages/*/stream?*", async (route) => {
      await streamRelease;
      const snapshot = {
        messageId,
        lastSeq: 0,
        chunks: [{ kind: "text", text: initial }],
        metaEvents: [],
        status: "running",
        message: null,
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` +
          `id: 1\nevent: delta\ndata: ${JSON.stringify(appended)}\n\n` +
          "event: done\ndata: null\n\n",
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    const scrollElement = page.locator('[data-production-chat="chat-a"] [data-chat-scroll]');
    const liveRow = page.locator(`[data-message-id="${messageId}"]`);
    await expect(liveRow).toContainText(initial);
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(3));
    releaseStream();
    await expect
      .poll(async () => (await liveRow.textContent())?.length ?? 0)
      .toBeGreaterThan(initial.length);
    const readerAnchorId = "chat-a-production-m30";
    const readerAnchor = page.locator(`[data-message-id="${readerAnchorId}"]`);
    // Move to a known row directly. This avoids keyboard-scroll animation and
    // lets the jump button confirm that Chat has consumed the reader's scroll
    // state before the rest of the streamed response settles.
    for (let pass = 0; pass < 2; pass++) {
      await readerAnchor.evaluate((row) => {
        row.scrollIntoView({ block: "start" });
        const scroller = row.closest<HTMLElement>("[data-chat-scroll]");
        scroller?.scrollBy(0, -96);
        scroller?.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
      await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(2));
    }
    const before = await scrollElement.evaluate((element) => {
      const anchor = element.querySelector<HTMLElement>(
        '[data-message-id="chat-a-production-m30"]',
      );
      if (!anchor?.dataset.messageId) throw new Error("Missing reader anchor");
      return {
        anchorId: anchor.dataset.messageId,
        anchorTop: anchor.getBoundingClientRect().top,
        scrollTop: element.scrollTop,
        distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      };
    });
    expect(before.distance).toBeGreaterThan(500);
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    const after = await scrollElement.evaluate((element, anchorId) => {
      const anchor = element.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
      if (!anchor) throw new Error("Missing retained reader anchor");
      return {
        anchorTop: anchor.getBoundingClientRect().top,
        scrollTop: element.scrollTop,
        distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      };
    }, before.anchorId);
    expect(Math.abs(after.anchorTop - before.anchorTop)).toBeLessThanOrEqual(1);
    expect(after.distance).toBeGreaterThan(500);
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  });

  test("production Chat lands live reasoning whole while it paces the answer", async ({ page }) => {
    const messageId = "chat-a-thought-reveal-production";
    const reasoning =
      "Reasoning is not the answer, so it arrives in one piece rather than a character at a time. ".repeat(
        3,
      );
    // Long enough that pacing it out takes a couple of seconds even at the
    // catch-up rate, so the frame this test reads is unambiguously mid-reveal.
    const answer = "The answer itself is paced out for a reader. ".repeat(30);
    let releaseTurn!: () => void;
    const turnRelease = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      await route.fulfill({ json: transcriptFixture("chat-a", 4) });
    });
    await page.route("**/api/instances/*/chats/chat-a/messages", async (route) => {
      await turnRelease;
      const userMessage = {
        id: "chat-a-thought-reveal-user",
        chatId: "chat-a",
        role: "user",
        content: "Think first",
        parentId: "chat-a-production-m3",
        createdAt: new Date(20_000).toISOString(),
      };
      const thought = { id: "live-thought", provider: "claude" };
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `event: user_message\ndata: ${JSON.stringify(userMessage)}\n\n` +
          `event: message_id\ndata: ${JSON.stringify(messageId)}\n\n` +
          `id: 0\nevent: thinking_start\ndata: ${JSON.stringify(thought)}\n\n` +
          `id: 1\nevent: thinking_delta\ndata: ${JSON.stringify({ ...thought, text: reasoning })}\n\n` +
          `id: 2\nevent: thinking_tokens\ndata: ${JSON.stringify({ ...thought, tokens: 412 })}\n\n` +
          `id: 3\nevent: delta\ndata: ${JSON.stringify(answer)}\n\n` +
          "event: done\ndata: null\n\n",
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    await page
      .getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)")
      .fill("Think first");
    await page.getByRole("button", { name: "Send" }).click();
    releaseTurn();

    // As soon as the turn has a thought to show, that thought already carries
    // every character of the reasoning while the answer under it is still a
    // prefix of what the provider has already sent. Both are read in one pass
    // over the DOM so they describe the same frame.
    const liveRow = page.locator(`[data-message-id="${messageId}"]`);
    const thoughtRow = liveRow.locator('[data-thinking-provider="claude"]');
    await thoughtRow.waitFor();
    const frame = await liveRow.evaluate((row) => ({
      thought: row.querySelector("[data-thinking-provider]")?.textContent ?? "",
      whole: row.textContent ?? "",
    }));
    expect(frame.thought).toContain(reasoning.trimEnd());
    expect(frame.whole).not.toContain(answer.trimEnd());
    await expect(thoughtRow.locator("[data-thinking-body]")).toHaveAttribute(
      "data-thinking-body",
      "closed",
    );

    await expect(liveRow).toContainText(answer.trimEnd());
    await expect(thoughtRow).toContainText("412 tokens");
  });

  test("production Chat reveals newly received visible text and keeps a pinned reader", async ({
    page,
  }) => {
    const messageId = "chat-a-reveal-production";
    const answer = "Visible output arrives one character at a time. ".repeat(6);
    let releaseTurn!: () => void;
    const turnRelease = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      const chatId = route.request().url().includes("/chats/chat-b/") ? "chat-b" : "chat-a";
      await route.fulfill({ json: transcriptFixture(chatId, 20) });
    });
    await page.route("**/api/instances/*/chats/chat-a/messages", async (route) => {
      await turnRelease;
      const userMessage = {
        id: "chat-a-reveal-user",
        chatId: "chat-a",
        role: "user",
        content: "Show the reveal",
        parentId: "chat-a-production-m19",
        createdAt: new Date(20_000).toISOString(),
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `event: user_message\ndata: ${JSON.stringify(userMessage)}\n\n` +
          `event: message_id\ndata: ${JSON.stringify(messageId)}\n\n` +
          `id: 0\nevent: delta\ndata: ${JSON.stringify(answer)}\n\n` +
          "event: done\ndata: null\n\n",
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=2");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    const activeChat = page.locator('[data-production-chat="chat-a"]');
    await activeChat
      .getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)")
      .fill("Show the reveal");
    await activeChat.getByRole("button", { name: "Send" }).click();
    releaseTurn();

    const liveRow = page.locator(`[data-message-id="${messageId}"]`);
    await expect.poll(async () => (await liveRow.textContent())?.length ?? 0).toBeGreaterThan(0);
    const firstLength = (await liveRow.textContent())?.length ?? 0;
    expect(firstLength).toBeLessThan(answer.length);
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(2));
    const secondLength = (await liveRow.textContent())?.length ?? 0;
    expect(secondLength).toBeGreaterThan(firstLength);
    expect(secondLength).toBeLessThan(answer.length);

    const firstHotFrameText = await page.evaluate((id) => {
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-b");
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-a");
      return document.querySelector(`[data-production-chat="chat-a"] [data-message-id="${id}"]`)
        ?.textContent;
    }, messageId);
    expect(firstHotFrameText).toContain(answer.trimEnd());
    await expect(liveRow).toContainText(answer);
    await expect(activeChat.getByRole("button", { name: "Send" })).toBeVisible();
    const distanceFromBottom = await page
      .locator('[data-production-chat="chat-a"] [data-chat-scroll]')
      .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
    expect(distanceFromBottom).toBeLessThanOrEqual(2);
  });

  test("production Chat skips reveal backlog accumulated while the app is hidden", async ({
    page,
  }) => {
    const messageId = "chat-a-background-reveal-production";
    const answer = "Background output must be complete when the app returns. ".repeat(24);
    let releaseTurn!: () => void;
    const turnRelease = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      await route.fulfill({ json: transcriptFixture("chat-a", 5) });
    });
    await page.route("**/api/instances/*/chats/chat-a/messages", async (route) => {
      await turnRelease;
      const userMessage = {
        id: "chat-a-background-reveal-user",
        chatId: "chat-a",
        role: "user",
        content: "Run in the background",
        parentId: "chat-a-production-m4",
        createdAt: new Date(20_000).toISOString(),
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `event: user_message\ndata: ${JSON.stringify(userMessage)}\n\n` +
          `event: message_id\ndata: ${JSON.stringify(messageId)}\n\n` +
          `id: 0\nevent: delta\ndata: ${JSON.stringify(answer)}\n\n` +
          "event: done\ndata: null\n\n",
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    await page
      .getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)")
      .fill("Run in the background");
    await page.getByRole("button", { name: "Send" }).click();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    releaseTurn();

    const row = page.locator(`[data-message-id="${messageId}"]`);
    await expect(row).toContainText(answer, { timeout: 750 });
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(2));
    await expect(row).toContainText(answer);
  });

  test("production Chat shows bounded tool summaries and expands only the selected tool", async ({
    page,
  }) => {
    const messageId = "chat-a-production-m3";
    const firstPreview = `${"a".repeat(1024)}…`;
    const secondPreview = `${"b".repeat(1024)}…`;
    const fullChunks = [
      {
        kind: "tool",
        id: "tool-first",
        name: "Shell",
        input: { command: "echo first full command" },
        status: "done",
      },
      {
        kind: "tool",
        id: "tool-second",
        name: "Shell",
        input: { command: "echo second full command" },
        status: "done",
      },
    ];
    const detailRequests: string[] = [];

    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      const transcript = {
        ...transcriptFixture("chat-a", 4),
        chunksByMessage: {
          [messageId]: [
            {
              ...fullChunks[0],
              summary: "echo first full command",
              input: firstPreview,
              detailsAvailable: true,
            },
            {
              ...fullChunks[1],
              summary: "echo second full command",
              input: secondPreview,
              detailsAvailable: true,
            },
          ],
        },
      };
      await route.fulfill({ json: transcript });
    });
    await page.route("**/api/instances/*/chats/*/render?*", async (route) => {
      const toolId = new URL(route.request().url()).searchParams.get("toolId") ?? "";
      detailRequests.push(toolId);
      await route.fulfill({
        json: {
          chunksByMessage: {
            [messageId]: fullChunks.filter((chunk) => chunk.id === toolId),
          },
        },
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    const first = page.locator('[data-tool-id="tool-first"]');
    const second = page.locator('[data-tool-id="tool-second"]');
    await expect(first.getByRole("button")).toContainText("echo first full command");
    await expect(second.getByRole("button")).toContainText("echo second full command");
    const secondNode = await second.elementHandle();
    expect(secondNode).not.toBeNull();

    await first.getByRole("button").click();
    await expect(first.locator("pre")).toContainText("echo first full command");
    await expect(second.locator("pre")).not.toContainText("echo second full command");
    expect(await second.evaluate((node, previous) => node === previous, secondNode)).toBe(true);

    await second.getByRole("button").click();
    await expect(second.locator("pre")).toContainText("echo second full command");
    expect(detailRequests).toEqual(["tool-first", "tool-second"]);

    await first.getByRole("button").click();
    await first.getByRole("button").click();
    await expect(first.locator("pre")).toContainText("echo first full command");
    expect(detailRequests).toEqual(["tool-first", "tool-second"]);
  });

  test("production Chat refreshes an open tool as live details advance across resume", async ({
    page,
  }) => {
    const messageId = "chat-a-live-tool-production";
    const toolId = "live-shell";
    const fullInput = { command: `echo ${"input".repeat(400)}` };
    const fullOutput = `result ${"output".repeat(500)} LIVE-TOOL-END`;
    const inputPreview = `${"i".repeat(1024)}…`;
    const outputPreview = `${"o".repeat(2048)}…`;
    let streamRequests = 0;
    let detailStage: "input" | "result" = "input";
    const detailRequests: string[] = [];
    let releaseInput!: () => void;
    let releaseResult!: () => void;
    const inputRelease = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    const resultRelease = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });

    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      await route.fulfill({
        json: {
          ...transcriptFixture("chat-a", 4),
          inFlight: {
            messageId,
            lastSeq: 0,
            chunks: [{ kind: "tool", id: toolId, name: "Shell", status: "running" }],
          },
        },
      });
    });
    await page.route("**/messages/*/stream?*", async (route) => {
      streamRequests++;
      if (streamRequests === 1) {
        await inputRelease;
        const snapshot = {
          messageId,
          lastSeq: 0,
          chunks: [{ kind: "tool", id: toolId, name: "Shell", status: "running" }],
          metaEvents: [],
          status: "running",
          message: null,
        };
        await route.fulfill({
          contentType: "text/event-stream",
          body:
            `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` +
            `id: 1\nevent: tool_call_input\ndata: ${JSON.stringify({
              id: toolId,
              input: inputPreview,
              summary: fullInput.command.slice(0, 512),
              detailsAvailable: true,
            })}\n\n`,
        });
        return;
      }
      await resultRelease;
      detailStage = "result";
      const snapshot = {
        messageId,
        lastSeq: 1,
        chunks: [
          {
            kind: "tool",
            id: toolId,
            name: "Shell",
            summary: fullInput.command.slice(0, 512),
            input: inputPreview,
            status: "running",
            detailsAvailable: true,
          },
        ],
        metaEvents: [],
        status: "running",
        message: null,
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` +
          `id: 2\nevent: tool_call_result\ndata: ${JSON.stringify({
            id: toolId,
            output: outputPreview,
            detailsAvailable: true,
          })}\n\n` +
          "event: done\ndata: null\n\n",
      });
    });
    await page.route("**/api/instances/*/chats/*/render?*", async (route) => {
      const requestedTool = new URL(route.request().url()).searchParams.get("toolId") ?? "";
      detailRequests.push(`${detailStage}:${requestedTool}`);
      await route.fulfill({
        json: {
          chunksByMessage: {
            [messageId]: [
              {
                kind: "tool",
                id: toolId,
                name: "Shell",
                input: fullInput,
                ...(detailStage === "result" ? { output: fullOutput } : {}),
                status: detailStage === "result" ? "done" : "running",
              },
            ],
          },
        },
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    const tool = page.locator(`[data-tool-id="${toolId}"]`);
    await expect(tool).toBeVisible();
    await tool.getByRole("button").click();
    releaseInput();

    await expect(tool.locator("pre")).toContainText(fullInput.command);
    expect(detailRequests).toEqual([`input:${toolId}`]);
    await expect.poll(() => streamRequests).toBeGreaterThanOrEqual(2);

    releaseResult();
    await expect(tool).toContainText("LIVE-TOOL-END");
    expect(detailRequests).toEqual([`input:${toolId}`, `result:${toolId}`]);

    await tool.getByRole("button").click();
    await tool.getByRole("button").click();
    await expect(tool).toContainText("LIVE-TOOL-END");
    expect(detailRequests).toEqual([`input:${toolId}`, `result:${toolId}`]);
  });

  test("production Chat retains the partial row through error and stop", async ({ page }) => {
    let mode: "error" | "stop" = "error";
    let releaseStream!: () => void;
    let streamRelease = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      const transcript = transcriptFixture("chat-a", 5);
      const messageId = `chat-a-${mode}-production`;
      await route.fulfill({
        json: {
          ...transcript,
          inFlight: {
            messageId,
            lastSeq: 0,
            chunks: [{ kind: "text", text: `${mode} partial` }],
          },
        },
      });
    });
    await page.route("**/messages/*/stream?*", async (route) => {
      const currentMode = mode;
      const messageId = `chat-a-${currentMode}-production`;
      await streamRelease;
      if (currentMode === "stop") {
        await route.abort("connectionaborted").catch(() => {});
        return;
      }
      const snapshot = {
        messageId,
        lastSeq: 0,
        chunks: [{ kind: "text", text: "error partial" }],
        metaEvents: [],
        status: "running",
        message: null,
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` +
          "event: error\ndata: provider failed\n\n",
      });
    });
    await page.route("**/api/instances/*/chats/*/messages/*", async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 204 });
      } else {
        await route.fallback();
      }
    });

    const openMode = async (nextMode: "error" | "stop") => {
      mode = nextMode;
      streamRelease = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      await page.goto("/test/browser/harness/index.html?production=1&chats=1");
      await page.waitForFunction(
        () => document.documentElement.dataset.productionHarnessReady === "true",
      );
      const row = page.locator(`[data-message-id="chat-a-${nextMode}-production"]`);
      await expect(row).toContainText(`${nextMode} partial`);
      return { row, node: await row.elementHandle() };
    };

    const failed = await openMode("error");
    releaseStream();
    await expect(page.getByText("Error: provider failed")).toBeVisible();
    expect(await failed.row.evaluate((row, previous) => row === previous, failed.node)).toBe(true);

    const stopped = await openMode("stop");
    await page.getByRole("button", { name: "Stop" }).click();
    releaseStream();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    expect(await stopped.row.evaluate((row, previous) => row === previous, stopped.node)).toBe(
      true,
    );
    await expect(stopped.row).toContainText("stop partial");
    await expect(stopped.row.getByText("Agent interrupted")).toBeVisible();
  });

  test("production turn lifecycle does not remap warm history", async ({ page }) => {
    let releaseTurn!: () => void;
    const turnRelease = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      await route.fulfill({ json: transcriptFixture("chat-a") });
    });
    await page.route("**/api/instances/*/chats/chat-a/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await turnRelease;
      const userMessage = {
        id: "production-sent-user",
        chatId: "chat-a",
        role: "user",
        content: "Run the lifecycle gate",
        parentId: "chat-a-production-m59",
        createdAt: new Date(20_000).toISOString(),
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `event: user_message\ndata: ${JSON.stringify(userMessage)}\n\n` +
          'event: message_id\ndata: "production-sent-assistant"\n\n' +
          'id: 0\nevent: delta\ndata: "Lifecycle complete"\n\n' +
          "event: done\ndata: null\n\n",
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    await expect(page.locator('[data-production-chat="chat-a"] [data-message-id]')).toHaveCount(60);
    await page.evaluate(() => window.__isoladeProductionChatHarness?.resetMetrics());
    await page
      .getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)")
      .fill("Run the lifecycle gate");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit message" }).first()).toBeEnabled();
    expect(
      (await page.evaluate(() => window.__isoladeProductionChatHarness?.metrics()))
        ?.historyMappings,
    ).toBe(0);

    // The composer keeps a single button through the turn: Stop while there is
    // nothing to send, Send (which queues) as soon as a draft is typed.
    const composer = page.getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)");
    await composer.fill("a draft typed mid-turn");
    await expect(page.getByRole("button", { name: "Queue message" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await composer.fill("");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Queue message" })).toHaveCount(0);

    releaseTurn();
    await expect(page.getByText("Lifecycle complete")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit message" }).first()).toBeEnabled();
    const work = await page.evaluate(() => window.__isoladeProductionChatHarness?.metrics());
    expect(work?.historyMappings).toBe(0);
    expect(work?.historicalRowRenders).toBe(0);
  });

  // The composer's cost ticker reads the live `usage` frame through a cast, so
  // this is what holds the published payload and the field the UI reads
  // together. The count-up in between is deliberately not asserted: sampling
  // frames would only be testing an easing curve, flakily.
  test("composer shows what the chat has cost across agents once usage lands", async ({ page }) => {
    const tokens = {
      inputTokens: 12_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 400,
      reasoningOutputTokens: 0,
      totalTokens: 12_400,
    };
    await page.route("**/api/instances/*/chats/*/transcript?*", async (route) => {
      await route.fulfill({ json: transcriptFixture("chat-a") });
    });
    await page.route("**/api/instances/*/chats/chat-a/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const userMessage = {
        id: "production-cost-user",
        chatId: "chat-a",
        role: "user",
        content: "Spend something",
        parentId: "chat-a-production-m59",
        createdAt: new Date(20_000).toISOString(),
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          `event: user_message\ndata: ${JSON.stringify(userMessage)}\n\n` +
          'event: message_id\ndata: "production-cost-assistant"\n\n' +
          'id: 0\nevent: delta\ndata: "Done"\n\n' +
          // The server publishes what the chat has cost so far, agent switches
          // included, so the composer never has to add anything up.
          `id: 1\nevent: usage\ndata: ${JSON.stringify({
            last: tokens,
            total: tokens,
            costUsd: 1.25,
          })}\n\n` +
          "event: done\ndata: null\n\n",
      });
    });

    await page.goto("/test/browser/harness/index.html?production=1&chats=1");
    await page.waitForFunction(
      () => document.documentElement.dataset.productionHarnessReady === "true",
    );
    // The readout is a hover-card trigger, so it is a focusable button rather
    // than plain text.
    const cost = page.getByRole("button", {
      name: "What this chat has cost so far, across every agent it has run on",
    });
    // A chat that has never streamed reads zero, so the figure is there from the
    // first message rather than appearing partway through.
    await expect(cost).toHaveText("$0.00");

    await page
      .getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)")
      .fill("Spend something");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(cost).toHaveText("$1.25");
  });

  // The composer's other running figure: whether the agent is working, and for
  // how long. It has to survive the turn ending, which is the point of it: the
  // last turn's time stays readable next to what the chat cost while the next
  // message is typed.
  test("composer times the turn while it runs and holds the figure once it ends", async ({
    page,
  }) => {
    let releaseTurn!: () => void;
    const turnHeld = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    await page.route("**/api/instances/*/chats/chat-a/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await turnHeld;
      await route.fulfill({
        contentType: "text/event-stream",
        body:
          'event: message_id\ndata: "production-clock-assistant"\n\n' +
          'id: 0\nevent: delta\ndata: "Done"\n\n' +
          "event: done\ndata: null\n\n",
      });
    });

    await openProductionHarness(page, 1, { messages: 2 });
    // Nothing to report before the chat's first turn: the fixture's chat row
    // carries no duration, so the slot is empty rather than reading zero.
    await expect(page.getByLabel(/^(Working|Last turn took)/)).toHaveCount(0);

    await page
      .getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)")
      .fill("Take your time");
    await page.getByRole("button", { name: "Send" }).click();

    const working = page.getByLabel(/^Working/);
    await expect(working).toBeVisible();
    await expect(working.locator(".animate-spin")).toBeVisible();
    // Counting, not frozen at its first frame.
    await expect(working).toHaveText(/[1-9]s$/, { timeout: 5_000 });

    releaseTurn();
    const settled = page.getByLabel(/^Last turn took/);
    await expect(settled).toBeVisible();
    await expect(settled).toHaveText(/^[0-9]+s$/);
    await expect(settled.locator(".animate-spin")).toHaveCount(0);
    // And it has the send corner to itself, past everything about the chat
    // rather than about the moment: the cost sits with the model on the left.
    const times = await settled.boundingBox();
    const cost = await page
      .getByRole("button", {
        name: "What this chat has cost so far, across every agent it has run on",
      })
      .boundingBox();
    expect(cost!.x + cost!.width).toBeLessThanOrEqual(times!.x + 1);
  });

  // Where a spinner's rotation lives decides whether it turns in place. Rotating
  // the <svg> element pivots on its CSS box, and that box rarely lands on a
  // whole device pixel: the turn clock's spinner moves by one 7.2px monospace
  // character the moment a turn crosses a minute, and in WKWebView the leftover
  // fraction became the radius of a wobble. Rotating the geometry inside the
  // icon pivots on the viewBox centre, which no pixel grid can shift.
  test("spins a lucide icon around its own centre rather than its CSS box", async ({ page }) => {
    await page.goto("/test/browser/harness/index.html");
    const spun = await page.evaluate(() => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("class", "size-3 animate-spin");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      // lucide's Loader2 arc.
      path.setAttribute("d", "M21 12a9 9 0 1 1-6.219-8.56");
      svg.append(path);
      document.body.append(svg);
      const read = (el: Element) => {
        const style = getComputedStyle(el);
        return {
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          transformOrigin: style.transformOrigin,
          overflow: style.overflow,
        };
      };
      const measured = { element: read(svg), geometry: read(path) };
      svg.remove();
      return measured;
    });
    expect(spun.element.animationName).toBe("none");
    // Named rather than merely present: the rotation is handed the same theme
    // animation the utility uses, so a renamed one has to fail here instead of
    // leaving every spinner in the app sitting still.
    expect(spun.geometry.animationName).toBe("spin");
    expect(spun.geometry.animationDuration).toBe("1s");
    // The centre of the 24x24 user space every lucide icon is drawn around.
    expect(spun.geometry.transformOrigin).toBe("12px 12px");
    // The viewport stays put while its contents turn, so it must not clip what
    // an icon like RefreshCw reaches on the diagonal.
    expect(spun.element.overflow).toBe("visible");
  });

  // The model controls stay interactive mid-turn and their edits are local until
  // the next send flushes them. Fast mode has to ride that flush like model and
  // effort do: left out of it, the bolt went on showing a premium rate the server
  // had never been told about, for every turn that followed.
  test("flushes a mid-turn fast-mode toggle with the next send", async ({ page }) => {
    const patches: Record<string, unknown>[] = [];
    let releaseTurn!: () => void;
    const turnHeld = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    await page.route("**/api/instances/*/chats/chat-a", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      await route.fulfill({
        json: {
          id: "chat-a",
          instanceId: "instance-production-harness",
          model: "gpt-5.6-sol",
          provider: "openai",
          effort: "medium",
          fastMode: body.fastMode === true,
          claudeSessionId: null,
          codexThreadId: null,
          inputTokens: null,
          cachedInputTokens: null,
          cacheCreationInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          costUsd: null,
          lastInputTokens: null,
          lastCachedInputTokens: null,
          lastCacheCreationInputTokens: null,
          lastOutputTokens: null,
          lastReasoningOutputTokens: null,
          modelContextWindow: null,
          compacted: null,
          activeLeafId: null,
          createdAt: new Date(0).toISOString(),
        },
      });
    });
    // Hold the turn open so the composer stays in its streaming state while the
    // bolt is used, which is the case the flush exists for.
    await page.route("**/api/instances/*/chats/chat-a/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await turnHeld;
      await route.fulfill({
        contentType: "text/event-stream",
        body: "event: done\ndata: null\n\n",
      });
    });
    let queued: Record<string, unknown> | null = null;
    await page.route("**/api/instances/*/chats/chat-a/queue", async (route) => {
      queued = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        json: {
          id: String(queued.id),
          chatId: "chat-a",
          content: String(queued.content),
          mode: "later",
          status: "queued",
          targetMessageId: null,
          error: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      });
    });

    // GPT-5.6 Sol publishes a fast rate card, so the toggle is on offer.
    await openProductionHarness(page, 1, { messages: 2, crossProviderPicker: true });
    const composer = page.getByPlaceholder("Message... (Enter to send, Shift+Enter for newline)");
    await composer.fill("First");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    const fastToggle = page.getByRole("switch", { name: /Fast mode/ });
    await expect(fastToggle).toHaveAttribute("aria-checked", "false");
    await fastToggle.click();
    // Local only while the turn runs: changing the billing rate under a turn
    // already in flight is exactly what the deferral avoids.
    expect(patches).toEqual([]);

    await composer.fill("Second");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect.poll(() => patches).toEqual([{ fastMode: true }]);
    await expect.poll(() => queued).not.toBeNull();

    // And the bolt still reads on, now backed by the server's own answer.
    await expect(fastToggle).toHaveAttribute("aria-checked", "true");
    releaseTurn();
  });

  test("retains two 10k normal-flow chats and isolates switching and live work @stress", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "The controlled performance gate is Chromium-only");
    await openHarness(page, { chats: 2, messages: 10_000 });

    const rows = page.locator("[data-message-id]");
    await expect(rows).toHaveCount(20_000);
    const positionedRows = await rows.evaluateAll(
      (elements) =>
        elements.filter(
          (element) => getComputedStyle(element.parentElement ?? element).position === "absolute",
        ).length,
    );
    expect(positionedRows).toBe(0);

    await resetMetrics(page);
    for (let iteration = 0; iteration < 20; iteration++) {
      const chatId = iteration % 2 === 0 ? "chat-b" : "chat-a";
      await page.evaluate((id) => window.__isoladeRendererHarness?.switchChat(id), chatId);
      const active = page.locator(`[data-chat-id="${chatId}"][data-active="true"]`);
      await expect(active.locator("[data-message-id]").first()).toBeAttached();
      await expect(active).toHaveCSS("opacity", "1");
    }

    const switchWork = await metrics(page);
    expect(switchWork).toBeDefined();
    expect(switchWork?.apiRequests).toBe(0);
    expect(switchWork?.markdownRenders).toBe(0);
    expect(switchWork?.historyMappings).toBe(0);
    expect(switchWork?.historicalRowRenders).toBe(0);
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    await resetMetrics(page);
    await page.evaluate(() => window.__isoladeRendererHarness?.startLive());
    const clientRow = page.locator('[data-message-id="chat-a-live-client"]');
    await expect(clientRow).toBeAttached();
    const originalNode = await clientRow.elementHandle();
    expect(originalNode).not.toBeNull();

    await page.evaluate(() => window.__isoladeRendererHarness?.assignMessageId("chat-a-server"));
    const serverRow = page.locator('[data-message-id="chat-a-server"]');
    await expect(serverRow).toBeAttached();
    expect(await serverRow.evaluate((row, previous) => row === previous, originalNode)).toBe(true);

    const chunks = Array.from(
      { length: 80 },
      (_, index) => `Paragraph ${index} has **streaming Markdown** and a value of ${index}.\n\n`,
    );
    const accumulatedBytes = chunks.reduce(
      (total, _chunk, index) =>
        total + new TextEncoder().encode(chunks.slice(0, index + 1).join("")).byteLength,
      0,
    );
    await page.evaluate(async (parts) => {
      for (const part of parts) {
        window.__isoladeRendererHarness?.appendLive(part);
        await window.__isoladeRendererHarness?.waitFrames(1);
      }
    }, chunks);

    await page.evaluate(() => window.__isoladeRendererHarness?.commitLive());
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    const committedRow = page.locator('[data-message-id="chat-a-server"]');
    expect(await committedRow.evaluate((row, previous) => row === previous, originalNode)).toBe(
      true,
    );

    const liveWork = await metrics(page);
    expect(liveWork).toBeDefined();
    expect(liveWork?.historicalRowRenders).toBe(0);
    expect(liveWork?.historyMappings).toBe(0);
    expect(liveWork?.apiRequests).toBe(0);
    expect(liveWork?.markdownRenders).toBeGreaterThan(0);
    expect(liveWork?.markdownInputBytes).toBeGreaterThan(0);
    expect(liveWork?.markdownInputBytes).toBeLessThan(accumulatedBytes / 3);
    expect(liveWork?.parserInputBytes).toBeGreaterThan(0);
    expect(liveWork?.parserInputBytes).toBeLessThan(accumulatedBytes / 3);
    expect(liveWork?.previewInputBytes).toBeLessThan(accumulatedBytes / 3);
  });

  test("retains sealed highlighted fragments through tail growth and commit", async ({ page }) => {
    await openHarness(page, { messages: 40 });
    await page.evaluate(() => window.__isoladeRendererHarness?.startLive());
    await page.evaluate(() =>
      window.__isoladeRendererHarness?.appendLive(
        "```ts\nconst stable = 42;\n```\n\nTail starts here.",
      ),
    );
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));

    const liveRow = page.locator('[data-message-id="chat-a-live-client"]');
    const code = liveRow.locator("pre code");
    await expect(code).toContainText("const stable = 42");
    const codeNode = await code.elementHandle();
    expect(codeNode).not.toBeNull();

    await resetMetrics(page);
    await page.evaluate(() =>
      window.__isoladeRendererHarness?.appendLive(" The mutable tail keeps growing."),
    );
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    expect(await code.evaluate((node, previous) => node === previous, codeNode)).toBe(true);
    expect((await metrics(page))?.codeHighlightRuns).toBe(0);

    await page.evaluate(() => window.__isoladeRendererHarness?.assignMessageId("stable-server"));
    await page.evaluate(() => window.__isoladeRendererHarness?.commitLive());
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    const committedCode = page.locator('[data-message-id="stable-server"] pre code');
    expect(await committedCode.evaluate((node, previous) => node === previous, codeNode)).toBe(
      true,
    );
    expect((await metrics(page))?.codeHighlightRuns).toBe(0);
  });

  test("keeps proper preview Markdown for long unclosed blocks", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "The controlled performance gate is Chromium-only");
    await openHarness(page, { messages: 40 });
    await page.evaluate(() => window.__isoladeRendererHarness?.startLive());
    await resetMetrics(page);

    const paragraphParts = [
      "**A live emphasized paragraph",
      ...Array.from(
        { length: 12 },
        (_, index) => ` keeps growing with word ${index} and stays proper Markdown`,
      ),
    ];
    await page.evaluate(async (parts) => {
      for (const part of parts) {
        window.__isoladeRendererHarness?.appendLive(part);
        await window.__isoladeRendererHarness?.waitFrames(1);
      }
    }, paragraphParts);

    const liveRow = page.locator('[data-message-id="chat-a-live-client"]');
    await expect(liveRow.locator("strong")).toContainText("A live emphasized paragraph");
    await page.evaluate(() =>
      window.__isoladeRendererHarness?.appendLive("**\n\n```ts\nconst first = 1;"),
    );
    await page.evaluate(async () => {
      for (let index = 0; index < 12; index++) {
        window.__isoladeRendererHarness?.appendLive(`\nconst value${index} = ${index};`);
        await window.__isoladeRendererHarness?.waitFrames(1);
      }
    });

    await expect(liveRow.locator("pre code")).toContainText("const value11 = 11;");
    const work = await metrics(page);
    expect(work?.parserInputBytes).toBeGreaterThan(0);
    expect(work?.markdownInputBytes).toBeGreaterThan(0);
    expect(work?.historicalRowRenders).toBe(0);
    expect(work?.historyMappings).toBe(0);
  });

  test("keeps a long reference-sensitive stream responsive @stress", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "The controlled performance gate is Chromium-only");
    await openHarness(page, { messages: 40 });
    await page.evaluate(() => window.__isoladeRendererHarness?.startLive());
    const stableFences = Array.from(
      { length: 8 },
      (_, index) => `\`\`\`ts\nconst stable${index} = ${index};\n\`\`\``,
    ).join("\n\n");
    await page.evaluate(
      (initial) => window.__isoladeRendererHarness?.appendLive(initial),
      `See [the guide][guide].\n\n[guide]: https://example.com/guide\n\n${stableFences}`,
    );
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    const liveRow = page.locator('[data-message-id="chat-a-live-client"]');
    const stableCode = liveRow.locator("pre code").first();
    await expect(liveRow.locator("pre code")).toHaveCount(8);
    const stableCodeNode = await stableCode.elementHandle();
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    await resetMetrics(page);

    const parts = Array.from(
      { length: 160 },
      (_, index) =>
        `\n\nParagraph ${index} keeps a reference-sensitive response growing with enough ordinary prose to exercise full-document parsing under realistic output.`,
    );
    await page.evaluate(async (streamParts) => {
      for (const part of streamParts) {
        window.__isoladeRendererHarness?.appendLive(part);
        await window.__isoladeRendererHarness?.waitFrames(1);
      }
    }, parts);

    await expect(liveRow.locator('a[href="https://example.com/guide"]')).toHaveText("the guide");
    await expect(stableCode).toContainText("const stable0 = 0;");
    expect(await stableCode.evaluate((node, previous) => node === previous, stableCodeNode)).toBe(
      true,
    );
    await expect(liveRow).toContainText("Paragraph 159");
    const work = await metrics(page);
    expect(work?.parserInputBytes).toBe(0);
    expect(work?.markdownInputBytes).toBeLessThan(4 * 1024 * 1024);
    expect(work?.codeHighlightRuns).toBe(0);
    expect(work?.historicalRowRenders).toBe(0);
    expect(work?.historyMappings).toBe(0);
  });

  test("reflows on pane resize without parsing or losing the reader anchor", async ({ page }) => {
    await openHarness(page, { messages: 600 });
    await expect(page.locator("[data-message-id]")).toHaveCount(600);

    const anchorId = "chat-a-m300";
    await page.locator(`[data-message-id="${anchorId}"]`).evaluate((row) => {
      row.scrollIntoView({ block: "start" });
      // Put the row body across the 120px reader-anchor probe. Positioning
      // its exact boundary at the probe makes either adjacent row a valid hit.
      row.closest("[data-scroll-chat]")?.scrollBy(0, -96);
    });
    // Let content-visibility replace intrinsic estimates around the newly
    // exposed page before measuring the resize anchor itself.
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(3));
    await page.locator(`[data-message-id="${anchorId}"]`).evaluate((row) => {
      row.scrollIntoView({ block: "start" });
      row.closest("[data-scroll-chat]")?.scrollBy(0, -96);
    });
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    const probedAnchorId = await page.locator('[data-scroll-chat="chat-a"]').evaluate((scroll) => {
      const viewport = scroll.getBoundingClientRect();
      return document
        .elementFromPoint(viewport.left + viewport.width / 2, viewport.top + 120)
        ?.closest<HTMLElement>("[data-message-row]")?.dataset.messageId;
    });
    expect(probedAnchorId).toBe(anchorId);
    const before = await rowTop(page, anchorId);
    await resetMetrics(page);
    await page.evaluate(() => window.__isoladeRendererHarness?.animateWidth(920, 380, 30));
    const after = await rowTop(page, anchorId);

    expect(Math.abs(after - before)).toBeLessThanOrEqual(12);
    const resizeWork = await metrics(page);
    expect(resizeWork?.markdownRenders).toBe(0);
    expect(resizeWork?.parserInputBytes).toBe(0);
    expect(resizeWork?.previewInputBytes).toBe(0);
    expect(resizeWork?.historicalRowRenders).toBe(0);
    await expect(
      page.locator('[data-chat-id="chat-a"][data-active="true"] [data-message-id]'),
    ).not.toHaveCount(0);
  });

  test("preserves the same visible row across prepends and a concurrent resize", async ({
    page,
  }) => {
    await openHarness(page, { messages: 600 });
    const anchorId = "chat-a-m40";
    await page.locator(`[data-message-id="${anchorId}"]`).evaluate((row) => {
      row.scrollIntoView({ block: "start" });
      row.closest("[data-scroll-chat]")?.scrollBy(0, -96);
    });
    const before = await rowTop(page, anchorId);
    await resetMetrics(page);

    await page.evaluate(() => window.__isoladeRendererHarness?.prepend(60));
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    const afterFirst = await rowTop(page, anchorId);
    expect(Math.abs(afterFirst - before)).toBeLessThanOrEqual(3);

    await page.evaluate(() => window.__isoladeRendererHarness?.prepend(60));
    await page.evaluate(() => window.__isoladeRendererHarness?.waitFrames(2));
    const afterSecond = await rowTop(page, anchorId);
    expect(Math.abs(afterSecond - before)).toBeLessThanOrEqual(3);

    await page.evaluate(async () => {
      window.__isoladeRendererHarness?.prepend(60);
      await window.__isoladeRendererHarness?.animateWidth(920, 620, 18);
      await window.__isoladeRendererHarness?.waitFrames(2);
    });
    const afterResize = await rowTop(page, anchorId);
    expect(Math.abs(afterResize - before)).toBeLessThanOrEqual(12);

    const prependWork = await metrics(page);
    expect(prependWork?.apiRequests).toBe(3);
    expect(prependWork?.markdownRenders).toBeGreaterThan(0);
  });
});
