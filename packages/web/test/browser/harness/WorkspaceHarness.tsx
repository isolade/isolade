import { Profiler, type ProfilerOnRenderCallback, useMemo, useState } from "react";
import HomeTab from "@/components/home/HomeTab";
import { getRenderMetrics, type MetricSnapshot } from "./metrics";
import { installWorkspaceApiMock, type WorkspaceApiMock } from "./workspace-api-mock";

// The whole workspace (sidebar + every retained instance + the new-chat pane)
// driven by mocked API responses, so a Playwright test can measure what a user
// actually feels: how long an unrelated interaction takes while a large working
// set is retained off screen.

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export interface CommitProfile {
  commits: number;
  totalDuration: number;
  /** PanelWorkspace renders since the last reset. */
  workspaceRenders: number;
}

export interface WorkspaceHarnessApi {
  waitFrames: (count?: number) => Promise<void>;
  resetProfile: () => Promise<void>;
  profile: () => CommitProfile;
  /**
   * Parser and renderer counters since the last reset. Retention exists so that
   * revisiting a chat costs nothing, and the only way to state that is that no
   * Markdown was re-parsed and no historical row was re-rendered.
   */
  renderMetrics: () => MetricSnapshot;
  /** Dirty one instance row, then let one poll cycle deliver it. */
  pollWithChange: () => Promise<CommitProfile>;
  /** Press an element and report the wall clock until the frame after it lands. */
  pressAndTime: (selector: string, index?: number) => Promise<number>;
  /**
   * Force off-screen panes back into the rendering path, reproducing the
   * behaviour before they were skipped. Lets a test compare the two on one
   * page, which is the actual invariant, rather than assert a millisecond
   * budget that depends on the machine. React owns this inline style, so any
   * pane re-render restores the real value: re-apply before each measurement.
   */
  setPaneSkipping: (on: boolean) => Promise<void>;
  /** Scroll the visible transcript up by `distance` px. */
  scrollActiveTranscript: (distance: number) => Promise<void>;
  /**
   * The topmost message in the visible transcript and how far below the
   * viewport's top edge it sits. Retention is about keeping the reader looking
   * at the same words, which is this pair, not a raw scroll offset: the
   * transcript's total height keeps settling as deferred work (syntax
   * highlighting, font metrics) lands.
   */
  activeReadingAnchor: () => { id: string | null; top: number };
  activeTranscriptDistanceFromBottom: () => number;
}

let profileState = { commits: 0, totalDuration: 0 };

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  profileState.commits++;
  profileState.totalDuration += actualDuration;
};

function press(element: HTMLElement): void {
  const options = { bubbles: true, cancelable: true, composed: true } as const;
  element.dispatchEvent(new PointerEvent("pointerdown", { ...options, button: 0, buttons: 1 }));
  element.dispatchEvent(new PointerEvent("pointerup", { ...options, button: 0, buttons: 0 }));
  element.dispatchEvent(new MouseEvent("click", { ...options, button: 0 }));
}

function activeScroller(): HTMLElement {
  const pane = document.querySelector<HTMLElement>('[data-retained-instance][aria-hidden="false"]');
  const scroller = pane?.querySelector<HTMLElement>("[data-chat-scroll]");
  if (!scroller) throw new Error("No visible transcript");
  return scroller;
}

export function WorkspaceHarness() {
  const parameters = useMemo(() => new URLSearchParams(window.location.search), []);
  const [mock] = useState<WorkspaceApiMock>(() =>
    installWorkspaceApiMock({
      instances: Number(parameters.get("instances") ?? 8),
      chatsPerInstance: Number(parameters.get("chatsPerInstance") ?? 2),
      messagesPerChat: Number(parameters.get("messages") ?? 120),
      split: parameters.get("split") === "1",
      prsPerInstance: Number(parameters.get("prs") ?? 0),
      profileId: "profile-test",
    }),
  );

  useState(() => {
    const snapshot = (): CommitProfile => ({
      ...profileState,
      workspaceRenders: getRenderMetrics().snapshot().retainedWorkspaceRenders,
    });
    const api: WorkspaceHarnessApi = {
      async waitFrames(count = 2) {
        for (let index = 0; index < count; index++) await frame();
      },
      async resetProfile() {
        await frame();
        await frame();
        profileState = { commits: 0, totalDuration: 0 };
        getRenderMetrics().reset();
      },
      profile: snapshot,
      renderMetrics: () => getRenderMetrics().snapshot(),
      async pollWithChange() {
        await api.resetProfile();
        mock.touchInstance(0);
        // The instance poll runs on a 1s interval; give it one full cycle plus
        // the render it schedules.
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        await frame();
        return snapshot();
      },
      async setPaneSkipping(on) {
        const panes = document.querySelectorAll<HTMLElement>(
          '[data-retained-instance][aria-hidden="true"]',
        );
        for (const pane of panes) pane.style.contentVisibility = on ? "hidden" : "visible";
        document.body.getBoundingClientRect();
        for (let index = 0; index < 3; index++) await frame();
      },
      async pressAndTime(selector, index = 0) {
        const target = document.querySelectorAll<HTMLElement>(selector)[index];
        if (!target) throw new Error(`Missing ${selector} #${index}`);
        await frame();
        const start = performance.now();
        press(target);
        await frame();
        await frame();
        return performance.now() - start;
      },
      async scrollActiveTranscript(distance) {
        const scroller = activeScroller();
        scroller.scrollTop = Math.max(0, scroller.scrollTop - distance);
        scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
        await frame();
        await frame();
      },
      activeReadingAnchor() {
        const scroller = activeScroller();
        const viewport = scroller.getBoundingClientRect();
        const rows = scroller.querySelectorAll<HTMLElement>("[data-message-row]");
        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          if (rect.bottom > viewport.top + 2) {
            return { id: row.getAttribute("data-message-id"), top: rect.top - viewport.top };
          }
        }
        return { id: null, top: 0 };
      },
      activeTranscriptDistanceFromBottom() {
        const scroller = activeScroller();
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      },
    };
    window.__isoladeWorkspaceHarness = api;
    document.documentElement.dataset.workspaceHarnessReady = "true";
  });

  return (
    <Profiler id="workspace" onRender={onRender}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <HomeTab isTauri={false} />
      </div>
    </Profiler>
  );
}

declare global {
  interface Window {
    __isoladeWorkspaceHarness?: WorkspaceHarnessApi;
  }
}
