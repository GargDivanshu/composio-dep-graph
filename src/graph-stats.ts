import { readFile } from "fs/promises";

type Graph = {
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string; label: string }>;
};

async function main() {
  const raw = await readFile("tool_graph.json", "utf-8");
  const graph = JSON.parse(raw) as Graph;
  const nodes = graph.nodes?.length ?? 0;
  const edges = graph.edges?.length ?? 0;
  const edgeLabels = new Set(graph.edges?.map((e) => e.label) ?? []);

  console.log(`nodes=${nodes}`);
  console.log(`edges=${edges}`);
  console.log(`unique_edge_labels=${edgeLabels.size}`);

  if (edges === 0) {
    console.error(
      "ERROR: edges=0. Re-run `pnpm fetch:tools` then `pnpm build:graph`."
    );
    process.exit(1);
  }
}

await main();

