# Submission Notes

## What This Implements

This repository builds a dependency graph for Composio's GoogleSuper and GitHub toolkits.

Each tool is represented as a node. An edge `A -> B` means tool `A` is a likely precursor for tool `B` because it can provide one of `B`'s required inputs.

## Improvements In This Run

- Added high-signal edge inference from parameter descriptions such as "call the X.Y method".
- Added output schema analysis so tools can be recognized as providers of IDs, emails, thread IDs, issue numbers, and similar values.
- Replaced the expensive all-provider scan with an indexed candidate lookup.
- Capped broad candidate sets after ranking them, which prevents generic params like `id` from scoring every tool.
- Moved provider scoring onto precomputed metadata so the hot loop does not repeatedly re-read schemas.
- Added candidate and score caches for repeated params and repeated provider/param scoring.
- Added profiling via `pnpm build:graph:profile`.
- Reworked the visualization into a graph explorer:
  - neighborhood mode by default,
  - selected tool centered between provider and downstream columns,
  - searchable tool list,
  - selected tool details,
  - score threshold control,
  - deterministic layout with no force simulation,
  - direct file open via `pnpm view:graph`.

## Current Build Stats

- Tools: 1304
- Edges: 4090
- Unique edge labels: 213
- Profiled build time: about 1.3s locally with inference at about 1.0s

## Performance Story

The initial dependency inference is naturally `O(N^2 * R)` because every required param can be compared against every provider tool.

The current implementation keeps the same scoring behavior but improves it incrementally:

- precompute provider tokens and output-schema fields,
- build a `token -> providers` index,
- score only candidate providers for each required param,
- cap broad candidate sets after ranking them.
- cache candidate lists and static provider/param scores.

This moves practical inference toward `O(N * R * K)`, where `K` is the indexed candidate count and is much smaller than the total tool count.

The latest profile shows `2201` candidate-cache hits and `154700` score-cache hits while preserving the same `4090` inferred edges.

## How To Review

Run:

```sh
pnpm build:graph:profile
pnpm graph:stats
pnpm view:graph
```

Use the visualization in neighborhood mode to inspect specific dependency chains. Use filtered or all-edge mode only when you need a broader diagnostic view.

For screenshots, use neighborhood mode with a searched tool such as `thread`, `calendar`, `issue`, or `repo`. The all-edge mode is intentionally diagnostic and is not the best presentation view.
