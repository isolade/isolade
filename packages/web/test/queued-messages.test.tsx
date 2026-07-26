import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QueuedMessages,
  reconcileQueuedMessageSnapshot,
} from "../src/components/chat/QueuedMessages";
import type { QueuedMessage } from "../src/lib/contracts";

function queued(status: QueuedMessage["status"] = "queued"): QueuedMessage {
  return {
    id: "queued-1",
    chatId: "chat-1",
    content: "Follow up",
    mode: "later",
    status,
    targetMessageId: null,
    error: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("QueuedMessages", () => {
  it("keeps an optimistic row when a stale transcript snapshot is empty", () => {
    const optimistic = queued();
    expect(reconcileQueuedMessageSnapshot([optimistic], [], new Set([optimistic.id]))).toEqual([
      optimistic,
    ]);
    expect(reconcileQueuedMessageSnapshot([optimistic], [], new Set())).toEqual([]);
  });

  it("replaces an optimistic row with the server copy without duplicating it", () => {
    const optimistic = queued();
    const persisted = { ...optimistic, content: "Persisted follow up" };
    expect(
      reconcileQueuedMessageSnapshot([optimistic], [persisted], new Set([optimistic.id])),
    ).toEqual([persisted]);
  });

  it("shows the queued prompt and all three queue controls", () => {
    const html = renderToStaticMarkup(
      <QueuedMessages
        messages={[queued()]}
        canRetractSteering={false}
        onRemove={() => {}}
        onDispatch={() => {}}
      />,
    );
    expect(html).toContain("Follow up");
    expect(html).toContain('aria-label="Send after current tool"');
    expect(html).toContain('aria-label="Send now"');
    expect(html).toContain('aria-label="Remove from queue"');
  });

  it("disables queue controls while delivery is in progress", () => {
    const html = renderToStaticMarkup(
      <QueuedMessages
        messages={[queued("interrupting")]}
        canRetractSteering={false}
        onRemove={() => {}}
        onDispatch={() => {}}
      />,
    );
    expect(html.match(/disabled=""/g)?.length).toBe(3);
    expect(html).toContain("Interrupting current turn");
  });

  it("allows Claude steering to be removed but keeps Codex steering committed", () => {
    const message = { ...queued("steering"), mode: "next" as const };
    const claude = renderToStaticMarkup(
      <QueuedMessages
        messages={[message]}
        canRetractSteering
        onRemove={() => {}}
        onDispatch={() => {}}
      />,
    );
    const codex = renderToStaticMarkup(
      <QueuedMessages
        messages={[message]}
        canRetractSteering={false}
        onRemove={() => {}}
        onDispatch={() => {}}
      />,
    );

    expect(claude).toContain("Waiting for next tool boundary");
    expect(claude).not.toContain("Sending");
    expect(claude).toContain('aria-label="Remove from queue"');
    expect(claude).not.toContain('title="Remove from queue" disabled');
    expect(codex).toContain('title="This message is already committed"');
  });

  it("renders uncertain queue delivery as a red warning", () => {
    const html = renderToStaticMarkup(
      <QueuedMessages
        messages={[queued("unknown")]}
        canRetractSteering
        onRemove={() => {}}
        onDispatch={() => {}}
      />,
    );
    expect(html).toContain("text-destructive");
    expect(html).toContain("Message may not have been sent");
  });

  it("shows a retraction race notice after the queue row disappears", () => {
    const html = renderToStaticMarkup(
      <QueuedMessages
        messages={[]}
        notice="That message had already reached Claude."
        canRetractSteering
        onRemove={() => {}}
        onDispatch={() => {}}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("That message had already reached Claude.");
  });
});
