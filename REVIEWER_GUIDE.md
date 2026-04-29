# Reviewer Guide

## Goal

This submission builds a dependency graph for Composio's GoogleSuper and GitHub toolkits.

The graph answers this question:

> If a tool cannot run because a required input is missing, which other tool(s) can likely provide that input first?

For example, a tool that requires `thread_id` should point back to tools that list, search, or fetch threads.

## What To Run

```sh
pnpm i
pnpm fetch:tools
pnpm build:graph:profile
pnpm graph:stats
pnpm view:graph
```

`pnpm view:graph` opens `tool_graph.html` directly. No dev server is required.

## Suggested Screenshot

For a reviewer-facing screenshot:

1. Run `pnpm view:graph`.
2. Keep the default Neighborhood view selected.
3. Search for a recognizable tool such as `thread`, `calendar`, `issue`, or `repo`.
4. Select a tool with visible incoming and outgoing edges.
5. Capture the browser viewport.

This view is intentionally better for screenshots than the all-edge view because it shows a readable dependency chain instead of a dense diagnostic map.

## Generated Outputs

- `googlesuper_tools.json`: raw GoogleSuper tools from Composio.
- `github_tools.json`: raw GitHub tools from Composio.
- `tool_graph.json`: dependency graph data.
- `tool_graph.dot`: Graphviz-compatible graph.
- `tool_graph.html`: interactive visual graph explorer.

## Graph Semantics

Each node is a Composio tool.

Each edge is:

```txt
provider_tool -> consumer_tool [required_param]
```

The edge means the provider tool is a likely precursor because it can provide one required input for the consumer tool.

## Edge Quality Signals

Edges are inferred using ranked signals:

1. Explicit parameter descriptions such as "call the X.Y method".
2. Output schema fields such as `id`, `thread_id`, `email`, `repo`, or `issue_number`.
3. Name and description token matches.
4. Read-oriented tool boosts for list/search/get/retrieve tools.

## Visualization Design

The default view is a neighborhood explorer:

- selected tool in the center,
- provider tools on the left,
- downstream tools on the right,
- edge labels show the required param,
- large fan-outs are capped so the view remains readable.

Filtered and all-edge modes are kept for diagnostics, but neighborhood mode is the reviewer-friendly default.

## Performance Summary

Naive inference is `O(N^2 * R)` because each required param can scan every provider tool.

This implementation uses:

- provider token indexing,
- output schema token extraction,
- bounded broad-param candidate sets,
- candidate-list caching,
- static provider/param score caching.

Latest local profile:

```txt
tools=1304
requiredParams=2577
edges=4090
uniqueEdgeLabels=213
total=1.1s
infer=913ms
candidateCache=2201 hits / 376 misses
scoreCache=154700 hits / 36143 misses
```

See `PERFORMANCE.md` for the detailed complexity breakdown.
