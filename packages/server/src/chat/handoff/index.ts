// The cross-provider handoff service: turns a source transcript into a
// provider-neutral handoff, estimates the target's capacity for it, and decides
// how to reduce it when it does not fit.
//
// These are the pure, host-side building blocks (types, normalization,
// rendering, estimation, decision policy, chunking). Guest-side native
// transcript extraction, source-side compaction/summary forks, fresh target
// startup, and the persisted switch transaction wire these together in the
// backend and lifecycle layers.

export * from "./chunk";
export * from "./envelope";
export * from "./estimate";
export * from "./normalize-claude";
export * from "./normalize-isolade";
export * from "./reduce";
export * from "./render";
export * from "./types";
