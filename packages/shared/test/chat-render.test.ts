import { describe, expect, it } from "bun:test";
import { applyChatRenderEvent, type ChatRenderChunk } from "../src/chat-render";

describe("applyChatRenderEvent", () => {
  it("moves an optimistic interruption and user message together to the acknowledged position", () => {
    const chunks: ChatRenderChunk[] = [
      { kind: "text", text: "Before." },
      { kind: "interruption", id: "now-1" },
      {
        kind: "user_message",
        id: "now-1",
        content: "Change direction.",
        deliveryStatus: "sending",
      },
      { kind: "text", text: "Raced with acknowledgement." },
    ];
    const toolIndex = new Map<string, number>();

    applyChatRenderEvent(chunks, toolIndex, "turn_interrupted", { id: "now-1" });
    applyChatRenderEvent(chunks, toolIndex, "steered_user_message", {
      id: "now-1",
      content: "Change direction.",
      deliveryStatus: "confirmed",
    });

    expect(chunks).toEqual([
      { kind: "text", text: "Before." },
      { kind: "text", text: "Raced with acknowledgement." },
      { kind: "interruption", id: "now-1" },
      {
        kind: "user_message",
        id: "now-1",
        content: "Change direction.",
        deliveryStatus: "confirmed",
      },
    ]);
  });
});
