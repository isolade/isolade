import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { WORKSPACE_ROOT } from "./contracts";
import type { SandboxApi } from "./sandbox-client";
import { shellQuote } from "./shell";
import type { UploadStore } from "./uploads";
import { ensureHostUploadDir, safeFilename } from "./uploads";

// Inline images in an assistant's reply.
//
// The agent writes ordinary markdown, `![a chart](/workspace/out/chart.png)`,
// and the transcript shows the picture. The catch is that the file is inside a
// VM that keeps working: agents iterate, and the same `screenshot.png` gets
// overwritten three times in a turn. Rendering it live from the VM would mean
// every mention of that path showed the *last* bytes written, and once the
// instance is gone the transcript would show nothing at all.
//
// So a reference is snapshotted the moment it appears: the scanner runs on the
// accumulating turn text, and as soon as a `![](…)` closes, the bytes are
// copied out to the host and stored like any other message attachment (see
// uploads.ts, which owns the on-disk layout this reuses). The agent writes the
// file before it writes the prose mentioning it, so by the time the reference
// closes the bytes are already there.
//
// The stored copy is display-only. Nothing here changes the message text, which
// stays exactly what the model wrote: the snapshot is looked up by the path the
// agent used, and the renderer resolves `![](…)` against it (see
// packages/web/src/components/Markdown.tsx).

/** How long a single copy-out may take before it is abandoned. */
const READ_TIMEOUT_MS = 20_000;

/** How long one remote fetch may take. Tighter than the local read, because the
 * turn cannot commit until every capture has settled and a slow host would hold
 * the whole reply back. */
const FETCH_TIMEOUT_MS = 15_000;

// Exit-code sentinels from the capture snippets below.
const EXIT_NOT_A_FILE = 2;
const EXIT_FETCH_FAILED = 4;

// A markdown image: `![alt](dest)`, with an optional title and an optional
// angle-bracketed destination. Deliberately looser than CommonMark, because a
// false positive costs one wasted read while a miss costs a broken image: the
// client's own markdown parse decides what actually renders, so a reference
// matched here inside a fenced code block simply resolves against nothing.
const IMAGE_REFERENCE =
  /!\[[^\]]*\]\(\s*(<[^<>\n]*>|[^\s()]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;

// An unterminated `![` pins the scan cursor so the reference is still matched
// once the rest of it streams in. Past this many characters the pin is
// abandoned: no real destination is this long, so what is holding it open is
// prose that merely happens to contain `![`, and keeping the cursor there would
// mean rescanning an ever-growing tail on every delta.
const MAX_PENDING_REFERENCE_CHARS = 4096;

/** Where a markdown image destination points, and how to get the bytes.
 *
 * `raw` is the destination exactly as written, on both variants, because that
 * is what the renderer matches against. */
export type ImageDestination =
  | { kind: "file"; path: string; raw: string }
  | { kind: "url"; url: string; raw: string };

/** One `![](…)` in the reply, at the place it was written. `offset` is where the
 * `![` sits in the message text: two mentions of one destination are two
 * references, told apart by this, so each shows the bytes that were there when
 * it was written. */
export type ImageReference = ImageDestination & { offset: number };

/**
 * Work out what a matched destination points at.
 *
 * A path becomes absolute against the workspace. An http(s) URL is kept as a
 * URL, to be fetched from inside the VM rather than by the browser or the host:
 * the browser fetching it would let a reply composed in a sandbox make the app
 * call out to a host of the agent's choosing, and the host fetching it would
 * reach past the network policy onto the user's own network. The guest is the
 * boundary that already exists (see network-config-store: local network and
 * host access are both off by default).
 *
 * Everything else is null: `data:` (self-contained, and it would bloat the
 * stored message), `file:` and other schemes (curl speaks far more protocols
 * than we want reachable), protocol-relative `//host/x`, and bare fragments.
 */
export function resolveImageDestination(destination: string): ImageDestination | null {
  const unwrapped =
    destination.startsWith("<") && destination.endsWith(">")
      ? destination.slice(1, -1)
      : destination;
  const raw = unwrapped.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (/^https?:\/\//i.test(raw)) {
    // Parsed rather than pattern-matched so a malformed URL is refused here
    // instead of reaching a shell.
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return { kind: "url", url: url.toString(), raw };
    } catch {
      return null;
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  // Markdown destinations may percent-encode spaces and other awkward bytes.
  // A malformed escape is not a reason to drop the reference, so fall back to
  // the literal text.
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  // A relative path has no cwd to resolve against by the time this renders, so
  // read it the way the rest of the product does, against the workspace root.
  const absolute = decoded.startsWith("/")
    ? posix.normalize(decoded)
    : posix.normalize(posix.join(WORKSPACE_ROOT, decoded));
  if (!absolute.startsWith("/")) return null;
  return { kind: "file", path: absolute, raw };
}

/**
 * Incremental scanner over an assistant turn's accumulating text.
 *
 * Rescanning the whole message on every delta would be quadratic in the length
 * of the turn, so the cursor only ever moves forward, stopping just before a
 * `![` that hasn't closed yet so a reference split across deltas is still seen
 * whole.
 */
export class ImageReferenceScanner {
  private cursor = 0;

  /**
   * References that became complete since the last call.
   *
   * Every occurrence is reported, including a second mention of a path already
   * seen: an agent that shows a screenshot, fixes something and shows it again
   * means the new bytes the second time. The cursor only moves forward over
   * matched text, so no occurrence is reported twice.
   */
  next(text: string): ImageReference[] {
    const slice = text.slice(this.cursor);
    if (!slice) return [];
    const found: ImageReference[] = [];
    let matchEnd = 0;
    for (const match of slice.matchAll(IMAGE_REFERENCE)) {
      matchEnd = match.index + match[0].length;
      const destination = match[1];
      if (!destination) continue;
      const resolved = resolveImageDestination(destination);
      if (!resolved) continue;
      found.push({ ...resolved, offset: this.cursor + match.index });
    }
    // Resume from an unclosed `![` so the rest of it can stream in, unless it
    // has been open so long that it cannot be a real reference.
    const pending = slice.lastIndexOf("![");
    // With nothing pending the cursor still holds back the final character,
    // because a slice ending in `!` may be the first half of a marker whose
    // bracket is in the next delta. Advancing past it would split the `![`
    // across the cursor, where no later scan can ever see it whole.
    const resumeAt =
      pending >= matchEnd && slice.length - pending <= MAX_PENDING_REFERENCE_CHARS
        ? pending
        : Math.max(0, slice.length - 1);
    this.cursor += resumeAt;
    return found;
  }
}

/** What a file at a given path was, at the moment it was read. */
export interface GuestFile {
  bytes: Buffer;
  mediaType: string;
}

/** Why a reference produced no picture. Reaches the transcript, so the reader
 * is told what went wrong rather than just seeing the caption. */
export type ReadFailure = "missing" | "not-an-image" | "unreadable" | "unreachable";

/**
 * Copy a file out of a VM.
 *
 * There is no read side to the sandbox file API (it can write, see
 * SandboxApi.writeFile), and the guest cannot dial the host, so the bytes come
 * back base64 over the exec channel the host already holds open. `base64 | tr -d`
 * rather than GNU's `-w0`, which busybox's applet does not have.
 *
 * Size is not bounded. An agent that cites a path means it, so whatever is there
 * is what gets shown. Note that `exec` buffers: the whole base64 string comes
 * back through host memory at once, so a genuinely enormous file is a genuinely
 * enormous allocation.
 */
export async function readGuestImage(
  sandbox: SandboxApi,
  vmId: string,
  path: string,
): Promise<GuestFile | ReadFailure> {
  const quoted = shellQuote(path);
  const script = [
    `[ -f ${quoted} ] || exit ${EXIT_NOT_A_FILE}`,
    `base64 < ${quoted} | tr -d '\\n'`,
  ].join("\n");
  let result: { stdout: string; exitCode: number };
  try {
    result = await sandbox.exec(vmId, script, { timeoutMs: READ_TIMEOUT_MS });
  } catch {
    return "unreadable";
  }
  if (result.exitCode === EXIT_NOT_A_FILE) return "missing";
  if (result.exitCode !== 0) return "unreadable";
  return decodeGuestImage(result.stdout);
}

/**
 * Fetch a remote image from inside the VM.
 *
 * The guest does this, not the host and not the browser. The guest's traffic
 * already runs under the profile's network policy, where reaching the local
 * network and the host are both off by default, so an agent cannot turn a
 * markdown image into a probe of the user's own machine. A host-side fetch
 * would sit outside all of that.
 *
 * curl is pinned to http and https: it speaks a dozen other protocols, and
 * `file:` or `scp:` would turn this back into an arbitrary read. Redirects are
 * followed but counted, and the whole thing is time-boxed, because the turn
 * cannot commit until every capture has settled.
 *
 * The response's own `Content-Type` is never consulted. What the bytes are is
 * decided by sniffing them, so a URL that answers with HTML is simply not an
 * image.
 */
export async function fetchGuestImage(
  sandbox: SandboxApi,
  vmId: string,
  url: string,
): Promise<GuestFile | ReadFailure> {
  // `--` so a URL that begins with a dash cannot be read as an option, and the
  // whole thing single-quoted on top of that.
  const script = [
    `f=$(mktemp) || exit 1`,
    `curl --fail --silent --show-error --location --proto '=http,https' ` +
      `--max-redirs 3 --max-time ${Math.floor(FETCH_TIMEOUT_MS / 1000)} ` +
      `-o "$f" -- ${shellQuote(url)} || { rm -f "$f"; exit ${EXIT_FETCH_FAILED}; }`,
    `base64 < "$f" | tr -d '\\n'`,
    `rm -f "$f"`,
  ].join("\n");
  let result: { stdout: string; exitCode: number };
  try {
    // A little longer than curl's own budget, so the transport does not abort
    // a fetch that curl is about to give up on and report properly.
    result = await sandbox.exec(vmId, script, { timeoutMs: FETCH_TIMEOUT_MS + 5_000 });
  } catch {
    return "unreachable";
  }
  if (result.exitCode === EXIT_FETCH_FAILED) return "unreachable";
  if (result.exitCode !== 0) return "unreachable";
  return decodeGuestImage(result.stdout);
}

/** Whichever way the bytes were obtained, they arrive base64 on stdout. */
function decodeGuestImage(stdout: string): GuestFile | ReadFailure {
  const bytes = Buffer.from(stdout.trim(), "base64");
  if (bytes.length === 0) return "unreadable";
  const mediaType = sniffImageMediaType(bytes);
  if (!mediaType) return "not-an-image";
  return { bytes, mediaType };
}

/** Get the bytes behind one reference, however it points at them. */
export function captureGuestImage(
  sandbox: SandboxApi,
  vmId: string,
  destination: ImageDestination,
): Promise<GuestFile | ReadFailure> {
  return destination.kind === "url"
    ? fetchGuestImage(sandbox, vmId, destination.url)
    : readGuestImage(sandbox, vmId, destination.path);
}

/**
 * The image format a buffer actually holds, from its leading bytes.
 *
 * Extensions are the agent's to choose and say nothing about content, and a
 * path that turns out to be a log file should degrade to its alt text rather
 * than becoming a broken `<img>`. Only the formats a browser renders natively
 * are recognized; anything else reads as "not an image".
 */
export function sniffImageMediaType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const leading = bytes.subarray(0, 6).toString("latin1");
  if (leading === "GIF87a" || leading === "GIF89a") return "image/gif";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  // SVG is text, so it is sniffed by its markup rather than a magic number. A
  // leading XML declaration or comment may precede the root element, so look
  // through a bounded prefix rather than only at the first tag.
  const prefix = bytes.subarray(0, 1024).toString("utf8").trimStart();
  if (prefix.startsWith("<?xml") || prefix.startsWith("<!--") || prefix.startsWith("<svg")) {
    if (/<svg[\s>]/i.test(prefix)) return "image/svg+xml";
  }
  return null;
}

/** Which `![](…)` in the reply an event is about. The renderer's only way to
 * tell two mentions of one path apart. */
interface AgentImageAt {
  sourcePath: string;
  offset: number;
}

/** A stored snapshot, as published to the client. */
export interface AgentImage extends AgentImageAt {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
}

/** A reference whose bytes never arrived. Published like a snapshot, so the
 * transcript can say what went wrong rather than leaving a caption that looks
 * the same whether the file was missing, was not an image, or could not be
 * read at all. */
export interface AgentImageFailure extends AgentImageAt {
  error: ReadFailure;
}

export type AgentImageEvent = AgentImage | AgentImageFailure;

/** What to call the stored copy. The last path segment of a file path or of a
 * URL, which is usually the real name and always something a download dialog can
 * show. A URL's query and fragment are not part of it, and a URL that ends in a
 * slash or names nothing usable falls back to a generic name. */
function downloadFilename(sourcePath: string): string {
  if (/^https?:\/\//i.test(sourcePath)) {
    try {
      return safeFilename(posix.basename(new URL(sourcePath).pathname)) || "image";
    } catch {
      return "image";
    }
  }
  return safeFilename(posix.basename(sourcePath));
}

/**
 * Store one occurrence's bytes and metadata.
 *
 * Every occurrence gets its own record, because that is the whole point: two
 * mentions of one path are two moments in time, and the second may be looking
 * at a file the agent has since rewritten. Bytes, on the other hand, are shared
 * whenever they are identical, so a path shown twice unchanged occupies one copy
 * on disk and is simply pointed at twice.
 */
export function storeAgentImage(
  uploadStore: UploadStore,
  opts: {
    instanceId: string;
    chatId: string;
    messageId: string;
    sourcePath: string;
    offset: number;
    file: GuestFile;
  },
): AgentImage {
  const { instanceId, chatId, messageId, sourcePath, offset, file } = opts;
  const contentHash = createHash("sha256").update(file.bytes).digest("hex");
  const existing = uploadStore.findAgentImage(instanceId, chatId, sourcePath, contentHash);
  if (existing) {
    uploadStore.attachAgentImage(chatId, messageId, existing.id);
    return {
      id: existing.id,
      sourcePath,
      offset,
      filename: existing.filename,
      mediaType: existing.mediaType,
      size: existing.size,
    };
  }
  const filename = downloadFilename(sourcePath);
  const id = randomUUID();
  writeFileSync(join(ensureHostUploadDir(instanceId, id), filename), file.bytes);
  const stored = uploadStore.recordAgentImage({
    id,
    instanceId,
    chatId,
    messageId,
    filename,
    mediaType: file.mediaType,
    size: file.bytes.length,
    sourcePath,
    contentHash,
  });
  uploadStore.attachAgentImage(chatId, messageId, id);
  return { ...stored, sourcePath, offset };
}

/**
 * Per-turn driver: scan, copy out, store, announce.
 *
 * Created once per assistant turn and fed the accumulated text on every delta.
 * Scanning is synchronous and cheap so it can sit on the delta path; the copy
 * out of the VM is not, so it runs on a single serialized worker whose promise
 * the turn awaits before it finalizes. Serialized rather than parallel because
 * these share one exec channel with the agent's own tool calls, and a burst of
 * concurrent reads would compete with the work being described.
 */
export class AgentImageCollector {
  private readonly scanner = new ImageReferenceScanner();
  private readonly queue: ImageReference[] = [];
  private draining: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      sandbox: SandboxApi;
      uploadStore: UploadStore;
      vmId: string;
      instanceId: string;
      chatId: string;
      messageId: string;
      /** Publishes the render event for a settled reference, captured or not. */
      publish: (image: AgentImageEvent) => void;
    },
  ) {}

  /** Feed the turn's text so far. Cheap enough for every delta. */
  observe(text: string): void {
    const references = this.scanner.next(text);
    if (references.length === 0) return;
    this.queue.push(...references);
    this.draining = this.draining.then(() => this.drain());
  }

  /** Wait for every reference seen so far to be stored. Called once the turn's
   * text is complete, so the transcript is whole before the message commits. */
  async settle(): Promise<void> {
    // `observe` chains another drain onto the tail, so awaiting the promise
    // captured here is not enough on its own: follow the chain until it stops
    // moving.
    let pending = this.draining;
    for (;;) {
      await pending;
      if (pending === this.draining) return;
      pending = this.draining;
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const reference = this.queue.shift();
      if (!reference) return;
      // Keyed by the destination as written, which is what the renderer has to
      // match. The resolved absolute path is only how the file was reached.
      const at = { sourcePath: reference.raw, offset: reference.offset };
      try {
        const file = await captureGuestImage(this.deps.sandbox, this.deps.vmId, reference);
        if (typeof file === "string") {
          console.warn(`[agent-images] ${reference.raw}: ${file}`);
          this.deps.publish({ ...at, error: file });
          continue;
        }
        this.deps.publish(
          storeAgentImage(this.deps.uploadStore, {
            instanceId: this.deps.instanceId,
            chatId: this.deps.chatId,
            messageId: this.deps.messageId,
            ...at,
            file,
          }),
        );
      } catch (err) {
        // Storing threw (a full disk, a DB the migration never reached). The
        // read itself already reports its own failures above, so anything
        // landing here is ours rather than the guest's.
        console.warn(`[agent-images] failed to snapshot ${reference.raw}:`, err);
        this.deps.publish({ ...at, error: "unreadable" });
      }
    }
  }
}
