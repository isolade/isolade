import type { StreamChunk } from "@/components/chat/chunks";
import type { TranscriptMessage } from "@/lib/contracts";

export interface HarnessPage {
  key: string;
  messages: TranscriptMessage[];
  chunksByMessage: Record<string, StreamChunk[]>;
}

function assistantContent(index: number): string {
  if (index % 50 === 1) {
    return `### Result ${index}\n\n\`\`\`ts\nconst value${index} = ${index};\nconsole.log(value${index});\n\`\`\``;
  }
  if (index % 40 === 1) {
    return `### Table ${index}\n\n| Item | Value |\n| --- | ---: |\n| alpha | ${index} |\n| beta | ${index + 1} |`;
  }
  if (index % 30 === 1) {
    return `### Notes ${index}\n\n- First retained fact\n- Second **important** fact\n\nA final paragraph with [a link](https://example.com/${index}).`;
  }
  return `Response **${index}** keeps realistic Markdown in the retained history.`;
}

function messageFor(chatId: string, index: number): TranscriptMessage {
  const role = index % 2 === 0 ? "user" : "assistant";
  return {
    id: `${chatId}-m${index}`,
    chatId,
    role,
    content: role === "user" ? `Question ${index}` : assistantContent(index),
    parentId: index === 0 ? null : `${chatId}-m${index - 1}`,
    createdAt: new Date(index * 1000),
    version: null,
  };
}

function chunksFor(message: TranscriptMessage, index: number): StreamChunk[] | undefined {
  if (message.role !== "assistant" || index % 75 !== 1) return undefined;
  return [
    { kind: "text", text: `I inspected the retained tool result for item ${index}.` },
    {
      kind: "tool",
      id: `tool-${message.id}`,
      name: "read_file",
      input: { path: `/workspace/file-${index}.ts` },
      output: `line ${index}\nline ${index + 1}`,
      status: "done",
    },
  ];
}

export function makePages(chatId: string, count: number, pageSize = 100): HarnessPage[] {
  const messages = Array.from({ length: count }, (_, index) => messageFor(chatId, index));
  const pages: HarnessPage[] = [];
  for (let start = 0; start < messages.length; start += pageSize) {
    const pageMessages = messages.slice(start, start + pageSize);
    const chunksByMessage: Record<string, StreamChunk[]> = {};
    for (const [offset, message] of pageMessages.entries()) {
      const chunks = chunksFor(message, start + offset);
      if (chunks) chunksByMessage[message.id] = chunks;
    }
    pages.push({
      key: `${chatId}-page-${start / pageSize}`,
      messages: pageMessages,
      chunksByMessage,
    });
  }
  return pages;
}

export function makeOlderPage(chatId: string, ordinal: number, count: number): HarnessPage {
  const messages: TranscriptMessage[] = [];
  for (let offset = 0; offset < count; offset++) {
    const suffix = ordinal * count + offset;
    messages.push({
      id: `${chatId}-older-${suffix}`,
      chatId,
      role: suffix % 2 === 0 ? "user" : "assistant",
      content:
        suffix % 2 === 0
          ? `Older question ${suffix}`
          : `Older response **${suffix}** with enough text to wrap after a narrow resize.`,
      parentId: null,
      createdAt: new Date(-1_000_000 - suffix * 1000),
      version: null,
    });
  }
  return { key: `${chatId}-older-page-${ordinal}`, messages, chunksByMessage: {} };
}
