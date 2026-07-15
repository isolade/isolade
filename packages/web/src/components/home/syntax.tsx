// Diff-line highlighting. Thin re-export of the shared highlight engine (see
// lib/highlight): the diff view highlights each hunk line independently, so a
// line inside a block comment / multi-line string colours as code, an accepted
// tradeoff for a lightweight, blob-free diff.
export { highlightLine } from "@/lib/highlight";
