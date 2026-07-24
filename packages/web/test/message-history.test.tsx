import { describe, expect, it } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageHistory } from "../src/components/chat/MessageHistory";
import { UserMessage } from "../src/components/chat/UserMessage";
import type { TranscriptMessage } from "../src/lib/contracts";

function message(id: string, role: "user" | "assistant" = "user"): TranscriptMessage {
  return {
    id,
    chatId: "chat",
    role,
    content: `message ${id}`,
    parentId: null,
    createdAt: new Date(0),
    version: null,
  };
}

function renderUserDelivery(status: TranscriptMessage["deliveryStatus"]): string {
  const user = { ...message(`user-${status}`), deliveryStatus: status };
  return renderToStaticMarkup(
    <MessageHistory
      instanceId="instance-test"
      pages={[]}
      sessionRows={[{ renderKey: user.id, message: user }]}
      live={null}
      scrollElementRef={createRef<HTMLDivElement>()}
      showDebug={false}
      userFontFamily="sans-serif"
      agentFontFamily="sans-serif"
      editingId={null}
      actionsDisabled={false}
      visible
      hasOlder={false}
      onStartEdit={() => {}}
      onCancelEdit={() => {}}
      onSubmitEdit={() => {}}
      onNavigateVersion={() => {}}
      onRequestToolDetails={() => {}}
      onLoadOlder={() => {}}
      onLayoutChange={() => {}}
    />,
  );
}

describe("MessageHistory", () => {
  it("renders pending delivery optimistically and only warns when delivery is suspect", () => {
    const sending = renderUserDelivery("sending");
    expect(sending).not.toContain("Sending");
    expect(sending).not.toContain('role="status"');

    const unknown = renderUserDelivery("unknown");
    expect(unknown).toContain('role="status"');
    expect(unknown).toContain("text-destructive");
    expect(unknown).toContain("Message may not have been sent");

    const rejected = renderUserDelivery("rejected");
    expect(rejected).toContain("Message was not sent");
  });

  it("renders every row supplied by bounded page groups in normal document flow", () => {
    const older = Array.from({ length: 60 }, (_, index) => message(`older-${index}`));
    const tail = Array.from({ length: 60 }, (_, index) => message(`tail-${index}`));

    const html = renderToStaticMarkup(
      <MessageHistory
        instanceId="instance-test"
        pages={[
          { key: "older", messages: older, chunksByMessage: {} },
          { key: "tail", messages: tail, chunksByMessage: {} },
        ]}
        sessionRows={[{ renderKey: "session-user", message: message("session-user") }]}
        live={null}
        scrollElementRef={createRef<HTMLDivElement>()}
        showDebug={false}
        userFontFamily="sans-serif"
        agentFontFamily="sans-serif"
        editingId={null}
        actionsDisabled={false}
        visible
        hasOlder
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSubmitEdit={() => {}}
        onNavigateVersion={() => {}}
        onRequestToolDetails={() => {}}
        onLoadOlder={() => {}}
        onLayoutChange={() => {}}
      />,
    );

    expect(html.match(/data-message-row=/g)).toHaveLength(121);
    expect(html).toContain('data-message-id="older-0"');
    expect(html).toContain('data-message-id="tail-59"');
    expect(html).not.toContain("position:absolute");
    expect(html).not.toContain("translateY");
  });

  it("renders waiting state and streamed chunks inside the assistant row", () => {
    const liveMessage = message("live", "assistant");
    const waiting = renderToStaticMarkup(
      <MessageHistory
        instanceId="instance-test"
        pages={[]}
        sessionRows={[]}
        live={{ renderKey: "turn", message: liveMessage, chunks: [], streaming: true }}
        scrollElementRef={createRef<HTMLDivElement>()}
        showDebug={false}
        userFontFamily="sans-serif"
        agentFontFamily="sans-serif"
        editingId={null}
        actionsDisabled
        visible
        hasOlder={false}
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSubmitEdit={() => {}}
        onNavigateVersion={() => {}}
        onRequestToolDetails={() => {}}
        onLoadOlder={() => {}}
        onLayoutChange={() => {}}
      />,
    );

    expect(waiting).toContain('aria-label="Waiting for response"');
    expect(waiting).toContain('data-message-id="live"');
  });

  it("renders a steered user message inline with the active assistant turn", () => {
    const assistant = message("active", "assistant");
    const html = renderToStaticMarkup(
      <MessageHistory
        instanceId="instance-test"
        pages={[]}
        sessionRows={[
          {
            renderKey: assistant.id,
            message: assistant,
            chunks: [
              {
                kind: "tool",
                id: "tool-1",
                name: "Read",
                output: "done",
                status: "done",
              },
              {
                kind: "interruption",
                id: "steer-1",
              },
              {
                kind: "user_message",
                id: "steer-1",
                content: "Change direction",
              },
              { kind: "text", text: "Continuing with the new direction." },
            ],
          },
        ]}
        live={null}
        scrollElementRef={createRef<HTMLDivElement>()}
        showDebug={false}
        userFontFamily="user-font"
        agentFontFamily="agent-font"
        editingId={null}
        actionsDisabled={false}
        visible
        hasOlder={false}
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSubmitEdit={() => {}}
        onNavigateVersion={() => {}}
        onRequestToolDetails={() => {}}
        onLoadOlder={() => {}}
        onLayoutChange={() => {}}
      />,
    );

    expect(html).toContain('data-agent-interrupted="steer-1"');
    expect(html).toContain(
      'class="-mr-12 my-4 flex items-center gap-2 text-xs text-muted-foreground"',
    );
    expect(html).toContain("Agent interrupted");
    expect(html).toContain('data-steered-user-message="steer-1"');
    expect(html).toContain("Change direction");
    expect(html.indexOf("Agent interrupted")).toBeLessThan(html.indexOf("Change direction"));
    expect(html.indexOf("Change direction")).toBeLessThan(
      html.indexOf("Continuing with the new direction."),
    );
  });

  it("uses capabilities to expose editing without changing in-turn message presentation", () => {
    const render = (edit: boolean) =>
      renderToStaticMarkup(
        <UserMessage
          message={{ id: "inline", content: "same message" }}
          capabilities={edit ? { edit: true } : {}}
          instanceId="instance-test"
          fontFamily="user-font"
          inline
          onStartEdit={() => {}}
          onCancelEdit={() => {}}
          onSubmitEdit={() => {}}
        />,
      );

    const codex = render(false);
    const claude = render(true);
    expect(codex).toContain("same message");
    expect(claude).toContain("same message");
    expect(codex).not.toContain('aria-label="Edit message"');
    expect(claude).toContain('aria-label="Edit message"');
  });

  it("shows thinking progress and Claude's final summary without debug mode", () => {
    const assistant = message("thought", "assistant");
    const html = renderToStaticMarkup(
      <MessageHistory
        instanceId="instance-test"
        pages={[
          {
            key: "thoughts",
            messages: [assistant],
            chunksByMessage: {
              [assistant.id]: [
                {
                  kind: "thought",
                  id: "claude-thinking-0",
                  provider: "claude",
                  text: "I checked the relevant state before answering.",
                  tokens: 768,
                  status: "done",
                },
              ],
            },
          },
        ]}
        sessionRows={[]}
        live={null}
        scrollElementRef={createRef<HTMLDivElement>()}
        showDebug={false}
        userFontFamily="sans-serif"
        agentFontFamily="sans-serif"
        editingId={null}
        actionsDisabled={false}
        visible
        hasOlder={false}
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSubmitEdit={() => {}}
        onNavigateVersion={() => {}}
        onRequestToolDetails={() => {}}
        onLoadOlder={() => {}}
        onLayoutChange={() => {}}
      />,
    );

    expect(html).toContain('data-thinking-provider="claude"');
    expect(html).toContain('data-thinking-status="done"');
    expect(html).toContain("I checked the relevant state before answering.");
  });

  it("renders Codex summary emphasis as plain text", () => {
    const assistant = message("codex-thought", "assistant");
    const html = renderToStaticMarkup(
      <MessageHistory
        instanceId="instance-test"
        pages={[
          {
            key: "codex-thoughts",
            messages: [assistant],
            chunksByMessage: {
              [assistant.id]: [
                {
                  kind: "thought",
                  id: "reasoning-1",
                  provider: "codex",
                  text: "**Clarifying data persistence limitations**",
                  status: "done",
                },
              ],
            },
          },
        ]}
        sessionRows={[]}
        live={null}
        scrollElementRef={createRef<HTMLDivElement>()}
        showDebug={false}
        userFontFamily="sans-serif"
        agentFontFamily="sans-serif"
        editingId={null}
        actionsDisabled={false}
        visible
        hasOlder={false}
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSubmitEdit={() => {}}
        onNavigateVersion={() => {}}
        onRequestToolDetails={() => {}}
        onLoadOlder={() => {}}
        onLayoutChange={() => {}}
      />,
    );

    expect(html).toContain("Clarifying data persistence limitations");
    expect(html).not.toContain("<strong>Clarifying data persistence limitations</strong>");
  });

  it("removes edit and version controls from the tab order while actions are busy", () => {
    const versioned = {
      ...message("versioned"),
      version: {
        index: 2,
        count: 3,
        previousId: "previous",
        nextId: "next",
      },
    };
    const html = renderToStaticMarkup(
      <MessageHistory
        instanceId="instance-test"
        pages={[]}
        sessionRows={[{ renderKey: versioned.id, message: versioned }]}
        live={null}
        scrollElementRef={createRef<HTMLDivElement>()}
        showDebug={false}
        userFontFamily="sans-serif"
        agentFontFamily="sans-serif"
        editingId={null}
        actionsDisabled
        visible
        hasOlder={false}
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSubmitEdit={() => {}}
        onNavigateVersion={() => {}}
        onRequestToolDetails={() => {}}
        onLoadOlder={() => {}}
        onLayoutChange={() => {}}
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it("renders persisted attachments without requiring message text", () => {
    const attached: TranscriptMessage = {
      ...message("attached"),
      content: "",
      uploads: [
        {
          id: "upload-1",
          filename: "notes.txt",
          mediaType: "text/plain",
          size: 2048,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <MessageHistory
        instanceId="instance-test"
        pages={[]}
        sessionRows={[{ renderKey: attached.id, message: attached }]}
        live={null}
        scrollElementRef={createRef<HTMLDivElement>()}
        showDebug={false}
        userFontFamily="sans-serif"
        agentFontFamily="sans-serif"
        editingId={null}
        actionsDisabled={false}
        visible
        hasOlder={false}
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSubmitEdit={() => {}}
        onNavigateVersion={() => {}}
        onRequestToolDetails={() => {}}
        onLoadOlder={() => {}}
        onLayoutChange={() => {}}
      />,
    );

    expect(html).toContain("notes.txt");
    expect(html).toContain("2 KB");
    expect(html).toContain("upload-1");
  });
});
