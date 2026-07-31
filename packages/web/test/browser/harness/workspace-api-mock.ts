import { CHAT_MODELS, type PrRefBody } from "@isolade/shared";
import type { AttachedPr, Chat, Instance, Layout } from "@/lib/contracts";

// An in-page stand-in for the API server, installed over `window.fetch` before
// the workspace mounts. Playwright's own request interception routes every call
// through the driver, which adds milliseconds of jitter to a poll that fires
// once a second per instance. These handlers answer synchronously off
// pre-built fixtures, so a measured commit reflects render cost and nothing
// else.

export interface WorkspaceFixtureOptions {
  instances: number;
  /** Chats per instance. With `split`, the first two each get their own panel. */
  chatsPerInstance: number;
  messagesPerChat: number;
  /** Give each instance a two-panel layout, so two chat bodies mount per instance. */
  split: boolean;
  /** Attached pull requests per instance, for the tab strip's PR badge. */
  prsPerInstance: number;
  profileId: string;
}

// Attached PRs for one instance, cycling through the states the badge draws so a
// single fixture covers open, draft, merged and closed.
const PR_STATES: { state: AttachedPr["state"]; isDraft: boolean }[] = [
  { state: "open", isDraft: false },
  { state: "merged", isDraft: false },
  { state: "open", isDraft: true },
  { state: "closed", isDraft: false },
];

function prsFor(instanceIndex: number, count: number): AttachedPr[] {
  return Array.from({ length: count }, (_, index) => {
    const { state, isDraft } = PR_STATES[index % PR_STATES.length] as (typeof PR_STATES)[number];
    const number = 100 + instanceIndex * 10 + index;
    return {
      host: "github.com",
      owner: "acme",
      repo: "isolade",
      number,
      title: `Keep the retained workspace out of the rendering path (${number})`,
      state,
      isDraft,
      url: `https://github.com/acme/isolade/pull/${number}`,
    };
  });
}

// A turn's worth of assistant output, cycling through the shapes that actually
// cost something to render: prose, lists, tables, fenced code (which the
// highlighter walks), and inline code.
const PROSE = [
  "The change lands in the reconciler, where the previous behaviour assumed a stable identity across polls.",
  "That assumption held while the list was rebuilt from scratch, and stopped holding once groups were memoized.",
  "Reproducing it needs a working set large enough that the layout pass shows up over the frame budget.",
  "The fix keeps the retained subtree in the document but takes it out of the rendering path entirely.",
];

function assistantContent(index: number): string {
  const lead = `${PROSE[index % PROSE.length]} Referenced as \`case-${index}\` in the notes below.`;
  switch (index % 6) {
    case 1:
      return `### Result ${index}\n\n${lead}\n\n\`\`\`ts\nexport function resolve${index}(input: Input): Output {\n  const parsed = schema.parse(input);\n  if (!parsed.ok) throw new Error(\`bad input at ${index}\`);\n  return { ...parsed.value, index: ${index} };\n}\n\`\`\`\n\n${PROSE[(index + 1) % PROSE.length]}`;
    case 2:
      return `### Table ${index}\n\n${lead}\n\n| Case | Before | After |\n| --- | ---: | ---: |\n| alpha | ${index} | ${index * 2} |\n| beta | ${index + 1} | ${index * 3} |\n| gamma | ${index + 2} | ${index * 4} |`;
    case 3:
      return `### Notes ${index}\n\n- First retained fact about \`case-${index}\`\n- Second **important** fact worth keeping in view\n- Third point, with [a link](https://example.com/${index})\n\n${lead}`;
    case 4:
      return `${lead}\n\n\`\`\`diff\n- const previous = compute(${index});\n+ const next = compute(${index}, { memoized: true });\n\`\`\`\n\n${PROSE[(index + 2) % PROSE.length]}`;
    default:
      return `${lead}\n\n${PROSE[(index + 3) % PROSE.length]}`;
  }
}

function userContent(index: number): string {
  return index % 5 === 0
    ? `Question ${index}: can you walk through what happens in \`resolve${index}\` when the input is already parsed, and whether the memoized path still applies?`
    : `Question ${index}`;
}

// Structural chunks for an assistant turn: a reasoning block and one or two
// tool cards on most turns, which is what a real agent transcript looks like.
function chunksFor(messageId: string, index: number): unknown[] {
  const chunks: unknown[] = [
    {
      kind: "thought",
      id: `${messageId}-thought`,
      provider: "claude",
      text: `Checking how case-${index} reaches the reconciler. The list is rebuilt per poll, so identity only survives when the group is untouched. Worth confirming against the persisted layout before changing anything.`,
      tokens: 96 + (index % 40),
      status: "done",
    },
    { kind: "text", text: `Looking at case-${index}.` },
    {
      kind: "tool",
      id: `${messageId}-tool-read`,
      name: "read_file",
      summary: `read_file src/module-${index}.ts`,
      input: { path: `/workspace/src/module-${index}.ts`, offset: index, limit: 80 },
      output: Array.from(
        { length: 12 },
        (_, line) => `${index + line} | const value${line} = compute(${index}, ${line});`,
      ).join("\n"),
      detailsAvailable: true,
      status: "done",
    },
  ];
  if (index % 3 === 0) {
    chunks.push({
      kind: "tool",
      id: `${messageId}-tool-bash`,
      name: "bash",
      summary: `bun test module-${index}`,
      input: { command: `bun test src/module-${index}.test.ts` },
      output: `bun test v1.3.14\n\n src/module-${index}.test.ts:\n ✓ resolves case ${index}\n ✓ keeps identity across polls\n\n 2 pass\n 0 fail`,
      detailsAvailable: true,
      status: "done",
    });
  }
  if (index % 11 === 0) {
    chunks.push({
      kind: "api_retry",
      attempt: 1,
      maxRetries: 3,
      retryDelayMs: 500,
      errorStatus: 529,
      error: "overloaded",
    });
  }
  chunks.push({ kind: "text", text: assistantContent(index) });
  return chunks;
}

function transcriptFor(chatId: string, messagesPerChat: number) {
  const messages: unknown[] = [];
  const chunksByMessage: Record<string, unknown[]> = {};
  for (let index = 0; index < messagesPerChat; index++) {
    const id = `${chatId}-m${index}`;
    const role = index % 2 === 0 ? "user" : "assistant";
    messages.push({
      id,
      chatId,
      role,
      content: role === "user" ? userContent(index) : assistantContent(index),
      parentId: index === 0 ? null : `${chatId}-m${index - 1}`,
      createdAt: new Date(index * 1_000).toISOString(),
      version: null,
    });
    if (role === "assistant") chunksByMessage[id] = chunksFor(id, index);
  }
  return { messages, hasMore: false, chunksByMessage, inFlight: null, queuedMessages: [] };
}

function panel(id: string, chatIds: string[]) {
  const tabs = chatIds.map((chatId) => ({ id: `tab-${chatId}`, kind: "chat", resourceId: chatId }));
  return { type: "panel", id, tabs, activeTabId: tabs[0]?.id ?? null };
}

// Two panels side by side, so each instance keeps two chat bodies mounted
// rather than one. Panel bodies mount lazily on first activation, so a
// single-panel instance only ever materializes one transcript.
function splitLayout(instanceId: string, chatIds: string[]): Layout {
  const half = Math.max(1, Math.ceil(chatIds.length / 2));
  return {
    type: "split",
    id: `split-${instanceId}`,
    direction: "row",
    children: [
      panel(`${instanceId}-p0`, chatIds.slice(0, half)),
      panel(`${instanceId}-p1`, chatIds.slice(half)),
    ],
    sizes: [0.5, 0.5],
  } as Layout;
}

export interface WorkspaceApiMock {
  instances: Instance[];
  chats: Chat[];
  /** Mutate one instance row so the next poll delivers a genuinely changed list. */
  touchInstance: (index: number) => void;
  requestCount: () => number;
  restore: () => void;
}

export function installWorkspaceApiMock(options: WorkspaceFixtureOptions): WorkspaceApiMock {
  const {
    instances: instanceCount,
    chatsPerInstance,
    messagesPerChat,
    split,
    prsPerInstance,
    profileId,
  } = options;
  const now = new Date();
  const instances: Instance[] = Array.from({ length: instanceCount }, (_, index) => ({
    id: `instance-${index}`,
    vmId: `vm-${index}`,
    title: `Instance ${index}`,
    status: "running",
    lastError: null,
    image: "test",
    profileId,
    diffAdded: index,
    diffDeleted: 0,
    prs: prsFor(index, prsPerInstance),
    working: false,
    unread: false,
    archived: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  }));
  const chats: Chat[] = instances.flatMap((instance, instanceIndex) =>
    Array.from({ length: chatsPerInstance }, (_, chatIndex) => ({
      id: `chat-${instanceIndex}-${chatIndex}`,
      instanceId: instance.id,
      model: "claude-sonnet-5",
      provider: "anthropic" as const,
      effort: "high" as const,
      fastMode: false,
      claudeSessionId: null,
      codexThreadId: null,
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      costUsd: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastCacheCreationInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      modelContextWindow: null,
      compacted: null,
      activeLeafId: null,
      createdAt: now,
    })),
  );

  const transcripts = new Map<string, unknown>(
    chats.map((chat) => [chat.id, transcriptFor(chat.id, messagesPerChat)]),
  );
  const layouts = new Map<string, unknown>(
    instances.map((instance) => [
      instance.id,
      split
        ? splitLayout(
            instance.id,
            chats.filter((chat) => chat.instanceId === instance.id).map((chat) => chat.id),
          )
        : null,
    ]),
  );
  const serialized = {
    instances: () => JSON.parse(JSON.stringify(instances)) as unknown,
    chats: JSON.parse(JSON.stringify(chats)) as unknown,
    profiles: [
      {
        id: profileId,
        name: "Test",
        image: "test",
        status: "ready",
        errorMessage: null,
        hasConfig: true,
        configPath: "/tmp/config.toml",
      },
    ],
    models: { models: CHAT_MODELS },
    update: {
      current: "0.0.0",
      available: false,
      latest: null,
      download: null,
      notes: null,
      changes: [],
    },
  };

  let requests = 0;
  const originalFetch = window.fetch.bind(window);
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0]!;
    if (!path.startsWith("/api/")) return originalFetch(input as RequestInfo, init);
    requests++;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/profiles") return json(serialized.profiles);
    if (path === "/api/instances" && method === "GET") return json(serialized.instances());
    if (path === "/api/chats") return json(serialized.chats);
    if (path === "/api/chat/models") return json(serialized.models);
    if (path === "/api/update") return json(serialized.update);
    if (/^\/api\/profiles\/[^/]+\/models$/.test(path)) return json({});
    if (/^\/api\/profiles\/[^/]+\/(activate|deactivate)$/.test(path)) return json({ ok: true });
    const layout = path.match(/^\/api\/instances\/([^/]+)\/layout$/);
    if (layout) return json({ layout: layouts.get(layout[1]!) ?? null });
    if (/^\/api\/instances\/[^/]+\/terminals$/.test(path)) return json([]);
    // Detaching a PR has to stick, or the once-a-second instance poll would put
    // the badge straight back.
    const prs = path.match(/^\/api\/instances\/([^/]+)\/prs$/);
    if (prs && method === "DELETE") {
      const instance = instances.find((row) => row.id === prs[1]);
      const ref = JSON.parse(String(init?.body ?? "{}")) as Partial<PrRefBody>;
      if (instance) {
        instance.prs = (instance.prs ?? []).filter(
          (pr) =>
            !(
              pr.host === ref.host &&
              pr.owner === ref.owner &&
              pr.repo === ref.repo &&
              pr.number === ref.number
            ),
        );
      }
      return json({ ok: true });
    }
    if (/^\/api\/instances\/[^/]+\/read$/.test(path)) return json({ ok: true });
    const transcript = path.match(/^\/api\/instances\/[^/]+\/chats\/([^/]+)\/transcript$/);
    if (transcript) return json(transcripts.get(transcript[1]!) ?? transcriptFor("unknown", 0));
    return json({ ok: true });
  }) as typeof window.fetch;

  return {
    instances,
    chats,
    touchInstance(index) {
      const instance = instances[index % instances.length];
      if (!instance) return;
      instance.diffAdded = (instance.diffAdded ?? 0) + 1;
      instance.updatedAt = new Date(Date.now());
    },
    requestCount: () => requests,
    restore() {
      window.fetch = originalFetch;
    },
  };
}
