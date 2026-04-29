import { writeFile } from "fs/promises";
import { Composio } from "@composio/core";

const composio = new Composio();

const toolkits = ["googlesuper", "github"] as const;

for (const toolkit of toolkits) {
  const tools = await composio.tools.getRawComposioTools({
    toolkits: [toolkit],
    limit: 1000,
  });

  const outPath = `${toolkit}_tools.json`;
  await writeFile(outPath, JSON.stringify(tools, null, 2), "utf-8");
  console.log(`Wrote ${outPath} (${tools.length} tools)`);
}

