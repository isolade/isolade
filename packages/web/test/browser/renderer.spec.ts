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

function transcriptFixture(chatId: string, count = 60, wrapping = false) {
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
  return { messages, hasMore: false, chunksByMessage: {}, inFlight: null };
}

async function openProductionHarness(
  page: Page,
  chatCount: number,
  options: {
    chatsPerInstance?: number;
    instancePanes?: boolean;
    messages?: number;
    wrappingRows?: boolean;
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
      json: transcriptFixture(chatId, options.messages ?? 60, options.wrappingRows),
    });
  });
  const parameters = new URLSearchParams({ production: "1", chats: String(chatCount) });
  if (options.instancePanes) parameters.set("instancePanes", "1");
  if (options.chatsPerInstance) {
    parameters.set("chatsPerInstance", String(options.chatsPerInstance));
  }
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

test.describe("message renderer browser gate", () => {
  test("retains an instance chat's DOM and reading position across sidebar switches", async ({
    page,
  }) => {
    const requests = await openProductionHarness(page, 2, {
      instancePanes: true,
      wrappingRows: true,
    });
    await expect(page.locator("[data-retained-instance] [data-message-id]")).toHaveCount(120);
    const scrollElement = page.locator('[data-retained-instance="instance-a"] [data-chat-scroll]');
    await scrollElement.hover();
    let readerState = { distanceFromBottom: 0, scrollTop: 0 };
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.mouse.wheel(0, -1_200);
      await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(3));
      readerState = await scrollElement.evaluate((element) => ({
        distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
        scrollTop: element.scrollTop,
      }));
      if (readerState.distanceFromBottom > 1_000) break;
    }
    expect(readerState.distanceFromBottom).toBeGreaterThan(500);
    await expect(
      page.locator('[data-retained-instance="instance-a"] [aria-label="Jump to latest"]'),
    ).toBeVisible();
    const readingPosition = readerState.scrollTop;
    const retainedRow = page.locator('[data-message-id="chat-a-production-m30"]');
    const retainedNode = await retainedRow.elementHandle();
    const requestCount = requests.length;

    await page.evaluate(() =>
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-b"),
    );
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(3));
    const restoredImmediately = await page.evaluate(() =>
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-a"),
    );
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(3));

    const settledPosition = await scrollElement.evaluate((element) => element.scrollTop);
    expect(Math.abs((restoredImmediately?.scrollTop ?? 0) - readingPosition)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(settledPosition - readingPosition)).toBeLessThanOrEqual(1);

    const readingAnchor = await scrollElement.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>("[data-message-row]")].find(
        (candidate) => candidate.getBoundingClientRect().bottom > viewport.top + 120,
      );
      if (!row?.dataset.messageId) throw new Error("Missing visible message anchor");
      return { id: row.dataset.messageId, top: row.getBoundingClientRect().top };
    });
    await page.evaluate(() =>
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-b"),
    );
    await page.locator("[data-production-stage]").evaluate((stage) => {
      stage.style.width = "620px";
      stage.style.alignSelf = "center";
    });
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(3));
    await page.evaluate(() =>
      window.__isoladeProductionChatHarness?.switchChatImmediately("chat-a"),
    );
    const anchorRow = page.locator(
      `[data-retained-instance="instance-a"] [data-message-id="${readingAnchor.id}"]`,
    );
    const restoredAnchorTop = await anchorRow.evaluate((row) => row.getBoundingClientRect().top);
    expect(Math.abs(restoredAnchorTop - readingAnchor.top)).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(3));
    expect(
      Math.abs(
        (await anchorRow.evaluate((row) => row.getBoundingClientRect().top)) - readingAnchor.top,
      ),
    ).toBeLessThanOrEqual(1);
    expect(await retainedRow.evaluate((row, previous) => row === previous, retainedNode)).toBe(
      true,
    );
    expect(requests).toHaveLength(requestCount);
  });

  test("bounds and retains a multi-instance multi-chat working set @stress", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "The controlled memory gate is Chromium-only");
    const instanceCount = 8;
    const chatsPerInstance = 3;
    const messagesPerChat = 60;
    const totalChats = instanceCount * chatsPerInstance;
    const requests = await openProductionHarness(page, totalChats, {
      chatsPerInstance,
      instancePanes: true,
      messages: messagesPerChat,
    });
    await expect(page.locator("[data-retained-instance]")).toHaveCount(instanceCount);
    await expect(page.locator("[data-retained-instance] [data-message-id]")).toHaveCount(
      totalChats * messagesPerChat,
    );
    expect(new Set(requests).size).toBe(totalChats);
    const warmRequestCount = requests.length;

    await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(2));
    await page.evaluate(() => window.__isoladeProductionChatHarness?.resetMetrics());
    const instanceChatIds = Array.from(
      { length: instanceCount },
      (_, index) => `chat-${String.fromCharCode(97 + index * chatsPerInstance)}`,
    );
    for (let round = 0; round < 3; round++) {
      for (const [instanceIndex, chatId] of instanceChatIds.entries()) {
        await page.evaluate((id) => window.__isoladeProductionChatHarness?.switchChat(id), chatId);
        const tabs = page.locator(
          `[data-retained-instance="instance-${String.fromCharCode(97 + instanceIndex)}"] [role="tab"]`,
        );
        await expect(tabs).toHaveCount(chatsPerInstance);
        for (let tabIndex = 0; tabIndex < chatsPerInstance; tabIndex++) {
          await tabs.nth(tabIndex).click();
          await page.evaluate(() => window.__isoladeProductionChatHarness?.waitFrames(1));
        }
      }
    }

    expect(requests).toHaveLength(warmRequestCount);
    const retainedWork = await page.evaluate(() =>
      window.__isoladeProductionChatHarness?.metrics(),
    );
    expect(retainedWork?.markdownRenders).toBe(0);
    expect(retainedWork?.parserInputBytes).toBe(0);
    expect(retainedWork?.historyMappings).toBe(0);
    expect(retainedWork?.historicalRowRenders).toBe(0);
    await page.evaluate(() => window.__isoladeProductionChatHarness?.unmountRetained());
    await expect(page.locator("[data-retained-instance]")).toHaveCount(0);
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
    await expect(page.getByRole("button", { name: "Edit message" }).first()).toBeDisabled();
    expect(
      (await page.evaluate(() => window.__isoladeProductionChatHarness?.metrics()))
        ?.historyMappings,
    ).toBe(0);

    releaseTurn();
    await expect(page.getByText("Lifecycle complete")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit message" }).first()).toBeEnabled();
    const work = await page.evaluate(() => window.__isoladeProductionChatHarness?.metrics());
    expect(work?.historyMappings).toBe(0);
    expect(work?.historicalRowRenders).toBe(0);
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
