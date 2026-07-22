import { describe, expect, it } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageHistory } from "../src/components/chat/MessageHistory";
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

describe("MessageHistory", () => {
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
