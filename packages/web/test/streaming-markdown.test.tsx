import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../src/components/Markdown";
import StreamingMarkdown from "../src/components/StreamingMarkdown";
import {
  createStreamingMarkdownMetrics,
  StreamingMarkdownCache,
} from "../src/lib/streaming-markdown";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function render(content: string, streaming: boolean, cache = new StreamingMarkdownCache()) {
  return renderToStaticMarkup(
    <StreamingMarkdown cache={cache} content={content} streaming={streaming} />,
  );
}

function withoutFragmentWrappers(html: string): string {
  const marker = '<div class="markdown-fragment"';
  let cursor = 0;
  let result = "";
  while (true) {
    const open = html.indexOf(marker, cursor);
    if (open < 0) return result + html.slice(cursor);
    result += html.slice(cursor, open);
    const openEnd = html.indexOf(">", open);
    if (openEnd < 0) throw new Error("unterminated fragment wrapper");
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = openEnd + 1;
    let depth = 1;
    let closeStart = -1;
    let closeEnd = -1;
    while (depth > 0) {
      const match = tags.exec(html);
      if (!match) throw new Error("missing fragment wrapper close");
      if (match[0] === "<div") depth += 1;
      else depth -= 1;
      if (depth === 0) {
        closeStart = match.index;
        closeEnd = tags.lastIndex;
      }
    }
    result += html.slice(openEnd + 1, closeStart);
    cursor = closeEnd;
  }
}

describe("StreamingMarkdown display completion", () => {
  it.each([
    ["This is **bold", "<strong>bold</strong>"],
    ["This is *italic", "<em>italic</em>"],
    ["This is ***both", "<em><strong>both</strong></em>"],
    ["Use `code", ">code</code>"],
    ["This is ~~gone", "<del>gone</del>"],
    ["```ts\nconst value = 1", "<pre"],
    ["~~~ts\nconst value = 1", "<pre"],
  ])("renders an unfinished prefix without changing its source: %s", (source, expected) => {
    const original = `${source}`;
    const cache = new StreamingMarkdownCache();
    const model = cache.update(source, true);

    expect(model.source).toBe(source);
    expect(source).toBe(original);
    expect(render(source, true, cache)).toContain(expected);
  });

  it("renders an unambiguous incomplete link as non-clickable text", () => {
    const source = "See [the docs](https://exam";
    const cache = new StreamingMarkdownCache();
    const model = cache.update(source, true);
    const html = render(source, true, cache);

    expect(model.source).toBe(source);
    expect(model.displaySource).toBe("See the docs");
    expect(html).toContain("See the docs");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("https://exam");
  });

  it.each([
    "array[0",
    "items[",
    "Map<string",
    "a * b",
    "\\*literal",
  ])("does not reinterpret ambiguous text: %s", (source) => {
    const cache = new StreamingMarkdownCache();
    expect(cache.update(source, true).displaySource).toBe(source);
  });

  it("preserves list markers and bracket text inside code", () => {
    const list = new StreamingMarkdownCache().update("* item", true);
    const inline = new StreamingMarkdownCache().update("`[docs](", true);
    const fenced = new StreamingMarkdownCache().update("```txt\n[docs](", true);

    expect(list.displaySource).toBe("* item");
    expect(render("* item", true)).toContain("<ul");
    expect(inline.displaySource).toBe("`[docs](`");
    expect(render("`[docs](", true)).not.toContain("<a");
    expect(fenced.displaySource).toBe("```txt\n[docs](");
    expect(render("```txt\n[docs](", true)).not.toContain("<a");
  });

  it("leaves ambiguous link and image prefixes untouched", () => {
    expect(new StreamingMarkdownCache().update("Read [the docs", true).displaySource).toBe(
      "Read [the docs",
    );
    expect(new StreamingMarkdownCache().update("![diagram](https://exam", true).displaySource).toBe(
      "![diagram](https://exam",
    );
    expect(new StreamingMarkdownCache().update("\\[docs](https://exam", true).displaySource).toBe(
      "\\[docs](https://exam",
    );
    expect(
      new StreamingMarkdownCache().update("Read [a [b](https://exam", true).displaySource,
    ).toBe("Read [a [b](https://exam");
  });
});

describe("StreamingMarkdown fragment cache", () => {
  it("parses and schedules only the changing suffix", () => {
    const metrics = createStreamingMarkdownMetrics();
    const cache = new StreamingMarkdownCache(metrics);
    const first = cache.update("# Heading\n\nFirst paragraph.", true, true);
    const heading = first.fragments[0];
    const paragraph = first.fragments[1];
    expect(heading).toBeDefined();
    expect(paragraph).toBeDefined();

    metrics.blockParseCalls = 0;
    metrics.blockParseBytes = 0;
    metrics.scheduledFragmentRenders = 0;
    metrics.scheduledMarkdownBytes = 0;
    metrics.previewInputBytes = 0;

    const secondSource = "# Heading\n\nFirst paragraph. More.";
    const second = cache.update(secondSource, true, true);
    expect(second.fragments[0]).toBe(heading);
    expect(second.fragments[1]?.key).toBe(paragraph?.key);
    expect(second.fragments[1]).not.toBe(paragraph);
    expect(metrics.blockParseCalls).toBe(1);
    expect(metrics.blockParseBytes).toBe(bytes("First paragraph. More."));
    expect(metrics.previewInputBytes).toBe(bytes("First paragraph. More."));
    expect(metrics.scheduledFragmentRenders).toBe(1);
    expect(metrics.scheduledMarkdownBytes).toBe(bytes("First paragraph. More."));
  });

  it("does not schedule a sealed paragraph or code fence while later content grows", () => {
    const metrics = createStreamingMarkdownMetrics();
    const cache = new StreamingMarkdownCache(metrics);
    cache.update("Intro.\n\n```ts\nconst value = 1\n```", true, true);
    const withTail = cache.update("Intro.\n\n```ts\nconst value = 1\n```\n\nTail", true, true);
    const intro = withTail.fragments[0];
    const code = withTail.fragments[1];
    const tail = withTail.fragments[2];

    metrics.blockParseCalls = 0;
    metrics.blockParseBytes = 0;
    metrics.scheduledFragmentRenders = 0;
    metrics.scheduledMarkdownBytes = 0;
    metrics.previewInputBytes = 0;

    const next = cache.update(
      "Intro.\n\n```ts\nconst value = 1\n```\n\nTail keeps growing.",
      true,
      true,
    );
    expect(next.fragments[0]).toBe(intro);
    expect(next.fragments[1]).toBe(code);
    expect(next.fragments[2]?.key).toBe(tail?.key);
    expect(metrics.scheduledFragmentRenders).toBe(1);
    expect(metrics.scheduledMarkdownBytes).toBe(bytes("Tail keeps growing."));
    expect(metrics.blockParseBytes).toBe(bytes("Tail keeps growing."));
    expect(metrics.previewInputBytes).toBe(bytes("Tail keeps growing."));
  });

  it("keeps the active fragment key for its final canonical render", () => {
    const source = "Text **bold";
    const cache = new StreamingMarkdownCache();
    const live = cache.update(source, true);
    const liveTail = live.fragments.at(-1);
    const committed = cache.update(source, false);

    expect(live.displaySource).toBe("Text **bold**");
    expect(committed.source).toBe(source);
    expect(committed.displaySource).toBe(source);
    expect(committed.fragments.at(-1)?.key).toBe(liveTail?.key);
  });

  it("returns the identical model for an unchanged render", () => {
    const cache = new StreamingMarkdownCache();
    const first = cache.update("Stable", true);
    expect(cache.update("Stable", true)).toBe(first);
  });
});

describe("StreamingMarkdown global Markdown semantics", () => {
  it("falls back to one document fragment when a reference definition arrives", () => {
    const metrics = createStreamingMarkdownMetrics();
    const cache = new StreamingMarkdownCache(metrics);
    const before = cache.update("Read [the guide][guide].\n\nMore text.", true);
    expect(before.fragments.length).toBeGreaterThan(1);

    const source = "Read [the guide][guide].\n\nMore text.\n\n[guide]: https://example.com/guide";
    const after = cache.update(source, false);
    const html = render(source, false, cache);

    expect(after.referenceSensitive).toBe(true);
    expect(after.fragments).toHaveLength(1);
    expect(after.fragments[0]?.type).toBe("document");
    expect(html).toContain('<a href="https://example.com/guide"');
    expect(html).toContain("the guide</a>");
  });

  it("keeps canonical source immutable through every preview update", () => {
    const prefixes = ["Answer", "Answer **", "Answer **bold", "Answer **bold**"];
    const cache = new StreamingMarkdownCache();

    for (const prefix of prefixes) {
      const original = `${prefix}`;
      cache.update(prefix, true);
      expect(prefix).toBe(original);
      expect(cache.current().source).toBe(original);
    }
  });
});

describe("Markdown fenced code", () => {
  it("keeps canonical language and highlight classes with copyable source", () => {
    const html = renderToStaticMarkup(<Markdown content={"```ts\nconst stable = 42;\n```"} />);

    expect(html).toContain('class="language-ts hljs"');
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain("const");
    expect(html).toContain("stable = ");
    expect(html).toContain('aria-label="Copy code"');
  });
});

describe("StreamingMarkdown completed fidelity", () => {
  const corpus = [
    "Paragraph one.\n\n## Later heading\n\nParagraph two.",
    "- one\n- two\n\n1. first\n2. second",
    "- [x] done\n- [ ] next",
    "> quoted **text**\n> on two lines",
    "> quoted paragraph\n>\n> second paragraph\n\nAfter quote.",
    "- first paragraph\n\n  second paragraph\n- next item\n\nAfter list.",
    "| Name | Value |\n| :--- | ---: |\n| alpha | 1 |",
    "```ts\nconst greeting = `hello`;\n```\n\nUse `greeting`.",
    "A [link](https://example.com) and ![image](https://example.com/a.png).",
    "Read [the guide][guide].\n\n[guide]: https://example.com/guide",
    "Raw <span>HTML</span> stays canonical.",
    "Unicode: café, 東京, and 🦀.\r\n\r\nSecond line.",
    "---\n\n### Heading\n\nTrailing whitespace  \nline break.",
  ];

  it.each(corpus)("matches the canonical renderer for %s", (source) => {
    const canonical = renderToStaticMarkup(<Markdown content={source} />);
    const fragmented = withoutFragmentWrappers(render(source, false));
    const normalize = (html: string) => html.replace(/>\s+</g, "><");
    expect(normalize(fragmented)).toBe(normalize(canonical));
  });
});
