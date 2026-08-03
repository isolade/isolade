import { describe, expect, it } from "bun:test";
import { unfollowedTurnId } from "../src/components/chat/turn-attachment";

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
        streaming: false,
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
        streaming: true,
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
        streaming: false,
        holdsMessage: held("assistant-2"),
      }),
    ).toBeNull();
  });

  it("names nothing on a chat between turns, or one whose row predates the field", () => {
    for (const inFlightMessageId of [null, undefined]) {
      expect(
        unfollowedTurnId({ inFlightMessageId, streaming: false, holdsMessage: held() }),
      ).toBeNull();
    }
  });
});
