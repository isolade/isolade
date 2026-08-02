import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentImage,
  AgentImageCollector,
  type AgentImageEvent,
  fetchGuestImage,
  type ImageDestination,
  ImageReferenceScanner,
  readGuestImage,
  resolveImageDestination,
  sniffImageMediaType,
  storeAgentImage,
} from "../src/agent-images";
import { createDb } from "../src/db";
import type { SandboxApi } from "../src/sandbox-client";
import { UploadStore, uploadHostPath } from "../src/uploads";

const XDG_VARS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
let root: string;
let prev: Map<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "isolade-agent-images-"));
  prev = new Map(XDG_VARS.map((v) => [v, process.env[v]] as const));
  process.env.XDG_STATE_HOME = join(root, "state");
});

afterEach(() => {
  for (const [v, value] of prev) {
    if (value === undefined) delete process.env[v];
    else process.env[v] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 7),
]);

/** A sandbox whose exec answers the read snippet from an in-memory filesystem,
 * so the scripting (existence probe, base64 pipe) is exercised rather than
 * stubbed over. */
function fakeSandbox(files: Record<string, Buffer>, opts: { calls?: string[] } = {}): SandboxApi {
  return {
    async exec(_vmId: string, command: string) {
      opts.calls?.push(command);
      const path = command.match(/\[ -f '([^']*)' \]/)?.[1];
      const bytes = path === undefined ? undefined : files[path];
      if (!bytes) return { stdout: "", stderr: "", exitCode: 2 };
      return { stdout: bytes.toString("base64"), stderr: "", exitCode: 0 };
    },
  } as unknown as SandboxApi;
}

/** Where a resolved destination points, whichever kind it turned out to be. */
function target(destination: ImageDestination | null): string | undefined {
  if (!destination) return undefined;
  return destination.kind === "file" ? destination.path : destination.url;
}

describe("image reference destinations", () => {
  test("absolute guest paths pass through, relative ones resolve against the workspace", () => {
    expect(target(resolveImageDestination("/workspace/out/chart.png"))).toBe(
      "/workspace/out/chart.png",
    );
    expect(target(resolveImageDestination("out/chart.png"))).toBe("/workspace/out/chart.png");
    expect(target(resolveImageDestination("./out/../shot.png"))).toBe("/workspace/shot.png");
  });

  test("the raw destination is kept alongside the resolved path", () => {
    // The renderer only ever sees what the agent wrote, so that is the key the
    // snapshot has to be stored under.
    expect(resolveImageDestination("out/chart.png")?.raw).toBe("out/chart.png");
    expect(resolveImageDestination("<my shot.png>")?.raw).toBe("my shot.png");
  });

  test("percent escapes are decoded", () => {
    expect(target(resolveImageDestination("/workspace/my%20shot.png"))).toBe(
      "/workspace/my shot.png",
    );
    // A malformed escape is not a reason to drop the reference.
    expect(target(resolveImageDestination("/workspace/100%.png"))).toBe("/workspace/100%.png");
  });

  test("http and https are kept as URLs, to be fetched from inside the VM", () => {
    expect(resolveImageDestination("https://example.com/x.png")).toEqual({
      kind: "url",
      url: "https://example.com/x.png",
      raw: "https://example.com/x.png",
    });
    expect(target(resolveImageDestination("http://example.com/x.png"))).toBe(
      "http://example.com/x.png",
    );
  });

  test("every other scheme is refused", () => {
    // curl speaks far more protocols than we want reachable, and `data:` would
    // only bloat the stored message.
    for (const destination of [
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "scp://host/x.png",
      "gopher://host/x",
      "//example.com/x.png",
      "#anchor",
      "",
    ]) {
      expect(resolveImageDestination(destination)).toBeNull();
    }
  });

  test("a malformed URL is refused rather than reaching a shell", () => {
    expect(resolveImageDestination("https://")).toBeNull();
    expect(resolveImageDestination("http://[")).toBeNull();
  });

  test("paths outside the workspace are still resolved", () => {
    // Deliberately not gated: the VM is the boundary, and an agent that wrote a
    // file to /tmp and cited it meant it.
    expect(target(resolveImageDestination("/tmp/plot.png"))).toBe("/tmp/plot.png");
    expect(target(resolveImageDestination("../outside.png"))).toBe("/outside.png");
  });
});

describe("streaming scanner", () => {
  test("a reference split across deltas is found once it closes", () => {
    const scanner = new ImageReferenceScanner();
    expect(scanner.next("Here is the chart: ![the")).toEqual([]);
    expect(scanner.next("Here is the chart: ![the chart](/workspace/a")).toEqual([]);
    const found = scanner.next("Here is the chart: ![the chart](/workspace/a.png) and more");
    expect(found.map((r) => target(r))).toEqual(["/workspace/a.png"]);
  });

  test("finds a reference however the deltas happen to be cut", () => {
    // The marker is two characters, so a delta boundary can land between the
    // `!` and the `[`. A cursor that advanced past a slice ending in `!` would
    // split the marker and never see the reference again. Character-at-a-time
    // is the worst case, and every chunk size is a subset of it.
    const reply = "Rendered it: ![the chart](/workspace/out/chart.png) done.";
    for (const size of [1, 2, 3, 7, 13]) {
      const scanner = new ImageReferenceScanner();
      const found: string[] = [];
      let text = "";
      for (const piece of reply.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []) {
        text += piece;
        found.push(...scanner.next(text).map((r) => target(r) ?? ""));
      }
      expect(found).toEqual(["/workspace/out/chart.png"]);
    }
  });

  test("every mention of one path is its own reference", () => {
    // An agent that shows a screenshot, fixes something and shows it again
    // means the new bytes the second time, so each mention is read afresh.
    const text = "![a](/w/a.png) then again ![a](/w/a.png)";
    const scanner = new ImageReferenceScanner();
    const found = scanner.next(text);
    expect(found.map((r) => r.raw)).toEqual(["/w/a.png", "/w/a.png"]);
    expect(found.map((r) => r.offset)).toEqual([0, text.lastIndexOf("![")]);
  });

  test("an occurrence already scanned is never reported twice", () => {
    const scanner = new ImageReferenceScanner();
    expect(scanner.next("![a](/w/a.png)").map((r) => r.offset)).toEqual([0]);
    // The same prefix again, with a new mention appended: only the new one.
    const found = scanner.next("![a](/w/a.png) and ![a](/w/a.png)");
    expect(found.map((r) => r.offset)).toEqual([19]);
  });

  test("offsets point at the reference, wherever it sits in the reply", () => {
    const text = "intro ![x](shot.png) middle ![x](/workspace/shot.png) end";
    const scanner = new ImageReferenceScanner();
    const found = scanner.next(text);
    expect(found.map((r) => r.raw)).toEqual(["shot.png", "/workspace/shot.png"]);
    expect(found.map((r) => r.offset)).toEqual([6, 28]);
    for (const reference of found) expect(text.startsWith("![", reference.offset)).toBe(true);
  });

  test("titles and angle brackets are understood", () => {
    const scanner = new ImageReferenceScanner();
    const found = scanner.next(`![a](/w/a.png "A title") ![b](</w/b b.png>) ![c](/w/c.png 'x')`);
    expect(found.map((r) => target(r))).toEqual(["/w/a.png", "/w/b b.png", "/w/c.png"]);
  });

  test("a link is not an image", () => {
    const scanner = new ImageReferenceScanner();
    expect(scanner.next("[not an image](/workspace/a.png)")).toEqual([]);
  });

  test("the cursor never rescans text it has finished with", () => {
    const scanner = new ImageReferenceScanner();
    const prose = "no images here. ".repeat(100);
    scanner.next(prose);
    // Appending a reference after settled prose still finds it, which is only
    // possible if the cursor advanced to the end rather than stalling.
    expect(scanner.next(`${prose}![a](/w/a.png)`).map((r) => target(r))).toEqual(["/w/a.png"]);
  });

  test("a stray bracket does not pin the cursor forever", () => {
    const scanner = new ImageReferenceScanner();
    const stray = `look at this ![ ${"x".repeat(5000)}`;
    scanner.next(stray);
    // The pin was abandoned, so a later reference is still picked up.
    expect(scanner.next(`${stray} ![a](/w/a.png)`).map((r) => target(r))).toEqual(["/w/a.png"]);
  });
});

describe("format sniffing", () => {
  test("recognizes the formats a browser renders", () => {
    expect(sniffImageMediaType(PNG)).toBe("image/png");
    expect(
      sniffImageMediaType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)])),
    ).toBe("image/jpeg");
    expect(sniffImageMediaType(Buffer.from("GIF89a               "))).toBe("image/gif");
    expect(sniffImageMediaType(Buffer.from("RIFF    WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMediaType(Buffer.from(`<svg xmlns="x"><rect/></svg>`))).toBe("image/svg+xml");
    expect(sniffImageMediaType(Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="x"/>`))).toBe(
      "image/svg+xml",
    );
  });

  test("a file that is not an image is rejected whatever it is called", () => {
    expect(sniffImageMediaType(Buffer.from("#!/bin/sh\necho hello, world\n"))).toBeNull();
    expect(sniffImageMediaType(Buffer.from("<html><body>hi</body></html>"))).toBeNull();
    expect(sniffImageMediaType(Buffer.alloc(4))).toBeNull();
  });
});

describe("reading a file out of a VM", () => {
  test("returns the bytes and the sniffed type", async () => {
    const sandbox = fakeSandbox({ "/workspace/a.png": PNG });
    const file = await readGuestImage(sandbox, "vm", "/workspace/a.png");
    expect(typeof file).not.toBe("string");
    if (typeof file === "string") return;
    expect(file.bytes.equals(PNG)).toBe(true);
    expect(file.mediaType).toBe("image/png");
  });

  test("reports why nothing came back, rather than throwing", async () => {
    const sandbox = fakeSandbox({
      "/workspace/notes.txt": Buffer.from("plain text, not an image at all"),
    });
    expect(await readGuestImage(sandbox, "vm", "/workspace/gone.png")).toBe("missing");
    expect(await readGuestImage(sandbox, "vm", "/workspace/notes.txt")).toBe("not-an-image");
  });

  test("reads a large file rather than refusing it", async () => {
    // No size ceiling: an agent that cites a path meant it, so whatever is
    // there is what gets shown.
    const big = Buffer.concat([PNG, Buffer.alloc(12 * 1024 * 1024, 1)]);
    const file = await readGuestImage(
      fakeSandbox({ "/workspace/big.png": big }),
      "vm",
      "/workspace/big.png",
    );
    expect(typeof file).not.toBe("string");
    if (typeof file === "string") return;
    expect(file.bytes.length).toBe(big.length);
  });

  test("a path with a quote in it cannot break out of the script", async () => {
    const calls: string[] = [];
    const sandbox = fakeSandbox({}, { calls });
    await readGuestImage(sandbox, "vm", "/workspace/'; rm -rf /; echo '.png");
    expect(calls[0]).toContain(`'/workspace/'\\''; rm -rf /; echo '\\''.png'`);
  });

  test("an exec failure is a failure, not a crash", async () => {
    const sandbox = {
      exec: () => Promise.reject(new Error("vm is gone")),
    } as unknown as SandboxApi;
    expect(await readGuestImage(sandbox, "vm", "/workspace/a.png")).toBe("unreadable");
  });
});

describe("fetching a remote image from inside the VM", () => {
  /** A sandbox that answers the curl snippet from a table of URLs. */
  function fetchSandbox(urls: Record<string, Buffer>, opts: { calls?: string[] } = {}): SandboxApi {
    return {
      async exec(_vmId: string, command: string) {
        opts.calls?.push(command);
        const url = command.match(/-- '([^']*)'/)?.[1];
        const bytes = url === undefined ? undefined : urls[url];
        if (!bytes) return { stdout: "", stderr: "", exitCode: 4 };
        return { stdout: bytes.toString("base64"), stderr: "", exitCode: 0 };
      },
    } as unknown as SandboxApi;
  }

  test("returns the bytes and the sniffed type", async () => {
    const sandbox = fetchSandbox({ "https://example.com/a.png": PNG });
    const file = await fetchGuestImage(sandbox, "vm", "https://example.com/a.png");
    expect(typeof file).not.toBe("string");
    if (typeof file === "string") return;
    expect(file.bytes.equals(PNG)).toBe(true);
    expect(file.mediaType).toBe("image/png");
  });

  test("a fetch that fails is reported, not thrown", async () => {
    expect(await fetchGuestImage(fetchSandbox({}), "vm", "https://example.com/gone.png")).toBe(
      "unreachable",
    );
    const dead = { exec: () => Promise.reject(new Error("vm is gone")) } as unknown as SandboxApi;
    expect(await fetchGuestImage(dead, "vm", "https://example.com/a.png")).toBe("unreachable");
  });

  test("the response's own content type is never trusted", async () => {
    // A URL that answers with a web page is not an image, whatever it claims.
    const sandbox = fetchSandbox({
      "https://example.com/page": Buffer.from("<html><body>not a picture</body></html>"),
    });
    expect(await fetchGuestImage(sandbox, "vm", "https://example.com/page")).toBe("not-an-image");
  });

  test("curl is pinned to http and https, and bounded", async () => {
    // Without the protocol pin the same call reaches file:, scp: and the rest,
    // turning a markdown image back into an arbitrary read.
    const calls: string[] = [];
    await fetchGuestImage(fetchSandbox({}, { calls }), "vm", "https://example.com/a.png");
    const script = calls[0] ?? "";
    expect(script).toContain("--proto '=http,https'");
    expect(script).toContain("--max-redirs");
    expect(script).toContain("--max-time");
  });

  test("a hostile URL cannot break out of the script or pose as an option", async () => {
    const calls: string[] = [];
    const sandbox = fetchSandbox({}, { calls });
    await fetchGuestImage(sandbox, "vm", "https://example.com/'; rm -rf /; echo 'x.png");
    const script = calls[0] ?? "";
    expect(script).toContain(`'https://example.com/'\\''; rm -rf /; echo '\\''x.png'`);
    // Passed after `--`, so a URL beginning with a dash is still a URL.
    expect(script).toContain("-- 'https://");
  });
});

describe("storing snapshots", () => {
  function setup() {
    const store = new UploadStore(createDb(":memory:"));
    return { store, instanceId: randomUUID(), chatId: randomUUID() };
  }

  test("writes the bytes to the host and records the row", () => {
    const { store, instanceId, chatId } = setup();
    const messageId = randomUUID();
    const image = storeAgentImage(store, {
      instanceId,
      chatId,
      messageId,
      sourcePath: "out/chart.png",
      offset: 0,
      file: { bytes: PNG, mediaType: "image/png" },
    });
    expect(image.filename).toBe("chart.png");
    expect(image.size).toBe(PNG.length);
    expect(readFileSync(uploadHostPath(instanceId, image.id, "chart.png")).equals(PNG)).toBe(true);
  });

  test("unchanged bytes at one path are stored once and shared", () => {
    const { store, instanceId, chatId } = setup();
    const first = storeAgentImage(store, {
      instanceId,
      chatId,
      messageId: randomUUID(),
      sourcePath: "shot.png",
      offset: 0,
      file: { bytes: PNG, mediaType: "image/png" },
    });
    const second = storeAgentImage(store, {
      instanceId,
      chatId,
      messageId: randomUUID(),
      sourcePath: "shot.png",
      offset: 0,
      file: { bytes: PNG, mediaType: "image/png" },
    });
    expect(second.id).toBe(first.id);
  });

  test("two occurrences are two snapshots, sharing the bytes when they match", () => {
    const { store, instanceId, chatId } = setup();
    const messageId = randomUUID();
    const shown = (offset: number, bytes: Buffer) =>
      storeAgentImage(store, {
        instanceId,
        chatId,
        messageId,
        sourcePath: "shot.png",
        offset,
        file: { bytes, mediaType: "image/png" },
      });

    // Same file, mentioned twice, unchanged in between: two occurrences the
    // renderer can tell apart, one copy on disk.
    const [first, second] = [shown(10, PNG), shown(200, PNG)];
    expect(first.offset).toBe(10);
    expect(second.offset).toBe(200);
    expect(second.id).toBe(first.id);

    // Rewritten before the third mention: its own bytes, and the earlier
    // occurrences keep pointing at what they were written about.
    const changed = Buffer.concat([PNG, Buffer.from("v2")]);
    const third = shown(400, changed);
    expect(third.id).not.toBe(first.id);
    expect(readFileSync(uploadHostPath(instanceId, first.id, "shot.png")).equals(PNG)).toBe(true);
    expect(readFileSync(uploadHostPath(instanceId, third.id, "shot.png")).equals(changed)).toBe(
      true,
    );
  });

  test("two chats in one instance do not share a snapshot", () => {
    // They would be indistinguishable to `removeForChat`, which deletes by chat
    // id, so deleting one chat would blank the other one's images.
    const { store, instanceId } = setup();
    const inChat = (chatId: string) =>
      storeAgentImage(store, {
        instanceId,
        chatId,
        messageId: randomUUID(),
        sourcePath: "shot.png",
        offset: 0,
        file: { bytes: PNG, mediaType: "image/png" },
      });
    expect(inChat(randomUUID()).id).not.toBe(inChat(randomUUID()).id);
  });

  test("deleting a chat takes its images with it, bytes included", () => {
    const { store, instanceId, chatId } = setup();
    const image = storeAgentImage(store, {
      instanceId,
      chatId,
      messageId: randomUUID(),
      sourcePath: "shot.png",
      offset: 0,
      file: { bytes: PNG, mediaType: "image/png" },
    });
    const path = uploadHostPath(instanceId, image.id, "shot.png");
    expect(existsSync(path)).toBe(true);

    store.removeForChat(chatId);
    // Bytes as well as the row: a per-mention screenshot left on disk after the
    // chat is gone is not reachable by anything, and nothing else would collect
    // it until the whole instance was removed.
    expect(existsSync(path)).toBe(false);
    expect(store.get(image.id)).toBeUndefined();
  });

  test("deleting one chat leaves another chat's identical image alone", () => {
    const { store, instanceId } = setup();
    const kept = randomUUID();
    const doomed = randomUUID();
    const inChat = (chatId: string) =>
      storeAgentImage(store, {
        instanceId,
        chatId,
        messageId: randomUUID(),
        sourcePath: "shot.png",
        offset: 0,
        file: { bytes: PNG, mediaType: "image/png" },
      });
    const keptImage = inChat(kept);
    const doomedImage = inChat(doomed);

    store.removeForChat(doomed);
    expect(existsSync(uploadHostPath(instanceId, doomedImage.id, "shot.png"))).toBe(false);
    expect(existsSync(uploadHostPath(instanceId, keptImage.id, "shot.png"))).toBe(true);
    expect(store.get(keptImage.id)).toBeDefined();
  });

  test("a path whose bytes changed is a new snapshot", () => {
    // The whole reason capture is eager: an overwritten screenshot must not
    // retroactively change what an earlier message was showing.
    const { store, instanceId, chatId } = setup();
    const before = storeAgentImage(store, {
      instanceId,
      chatId,
      messageId: randomUUID(),
      sourcePath: "shot.png",
      offset: 0,
      file: { bytes: PNG, mediaType: "image/png" },
    });
    const after = storeAgentImage(store, {
      instanceId,
      chatId,
      messageId: randomUUID(),
      sourcePath: "shot.png",
      offset: 0,
      file: { bytes: Buffer.concat([PNG, Buffer.from("changed")]), mediaType: "image/png" },
    });
    expect(after.id).not.toBe(before.id);
    expect(readFileSync(uploadHostPath(instanceId, before.id, "shot.png")).equals(PNG)).toBe(true);
  });

  test("snapshots never surface as a message's attachments", () => {
    // The attachment strip is the user's own uploads. An assistant's images
    // reach the client as render chunks instead.
    const { store, instanceId, chatId } = setup();
    const messageId = randomUUID();
    storeAgentImage(store, {
      instanceId,
      chatId,
      messageId,
      sourcePath: "shot.png",
      offset: 0,
      file: { bytes: PNG, mediaType: "image/png" },
    });
    expect(store.listForMessage(messageId)).toEqual([]);
    expect(store.byMessageForChat(chatId).size).toBe(0);
  });

  test("a snapshot id cannot be laundered into a user message's attachments", () => {
    const { store, instanceId, chatId } = setup();
    const image = storeAgentImage(store, {
      instanceId,
      chatId,
      messageId: randomUUID(),
      sourcePath: "shot.png",
      offset: 0,
      file: { bytes: PNG, mediaType: "image/png" },
    });
    expect(store.attach(instanceId, chatId, randomUUID(), [image.id])).toEqual([]);
  });
});

describe("collecting over a turn", () => {
  function collector(files: Record<string, Buffer>) {
    const published: AgentImageEvent[] = [];
    const store = new UploadStore(createDb(":memory:"));
    const instance = new AgentImageCollector({
      sandbox: fakeSandbox(files),
      uploadStore: store,
      vmId: "vm",
      instanceId: randomUUID(),
      chatId: randomUUID(),
      messageId: randomUUID(),
      publish: (image) => published.push(image),
    });
    return { collector: instance, published };
  }

  test("publishes a snapshot for each referenced image once the turn settles", async () => {
    const { collector: c, published } = collector({
      "/workspace/a.png": PNG,
      "/workspace/b.png": Buffer.concat([PNG, Buffer.from("b")]),
    });
    let text = "";
    for (const delta of ["Two charts: ![a](/works", "pace/a.png) and ![b](/workspace/b.png)."]) {
      text += delta;
      c.observe(text);
    }
    await c.settle();
    expect(published.map((image) => image.sourcePath)).toEqual([
      "/workspace/a.png",
      "/workspace/b.png",
    ]);
  });

  test("a reference that cannot be read publishes why, rather than nothing", async () => {
    // Silence would leave the reader with a caption and no idea whether the
    // file was absent, was not an image, or was never looked for at all.
    const { collector: c, published } = collector({
      "/workspace/notes.txt": Buffer.from("not an image, whatever it is called"),
    });
    c.observe("![gone](/workspace/gone.png) and ![notes](/workspace/notes.txt)");
    await c.settle();
    expect(published).toEqual([
      { sourcePath: "/workspace/gone.png", offset: 0, error: "missing" },
      { sourcePath: "/workspace/notes.txt", offset: 33, error: "not-an-image" },
    ]);
  });

  test("re-reads a path the reply shows again, and keeps both versions", async () => {
    // The case the whole design turns on: the agent shows a screenshot, fixes
    // the bug, overwrites the file, and shows it again in the same reply. Each
    // mention has to keep the bytes that were there when it was written.
    const files = { "/workspace/shot.png": PNG };
    const { collector: c, published } = collector(files);
    const before = "Here is the bug: ![bug](/workspace/shot.png)";
    c.observe(before);
    await c.settle();

    const rebuilt = Buffer.concat([PNG, Buffer.from("fixed")]);
    files["/workspace/shot.png"] = rebuilt;
    const after = `${before}\n\nAnd fixed: ![fixed](/workspace/shot.png)`;
    c.observe(after);
    await c.settle();

    expect(published).toHaveLength(2);
    const [first, second] = published as [AgentImage, AgentImage];
    expect(first.sourcePath).toBe("/workspace/shot.png");
    expect(second.sourcePath).toBe("/workspace/shot.png");
    expect(first.offset).toBe(before.indexOf("!["));
    expect(second.offset).toBe(after.lastIndexOf("!["));
    // Different bytes, so different stored copies, and the first mention still
    // points at the screenshot that was taken before the fix.
    expect(second.id).not.toBe(first.id);
    expect(first.size).toBe(PNG.length);
    expect(second.size).toBe(rebuilt.length);
  });

  test("publishes every occurrence in an image-heavy reply", async () => {
    // No per-turn ceiling: a reply that walks through two dozen screenshots
    // gets two dozen images.
    const files: Record<string, Buffer> = {};
    const references: string[] = [];
    for (let i = 0; i < 40; i++) {
      // Distinct bytes per file, so nothing is deduped into a shared row.
      files[`/workspace/${i}.png`] = Buffer.concat([PNG, Buffer.from(String(i))]);
      references.push(`![${i}](/workspace/${i}.png)`);
    }
    const { collector: c, published } = collector(files);
    c.observe(references.join(" "));
    await c.settle();
    expect(published.length).toBe(40);
  });

  test("settle waits for work queued while it is already draining", async () => {
    const { collector: c, published } = collector({ "/workspace/a.png": PNG });
    c.observe("![a](/workspace/a.png)");
    const settled = c.settle();
    c.observe("![a](/workspace/a.png) ![b](/workspace/b.png)");
    await settled;
    // b's failure is here, which it would not be had settle resolved on the
    // first drain alone. Only one a, because the cursor consumed that
    // occurrence on the first observe and does not revisit it.
    expect(published.map((image) => image.sourcePath)).toEqual([
      "/workspace/a.png",
      "/workspace/b.png",
    ]);
  });

  test("re-reads one path as many times as the reply shows it", async () => {
    const { collector: c, published } = collector({ "/workspace/a.png": PNG });
    const references: string[] = [];
    for (let i = 0; i < 25; i++) references.push(`![${i}](/workspace/a.png)`);
    c.observe(references.join(" "));
    await c.settle();
    expect(published.length).toBe(25);
    // Unchanged between mentions, so one copy on disk backs all of them.
    const ids = new Set(published.map((image) => ("id" in image ? image.id : null)));
    expect(ids.size).toBe(1);
    expect(ids.has(null)).toBe(false);
  });
});
