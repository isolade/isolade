import { describe, expect, it } from "bun:test";
import { TurnLifecycle, unfollowedTurnId } from "../src/components/chat/turn-attachment";

const held = (...ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

describe("unfollowedTurnId", () => {
  it("names a turn the server is running that this view holds nothing of", () => {
    // The case that had a promoted turn streaming into nothing: the server
    // started it, the composer looks settled, and the transcript has no trace of
    // it yet.
    expect(
      unfollowedTurnId({
        inFlightMessageId: "assistant-2",
        active: false,
        holdsMessage: held("user-1", "assistant-1", "user-2"),
      }),
    ).toBe("assistant-2");
  });

  it("names nothing while this view is already reading a stream", () => {
    // Whether that stream is this turn or the one before it: a second reader
    // would fight the first over the same live row.
    expect(
      unfollowedTurnId({
        inFlightMessageId: "assistant-2",
        active: true,
        holdsMessage: held(),
      }),
    ).toBeNull();
  });

  it("names nothing for a turn this view has already committed", () => {
    // The chat row is polled every few seconds, so a turn that has just settled
    // still reads as running. The committed message is the proof that it has not.
    expect(
      unfollowedTurnId({
        inFlightMessageId: "assistant-2",
        active: false,
        holdsMessage: held("assistant-2"),
      }),
    ).toBeNull();
  });

  it("names nothing on a chat between turns, or one whose row predates the field", () => {
    for (const inFlightMessageId of [null, undefined]) {
      expect(
        unfollowedTurnId({ inFlightMessageId, active: false, holdsMessage: held() }),
      ).toBeNull();
    }
  });
});

describe("TurnLifecycle", () => {
  it("lets only one synchronous contender claim an idle chat", () => {
    const lifecycle = new TurnLifecycle();
    const hydration = lifecycle.claim();

    expect(hydration).not.toBeNull();
    expect(lifecycle.claim()).toBeNull();
    expect(lifecycle.active).toBe(true);
  });

  it("does not let stale cleanup release a replacement turn", () => {
    const lifecycle = new TurnLifecycle();
    const original = lifecycle.claim()!;
    const replacement = lifecycle.replace();

    expect(lifecycle.release(original)).toBe(false);
    expect(lifecycle.owns(replacement)).toBe(true);
    expect(lifecycle.release(replacement)).toBe(true);
    expect(lifecycle.active).toBe(false);
  });

  it("can hand the bootstrap turn's existing lease to its first reader", () => {
    const lifecycle = new TurnLifecycle(true);
    const bootstrap = lifecycle.current;

    expect(bootstrap).not.toBeNull();
    expect(lifecycle.claim()).toBeNull();
    expect(lifecycle.release(bootstrap!)).toBe(true);
  });
});
