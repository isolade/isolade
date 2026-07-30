import { StreamingMarkdownCache } from "./streaming-markdown";

// Parser state that outlives the component that used it.
//
// A transcript's Markdown is expensive to parse and cheap to keep. Holding the
// parse inside the row's `useRef` ties it to the row's mount, which is why the
// workspace has to retain every open chat's DOM: unmounting would throw away
// work that costs real time to redo. Keyed here instead, a row can be unmounted
// and remounted for free, which is what lets the transcript be windowed and the
// off-screen panes be dropped entirely.
//
// Bounded, because a long-lived window with many chats open would otherwise
// accumulate parser state for every message ever displayed. Eviction is
// least-recently-used, and evicting only costs a re-parse the next time that
// message is displayed.
//
// The bound is on retained source text rather than entry count. A message
// produces several entries (its prose, each reasoning block), so a count is a
// poor proxy for what is actually held, and one set too low silently thrashes:
// everything is evicted before it can be reused and the cache does nothing
// while looking like it works. 32M characters is roughly 64MB, against the
// ~1GB that retaining the same transcripts as DOM costs today.
const MAX_SOURCE_CHARS = 32_000_000;
// Sweeping walks every entry, so amortise it rather than paying per lookup.
const SWEEP_INTERVAL = 512;

const entries = new Map<string, StreamingMarkdownCache>();
let sinceSweep = 0;

function sweep(): void {
  sinceSweep = 0;
  let total = 0;
  const keys = [...entries.keys()];
  // Newest first, so the least recently used are the ones that fall off.
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = keys[index] as string;
    const entry = entries.get(key);
    if (!entry) continue;
    total += entry.current().source.length;
    if (total > MAX_SOURCE_CHARS) entries.delete(key);
  }
}

/**
 * The parser state for `key`, creating it on first use. Callers must key by
 * something stable for the content, normally the message id plus a
 * discriminator for which piece of that message this is.
 */
export function retainMarkdownCache(key: string): StreamingMarkdownCache {
  const existing = entries.get(key);
  if (existing) {
    // Re-insert so iteration order stays least-recently-used first.
    entries.delete(key);
    entries.set(key, existing);
    return existing;
  }
  const created = new StreamingMarkdownCache();
  entries.set(key, created);
  if (++sinceSweep >= SWEEP_INTERVAL) sweep();
  return created;
}

/** Drop everything. Used when a test wants a cold parser. */
export function clearMarkdownCache(): void {
  entries.clear();
  sinceSweep = 0;
}

/** Entry count, for tests asserting the bound holds. */
export function markdownCacheSize(): number {
  return entries.size;
}
