# Performance Notes

## Symbols

- `N`: number of tools.
- `R`: average number of required params per tool.
- `T`: average number of provider tokens extracted per tool.
- `K`: average number of candidate providers considered for one required param after indexing.
- `E`: number of inferred dependency edges.

## Why The Naive Approach Was O(N^2)

The naive inference loop did this:

1. For each consumer tool, scan its required params.
2. For each required param, score every other tool as a possible provider.

That is approximately `O(N * R * N)`, or `O(N^2 * R)`.

With about 1300 tools, this is expensive enough to look frozen, especially because each score operation can normalize strings and inspect schemas.

Space complexity is low, but the time complexity is the problem:

- Time: `O(N^2 * R)`
- Space: `O(N + E)` for tools/nodes and inferred edges

## Current Indexed Approach

The graph builder now uses an index:

1. Precompute what each provider tool can produce.
   - Tokens from slug, name, and description.
   - Output fields from `outputParameters`.
   - Derived tokens for identifiers such as `calendar_id` and `thread_id`.

2. Build a `token -> provider tool ids` map.

3. For each required param, score only likely candidates from the index.

4. Use bounded fallback scans for low-signal params instead of scanning all tools.

This changes the practical scoring cost from `O(N^2 * R)` to approximately `O(N * R * K)`, where `K` is the number of candidates found through the index and is much smaller than `N`.

Broad params such as `id` can still match many providers, so the builder caps broad candidate sets at 250 after ranking them by same-toolkit match, fetcher-likeness, and token overlap with the consumer tool.

Current complexity:

- Token extraction: `O(N * T)`
- Token index build: `O(N * T)`
- Edge inference: `O(N * R * K)`
- Edge storage: `O(E)`
- Total time: `O(N * T + N * R * K)`
- Total space: `O(N * T + E)`

This is an incremental improvement over the naive version because it keeps the same scoring model and graph output, but reduces the provider search space before scoring.

## Candidate Cache Improvement

The current implementation already caches static provider facts:

- normalized name,
- normalized description,
- provided token set,
- fetcher/mutation classification.

It also caches param-level candidate lists:

- key: normalized required param,
- value: ranked provider ids for that param.

This avoids rebuilding the same candidate sets for common params such as `calendar_id`, `thread_id`, `repo`, `owner`, and `id`.

Practical effect:

- Without candidate caching, repeated params rebuild candidate sets for every consumer.
- With candidate caching, candidate construction becomes closer to `O(P * K)`, where `P` is the number of unique required params.
- Scoring still happens per consumer because explicit hints and self-loop penalties are consumer-specific.

This keeps the implementation incremental: same graph model, same scoring logic, less repeated work.

## Profiling

Run:

```sh
pnpm build:graph:profile
```

The profile output includes:

- total build time,
- load/index/inference/write phase times,
- required param count,
- average candidates per param,
- max candidates for any param,
- final edge count.

Latest local profile:

```txt
tools=1304
requiredParams=2577
edges=4090
avgCandidatesPerParam=74.1
maxCandidatesPerParam=250
candidateCache=2201 hits / 376 misses
scoreCache=154700 hits / 36143 misses
total=1.3s
infer=1.0s
```

## Visualization Performance

The HTML visualization does not run a force simulation. It uses a deterministic layout and redraws only when the user interacts with the graph.

The default edge mode is focused, so it shows the selected node neighborhood instead of drawing thousands of edges at once.
