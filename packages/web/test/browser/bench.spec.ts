import { expect, test } from "@playwright/test";

// Throwaway benchmark harness, kept out of the CI suite (tagged @bench, which
// neither `test:browser` nor `test:browser:stress` selects). It exists to size
// the problem and A/B the fix against a realistic working set.
const INSTANCES = Number(process.env.B_INSTANCES ?? 16);
const CHATS = Number(process.env.B_CHATS ?? 2);
const MESSAGES = Number(process.env.B_MESSAGES ?? 400);
const SPLIT = process.env.B_SPLIT === "0" ? "0" : "1";
const BODIES_PER_INSTANCE = SPLIT === "1" ? Math.min(CHATS, 2) : 1;

function stat(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted.at(-1),
  };
}

test("bench @bench", async ({ page }) => {
  test.setTimeout(900_000);

  // Engine-phase attribution. Wall-clock says how bad it is; these say which
  // phase is paying, which is the part that is not guessable from the outside.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const phaseKeys = [
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "LayoutCount",
    "RecalcStyleCount",
  ] as const;
  const readPhases = async (): Promise<Record<string, number>> => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  };
  // Chromium reports the durations as cumulative seconds, so diff across the
  // action and convert. Whatever TaskDuration has left over after script,
  // layout and style is paint, compositing and the rest of the frame.
  const phasesAround = async (action: () => Promise<unknown>) => {
    const before = await readPhases();
    await action();
    const after = await readPhases();
    const diff: Record<string, number> = {};
    for (const key of phaseKeys) {
      const delta = (after[key] ?? 0) - (before[key] ?? 0);
      diff[key] = key.endsWith("Count") ? Math.round(delta) : +(delta * 1000).toFixed(1);
    }
    diff.otherMs = +(
      diff.TaskDuration -
      diff.ScriptDuration -
      diff.LayoutDuration -
      diff.RecalcStyleDuration
    ).toFixed(1);
    return diff;
  };

  await page.goto(
    `/test/browser/harness/index.html?workspace=1&instances=${INSTANCES}` +
      `&chatsPerInstance=${CHATS}&messages=${MESSAGES}&split=${SPLIT}`,
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.workspaceHarnessReady === "true",
  );
  const hydrationStart = Date.now();
  await expect(page.locator("[data-message-id]")).toHaveCount(
    INSTANCES * BODIES_PER_INSTANCE * MESSAGES,
    { timeout: 600_000 },
  );
  const hydrationMs = Date.now() - hydrationStart;
  await page.waitForTimeout(3_000);

  const out = await page.evaluate(async () => {
    const frame = () =>
      new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now())));
    const options = { bubbles: true, cancelable: true, composed: true } as const;
    const press = (element: HTMLElement) => {
      element.dispatchEvent(new PointerEvent("pointerdown", { ...options, button: 0, buttons: 1 }));
      element.dispatchEvent(new PointerEvent("pointerup", { ...options, button: 0, buttons: 0 }));
      element.dispatchEvent(new MouseEvent("click", { ...options, button: 0 }));
    };

    // The old behaviour, reproduced from the page: off-screen panes laid out
    // and painted like any other content. Toggling this property is exactly
    // what the fix flips, so it is a faithful A/B without rebuilding the set.
    const setSkipping = async (on: boolean) => {
      const panes = document.querySelectorAll<HTMLElement>(
        '[data-retained-instance][aria-hidden="true"]',
      );
      for (const pane of panes) pane.style.contentVisibility = on ? "hidden" : "visible";
      document.body.getBoundingClientRect();
      for (let index = 0; index < 3; index++) await frame();
    };

    const openPicker = async () => {
      const trigger = document.querySelector<HTMLElement>('[data-demo="model-picker"]')!;
      await frame();
      const start = performance.now();
      press(trigger);
      await frame();
      const end = await frame();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await frame();
      const closed = await frame();
      return { open: +(end - start).toFixed(1), close: +(closed - end).toFixed(1) };
    };

    const switchInstance = async (index: number) => {
      const row = document.querySelectorAll<HTMLElement>('[data-demo="instance-row"]')[index]!;
      await frame();
      const start = performance.now();
      press(row);
      await frame();
      const end = await frame();
      return +(end - start).toFixed(1);
    };

    const typeOnce = async () => {
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      const start = performance.now();
      setter.call(textarea, `${textarea.value}a`);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
      return +((await frame()) - start).toFixed(1);
    };

    const idleTwoFrames = async () => {
      const start = performance.now();
      await frame();
      return +((await frame()) - start).toFixed(1);
    };

    // React owns the inline `content-visibility`, so any pane re-render (which a
    // switch causes) puts the real value back. Re-apply the A/B state before
    // each phase rather than once per run.
    const measure = async (label: string, skipping: boolean) => {
      const picker: { open: number; close: number }[] = [];
      await setSkipping(skipping);
      for (let index = 0; index < 5; index++) picker.push(await openPicker());

      const switching: number[] = [];
      for (let index = 0; index < 4; index++) {
        await setSkipping(skipping);
        switching.push(await switchInstance(index % 2));
      }

      // Return to the new-chat pane before typing into its composer.
      press(document.querySelector<HTMLElement>('[data-demo="new-chat"]')!);
      for (let index = 0; index < 4; index++) await frame();
      await setSkipping(skipping);
      const typing: number[] = [];
      for (let index = 0; index < 6; index++) typing.push(await typeOnce());

      const idle: number[] = [];
      for (let index = 0; index < 6; index++) idle.push(await idleTwoFrames());
      return {
        label,
        open: picker.map((p) => p.open),
        close: picker.map((p) => p.close),
        switching,
        typing,
        idle,
      };
    };

    const before = await measure("off-screen panes laid out (old)", false);
    const after = await measure("off-screen panes skipped (current)", true);

    // React-side: how much of the tree a single instance poll re-renders.
    const poll = await window.__isoladeWorkspaceHarness!.pollWithChange();

    return {
      nodes: document.querySelectorAll("*").length,
      messages: document.querySelectorAll("[data-message-id]").length,
      toolCards: document.querySelectorAll("[data-tool-id]").length,
      thinkingBlocks: document.querySelectorAll("[data-thinking-provider]").length,
      codeBlocks: document.querySelectorAll("pre").length,
      panes: document.querySelectorAll("[data-retained-instance]").length,
      bodies: document.querySelectorAll("[data-body-layer]").length,
      before,
      after,
      poll,
      heapMb:
        // biome-ignore lint/suspicious/noExplicitAny: Chromium-only diagnostic.
        Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6),
    };
  });

  const cycle = async (skipping: boolean) => {
    await page.evaluate((on) => window.__isoladeWorkspaceHarness?.setPaneSkipping(on), skipping);
    return phasesAround(async () => {
      await page.evaluate(() =>
        window.__isoladeWorkspaceHarness?.pressAndTime('[data-demo="model-picker"]'),
      );
      await page.keyboard.press("Escape");
      await page.evaluate(() => window.__isoladeWorkspaceHarness?.waitFrames(3));
    });
  };
  const phasesLaidOut = await cycle(false);
  const phasesSkipped = await cycle(true);

  const report = (m: typeof out.before) => ({
    openPicker: stat(m.open),
    closePicker: stat(m.close),
    switchInstance: stat(m.switching),
    typeCharacter: stat(m.typing),
    idleTwoFrames: stat(m.idle),
  });
  console.log(
    JSON.stringify(
      {
        scale: { instances: INSTANCES, chats: CHATS, messages: MESSAGES, split: SPLIT },
        hydrationMs,
        dom: {
          nodes: out.nodes,
          messages: out.messages,
          toolCards: out.toolCards,
          thinkingBlocks: out.thinkingBlocks,
          codeBlocks: out.codeBlocks,
          panes: out.panes,
          mountedBodies: out.bodies,
        },
        heapMb: out.heapMb,
        before: report(out.before),
        after: report(out.after),
        pollWithOneChangedInstance: out.poll,
        // One open+close of the model picker, by engine phase.
        pickerCyclePhases: { laidOut: phasesLaidOut, skipped: phasesSkipped },
      },
      null,
      2,
    ),
  );
});
