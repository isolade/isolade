import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownImageScope } from "../src/components/chat/blocks";
import type { StreamChunk } from "../src/components/chat/chunks";
import Markdown, {
  MarkdownImageContext,
  type MarkdownImageResolver,
} from "../src/components/Markdown";

function render(content: string, resolve?: MarkdownImageResolver): string {
  return renderToStaticMarkup(
    resolve ? (
      <MarkdownImageContext.Provider value={resolve}>
        <Markdown content={content} />
      </MarkdownImageContext.Provider>
    ) : (
      <Markdown content={content} />
    ),
  );
}

const resolveOne: MarkdownImageResolver = (source) =>
  source === "out/a.png" ? { status: "ready", href: "/api/uploads/upload-1" } : null;

/** Captures what the renderer asked for, to check the position it reports. */
function recordingResolver(): { resolve: MarkdownImageResolver; calls: [string, number][] } {
  const calls: [string, number][] = [];
  return {
    calls,
    resolve: (source, offset) => {
      calls.push([source, offset]);
      return { status: "ready", href: `/bytes/${calls.length}` };
    },
  };
}

describe("markdown images in an assistant reply", () => {
  it("renders a snapshotted path centred, unframed, and clickable", () => {
    const html = render("Here it is: ![a chart](out/a.png)", resolveOne);
    expect(html).toContain('src="/api/uploads/upload-1"');
    expect(html).toContain('alt="a chart"');
    expect(html).toContain("mx-auto");
    expect(html).not.toContain("border-border");
    // A button rather than a link: clicking opens the lightbox in place
    // instead of navigating to the bytes.
    expect(html).toContain("<button");
    expect(html).toContain("cursor-zoom-in");
    // Which is mounted closed, so a transcript of images costs no dialogs.
    expect(html).not.toContain("cursor-zoom-out");
  });

  it("falls back to the alt text when nothing was captured for the path", () => {
    const html = render("![the failing screen](/workspace/gone.png)", resolveOne);
    expect(html).not.toContain("<img");
    expect(html).toContain("the failing screen");
    expect(html).toContain("/workspace/gone.png");
  });

  it("says why the picture is not there, when the capture failed", () => {
    const reasons = {
      "/a.png": "missing",
      "/b.png": "not-an-image",
      "/c.png": "unreadable",
    } as const;
    const resolve: MarkdownImageResolver = (source) =>
      source in reasons
        ? { status: "failed", reason: reasons[source as keyof typeof reasons] }
        : null;
    expect(render("![x](/a.png)", resolve)).toContain("(file not found)");
    expect(render("![x](/b.png)", resolve)).toContain("(not an image)");
    expect(render("![x](/c.png)", resolve)).toContain("(could not be read)");
  });

  it("says so when no capture was even attempted", () => {
    // Distinct from every failure reason, so a bare chip can never be confused
    // with a server that is not running the capture at all.
    const html = render("![x](/workspace/never-tried.png)", () => null);
    expect(html).toContain("/workspace/never-tried.png");
    expect(html).toContain("(not captured)");
  });

  it("does not fetch a remote image the agent named, but does link it", () => {
    // A message composed inside a VM must not be able to make the app call out
    // to a host of the agent's choosing just by being rendered.
    const html = render("![tracker](https://example.com/pixel.png)", resolveOne);
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/pixel.png"');
  });

  it("leaves markdown outside an assistant turn exactly as it was", () => {
    // No resolver in context: user messages and every other call site keep the
    // plain <img> they have always rendered.
    const html = render("![x](https://example.com/x.png)");
    expect(html).toContain('<img src="https://example.com/x.png"');
  });

  it("reports where each image sits, so repeats of one path stay distinct", () => {
    const content = "First: ![a](shot.png) then later: ![a](shot.png)";
    const { resolve, calls } = recordingResolver();
    const html = render(content, resolve);
    expect(calls).toEqual([
      ["shot.png", content.indexOf("![")],
      ["shot.png", content.lastIndexOf("![")],
    ]);
    // Distinct positions gave distinct bytes, so both mentions render their own.
    expect(html).toContain('src="/bytes/1"');
    expect(html).toContain('src="/bytes/2"');
  });
});

describe("MarkdownImageScope", () => {
  function scoped(chunks: StreamChunk[], content: string): string {
    return renderToStaticMarkup(
      <MarkdownImageScope chunks={chunks} instanceId="inst-1">
        <Markdown content={content} />
      </MarkdownImageScope>,
    );
  }

  it("makes a turn's image chunks resolvable by the markdown beside them", () => {
    const html = scoped(
      [
        { kind: "text", text: "see ![a](out/a.png)" },
        {
          kind: "image",
          id: "upload-1",
          sourcePath: "out/a.png",
          offset: 4,
          filename: "a.png",
          mediaType: "image/png",
          size: 24,
        },
      ],
      "see ![a](out/a.png)",
    );
    expect(html).toContain("/api/instances/inst-1/uploads/upload-1");
  });

  it("still refuses remote images for a turn that captured nothing", () => {
    const html = scoped([], "![x](https://example.com/x.png)");
    expect(html).not.toContain("<img");
  });

  it("carries a failed capture's reason from the chunk to the chip", () => {
    const html = scoped(
      [
        { kind: "text", text: "see ![a](out/a.png)" },
        { kind: "image", sourcePath: "out/a.png", offset: 4, error: "missing" },
      ],
      "see ![a](out/a.png)",
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("(file not found)");
  });

  it("gives each mention of one path the bytes it was written about", () => {
    // The end of the chain: the agent showed a screenshot, rewrote it, and
    // showed it again. Both snapshots are on the turn, and position is what
    // decides which one each `![](…)` gets.
    const content = "Before: ![bug](shot.png)\n\nAfter: ![fixed](shot.png)";
    const snapshot = (id: string, offset: number) =>
      ({
        kind: "image",
        id,
        sourcePath: "shot.png",
        offset,
        filename: "shot.png",
        mediaType: "image/png",
        size: 24,
      }) as const;
    const html = scoped(
      [
        { kind: "text", text: content },
        snapshot("before", content.indexOf("![")),
        snapshot("after", content.lastIndexOf("![")),
      ],
      content,
    );
    // Only the rendered thumbnails: React also emits a preload <link> per
    // image, which would otherwise count each one twice.
    const order = [...html.matchAll(/<img src="[^"]*uploads\/(before|after)"/g)].map(
      (match) => match[1],
    );
    expect(order).toEqual(["before", "after"]);
  });
});
