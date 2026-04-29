import { readFile, writeFile } from "fs/promises";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

type ToolLike = Record<string, unknown>;

type GraphNode = {
  id: string;
  label: string;
  toolkit: string;
};

type GraphEdge = {
  from: string;
  to: string;
  label: string;
  score: number;
};

type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

function nowMs(): number {
  return Date.now();
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m${rem.toFixed(0)}s`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getToolName(tool: ToolLike): string {
  // Prefer stable identifiers for graph node ids.
  const candidates = [tool.slug, tool.toolName, tool.action, tool.id, tool.name];
  for (const c of candidates) {
    const s = asString(c);
    if (s) return s;
  }
  return "UNKNOWN_TOOL";
}

function getToolLabel(tool: ToolLike): string {
  const candidates = [tool.name, tool.slug, tool.toolName, tool.action, tool.id];
  for (const c of candidates) {
    const s = asString(c);
    if (s) return s;
  }
  return "UNKNOWN_TOOL";
}

function getToolDescription(tool: ToolLike): string {
  const candidates = [tool.description, tool.desc, tool.summary];
  for (const c of candidates) {
    const s = asString(c);
    if (s) return s;
  }
  return "";
}

function normalizeToken(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function guessToolkit(tool: ToolLike, fallback: string): string {
  const meta =
    asRecord(tool.toolkit) ??
    asRecord(tool.toolKit) ??
    asRecord(tool.metadata);
  const metaName =
    (meta ? asString(meta.name) : null) ??
    asString(tool.toolkit) ??
    asString(tool.toolKit) ??
    asString(tool.toolkitName);
  return normalizeToken(metaName ?? fallback) || fallback;
}

type JsonSchema = {
  required?: unknown;
  properties?: unknown;
  description?: unknown;
  title?: unknown;
};

function extractSchema(tool: ToolLike): JsonSchema | null {
  const direct =
    asRecord(tool.inputParameters) ??
    asRecord(tool.input_parameters) ??
    asRecord(tool.parameters) ??
    asRecord(tool.inputSchema) ??
    asRecord(tool.input_schema) ??
    asRecord(tool.schema);
  if (direct) return direct as JsonSchema;

  const maybeFunction = asRecord(tool.function);
  if (maybeFunction) {
    const params = asRecord(maybeFunction.parameters);
    if (params) return params as JsonSchema;
  }
  return null;
}

function extractRequiredParams(tool: ToolLike): string[] {
  const schema = extractSchema(tool);
  if (!schema) return [];
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.map((r) => asString(r)).filter((x): x is string => !!x);
}

function extractAllParams(tool: ToolLike): string[] {
  const schema = extractSchema(tool);
  if (!schema) return [];
  const properties = asRecord(schema.properties);
  if (!properties) return [];
  return Object.keys(properties);
}

function extractParamDescription(tool: ToolLike, param: string): string {
  const schema = extractSchema(tool);
  if (!schema) return "";
  const properties = asRecord(schema.properties);
  if (!properties) return "";
  const paramSchema = asRecord(properties[param]);
  if (!paramSchema) return "";
  return asString(paramSchema.description) ?? "";
}

function extractOutputSchema(tool: ToolLike): Record<string, unknown> | null {
  return (
    asRecord(tool.outputParameters) ??
    asRecord(tool.output_parameters) ??
    asRecord(tool.outputSchema) ??
    asRecord(tool.output_schema)
  );
}

function collectSchemaPropertyNames(schema: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    const rec = asRecord(node);
    if (!rec) return;
    const props = asRecord(rec.properties);
    if (props) {
      for (const k of Object.keys(props)) out.push(k);
      for (const k of Object.keys(props)) visit(props[k]);
    }
    const items = rec.items;
    if (items) visit(items);
    const anyOf = rec.anyOf;
    if (Array.isArray(anyOf)) for (const x of anyOf) visit(x);
    const oneOf = rec.oneOf;
    if (Array.isArray(oneOf)) for (const x of oneOf) visit(x);
    const allOf = rec.allOf;
    if (Array.isArray(allOf)) for (const x of allOf) visit(x);
  };
  visit(schema);
  return out;
}

function extractExplicitMethodHints(text: string): string[] {
  // Examples seen in these tool docs:
  // - "To retrieve calendar IDs call the calendarList.list method."
  // - "call the X method"
  const out: string[] = [];
  const t = text;
  const re = /\bcall\s+(?:the\s+)?([a-zA-Z0-9]+)\.([a-zA-Z0-9_]+)\s+method\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const svc = m[1] ?? "";
    const op = m[2] ?? "";
    if (svc && op) out.push(`${svc}.${op}`);
  }
  return out;
}

function singularize(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function toolProvidesTokens(tool: ToolLike): Set<string> {
  const name = normalizeToken(getToolName(tool));
  const desc = normalizeToken(getToolDescription(tool));
  const tokens = new Set<string>();

  for (const t of name.split("_")) if (t) tokens.add(t);
  for (const t of desc.split("_")) if (t) tokens.add(t);

  const nameUpper = getToolName(tool).toUpperCase();
  const m = nameUpper.match(/^(LIST|SEARCH|FIND|GET|RETRIEVE)_([A-Z0-9_]+)$/);
  if (m) {
    const objectRaw = normalizeToken(m[2] ?? "");
    if (objectRaw) {
      const objectSingular = singularize(objectRaw);
      tokens.add(objectRaw);
      tokens.add(objectSingular);
      tokens.add(`${objectSingular}_id`);
      tokens.add(`${objectRaw}_id`);
    }
  }

  // If a tool accepts an *_id, it's a strong hint it can also surface that id
  // through listing or searching flows (heuristic, but works well for routers).
  for (const p of extractAllParams(tool)) {
    const pn = normalizeToken(p);
    if (pn.endsWith("_id")) tokens.add(pn);
  }

  // Outputs are stronger signals: if a tool returns a field, it "provides" it.
  const outSchema = extractOutputSchema(tool);
  if (outSchema) {
    for (const k of collectSchemaPropertyNames(outSchema)) {
      const pn = normalizeToken(k);
      if (pn) tokens.add(pn);
    }
  }

  return tokens;
}

function scoreProviderForParam(
  provider: ToolLike,
  consumer: ToolLike,
  param: string
): number {
  const providerName = getToolName(provider).toUpperCase();
  const providerDesc = getToolDescription(provider).toLowerCase();

  const consumerName = getToolName(consumer).toUpperCase();
  const paramN = normalizeToken(param);

  let score = 0;

  // Highest-signal: explicit hint in param description.
  const paramDesc = extractParamDescription(consumer, param);
  const hints = extractExplicitMethodHints(paramDesc);
  if (hints.length) {
    const providerSlug = getToolName(provider).toUpperCase();
    for (const h of hints) {
      const hTok = normalizeToken(h).toUpperCase(); // calendarlist_list
      if (providerSlug.includes(hTok)) score += 80;
    }
  }

  // prefer tools that "sound like" they can fetch things
  if (
    /(LIST|SEARCH|FIND|GET|RETRIEVE)/.test(providerName) ||
    providerDesc.includes("list") ||
    providerDesc.includes("search") ||
    providerDesc.includes("get ")
  ) {
    score += 2;
  }

  // direct token match
  if (toolProvidesTokens(provider).has(paramN)) score += 6;

  // param appears in provider description/name
  if (normalizeToken(providerDesc).includes(paramN)) score += 3;
  if (normalizeToken(providerName).includes(paramN)) score += 3;

  // soft match for *_id parameters: match on the base noun
  if (paramN.endsWith("_id")) {
    const base = paramN.slice(0, -3);
    if (base && toolProvidesTokens(provider).has(base)) score += 3;
    if (base && normalizeToken(providerDesc).includes(base)) score += 2;
    if (base && normalizeToken(providerName).includes(base)) score += 2;
  }

  // discourage self loops
  if (providerName === consumerName) score -= 100;

  return score;
}

async function readToolsFile(path: string): Promise<ToolLike[]> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as Json;
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} did not contain an array`);
  }
  return parsed.filter((x) => !!asRecord(x)) as ToolLike[];
}

function toNodeId(toolkit: string, toolName: string): string {
  return `${normalizeToken(toolkit)}::${toolName}`;
}

function toLabel(toolName: string): string {
  return toolName.replaceAll("_", " ");
}

function escapeDotLabel(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function toDot(graph: Graph): string {
  const lines: string[] = [];
  lines.push("digraph ToolDeps {");
  lines.push('  graph [rankdir="LR"];');
  lines.push('  node [shape="box", style="rounded"];');

  for (const node of graph.nodes) {
    lines.push(
      `  "${escapeDotLabel(node.id)}" [label="${escapeDotLabel(
        `${node.toolkit}: ${node.label}`
      )}"];`
    );
  }

  for (const edge of graph.edges) {
    lines.push(
      `  "${escapeDotLabel(edge.from)}" -> "${escapeDotLabel(
        edge.to
      )}" [label="${escapeDotLabel(edge.label)}"];`
    );
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function toHtml(graph: Graph): string {
  // Single-file HTML (no external deps) to keep the submission self-contained.
  const data = JSON.stringify(graph);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Composio Tool Dependency Graph</title>
    <style>
      :root{
        --bg0:#070a12;
        --bg1:#0b1020;
        --panel:#0b1224cc;
        --border:#1f2a44;
        --text:#e5e7eb;
        --muted:#9ca3af;
        --accent:#60a5fa;
        --green:#34d399;
        --amber:#fbbf24;
        --shadow: 0 10px 30px rgba(0,0,0,.45);
      }
      html, body { height: 100%; margin: 0; background: radial-gradient(1200px 900px at 20% 0%, #111a33 0%, var(--bg0) 45%, #05060b 100%); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      #wrap { display: grid; grid-template-columns: 360px 1fr; height: 100%; }
      #side { border-right: 1px solid var(--border); padding: 14px; overflow: auto; background: linear-gradient(180deg, rgba(11,18,36,.75), rgba(7,10,18,.55)); }
      #main { position: relative; }
      canvas { width: 100%; height: 100%; display: block; background: linear-gradient(180deg, var(--bg1), var(--bg0)); }
      .title { font-size: 14px; font-weight: 650; letter-spacing: .2px; margin: 0 0 10px; display:flex; gap:10px; align-items:center; }
      .pill { display: inline-flex; align-items:center; gap:6px; padding: 4px 10px; border-radius: 999px; background: rgba(17,24,39,.6); border: 1px solid rgba(31,42,68,.9); color: var(--text); font-size: 12px; }
      .dot { width: 8px; height: 8px; border-radius: 999px; display:inline-block; }
      .hint { color: var(--muted); font-size: 12px; line-height: 1.45; }
      .k { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
      input { width: 100%; padding: 10px 10px; background: rgba(3,6,15,.35); color: var(--text); border: 1px solid rgba(31,42,68,.9); border-radius: 10px; outline:none; }
      input:focus { border-color: rgba(96,165,250,.9); box-shadow: 0 0 0 3px rgba(96,165,250,.18); }
      button { cursor:pointer; padding: 9px 10px; border-radius: 10px; border: 1px solid rgba(31,42,68,.9); background: rgba(17,24,39,.5); color: var(--text); }
      button:hover { border-color: rgba(96,165,250,.55); }
      .row { display:flex; gap:10px; }
      .row > * { flex: 1; }
      .card { margin-top: 12px; padding: 12px; border: 1px solid rgba(31,42,68,.9); border-radius: 12px; background: rgba(11,18,36,.55); box-shadow: var(--shadow); }
      #tooltip { position:absolute; pointer-events:none; display:none; max-width: 520px; padding: 10px 12px; background: rgba(6,10,20,.88); border: 1px solid rgba(31,42,68,.95); border-radius: 12px; box-shadow: var(--shadow); }
      #tooltip .h { font-weight: 650; font-size: 13px; margin:0 0 6px; }
      #tooltip .m { color: var(--muted); font-size: 12px; line-height: 1.35; }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="side">
        <div class="title">
          <span>Tool Dependency Graph</span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
          <span class="pill"><span class="dot" style="background:var(--green)"></span>GoogleSuper</span>
          <span class="pill"><span class="dot" style="background:var(--amber)"></span>GitHub</span>
        </div>
        <input id="q" placeholder="Filter tools (search name/toolkit)..." />
        <div class="row" style="margin-top:10px;">
          <button id="fit">Fit View</button>
          <button id="restart">Restart Layout</button>
        </div>
        <div class="card hint" style="margin-top:10px;">
          <label style="display:flex; gap:10px; align-items:center; cursor:pointer; user-select:none;">
            <input id="toggleEdges" type="checkbox" checked style="width:auto; margin:0;" />
            <span>Show edges</span>
          </label>
          <label style="display:flex; gap:10px; align-items:center; cursor:pointer; user-select:none; margin-top:8px;">
            <input id="toggleFocus" type="checkbox" style="width:auto; margin:0;" />
            <span>Focus mode (selected)</span>
          </label>
          <div style="margin-top:8px;">Tip: click a node to select. Focus mode shows only its neighborhood.</div>
        </div>
        <div class="card hint">
          <div><span class="k">Drag</span> to pan, <span class="k">Wheel</span> to zoom, <span class="k">Click</span> to pin.</div>
          <div style="margin-top:8px;">
            Edges are inferred from required parameters in raw tool schemas and simple naming/description heuristics.
          </div>
          <div style="margin-top:10px;" id="stats"></div>
        </div>
      </div>
      <div id="main">
        <canvas id="c"></canvas>
        <div id="tooltip">
          <div class="h" id="tt-h"></div>
          <div class="m" id="tt-m"></div>
        </div>
      </div>
    </div>
    <script>
      const graph = ${data};
      const canvas = document.getElementById("c");
      const ctx = canvas.getContext("2d");
      const q = document.getElementById("q");
      const stats = document.getElementById("stats");
      const btnFit = document.getElementById("fit");
      const btnRestart = document.getElementById("restart");
      const toggleEdges = document.getElementById("toggleEdges");
      const toggleFocus = document.getElementById("toggleFocus");
      const tooltip = document.getElementById("tooltip");
      const ttH = document.getElementById("tt-h");
      const ttM = document.getElementById("tt-m");

      function resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      window.addEventListener("resize", resize);
      resize();

      function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
      function lerp(a,b,t){ return a + (b-a)*t; }

      // IMPORTANT: Keep this visualization light. Avoid O(n^2) force layouts
      // (they can freeze machines when nodes ~ 1k). We use a deterministic
      // layered layout computed once, then only re-render on interaction.
      const nodes = graph.nodes.map((n, idx) => ({
        ...n,
        x: 0,
        y: 0,
        pinned: false,
        hidden: false,
        idx
      }));
      const edges = graph.edges.map((e) => ({...e}));

      const idToNode = new Map(nodes.map((n) => [n.id, n]));

      let scale = 1;
      let offsetX = 0;
      let offsetY = 0;
      let dragging = false;
      let dragStart = null;
      let hovered = null;
      let selected = null;
      let needsDraw = true;

      canvas.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const delta = Math.sign(ev.deltaY);
        const factor = delta > 0 ? 0.9 : 1.1;
        scale = Math.max(0.15, Math.min(3.5, scale * factor));
        needsDraw = true;
      }, {passive:false});

      canvas.addEventListener("mousedown", (ev) => {
        dragging = true;
        dragStart = {x: ev.clientX, y: ev.clientY, ox: offsetX, oy: offsetY};
      });
      window.addEventListener("mouseup", () => { dragging = false; dragStart = null; });
      window.addEventListener("mousemove", (ev) => {
        if (!dragging || !dragStart) return;
        offsetX = dragStart.ox + (ev.clientX - dragStart.x);
        offsetY = dragStart.oy + (ev.clientY - dragStart.y);
        needsDraw = true;
      });

      canvas.addEventListener("click", (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mx = (ev.clientX - rect.left - offsetX) / scale;
        const my = (ev.clientY - rect.top - offsetY) / scale;
        let hit = null;
        for (const n of nodes) {
          if (n.hidden) continue;
          const dx = n.x - mx;
          const dy = n.y - my;
          if (dx*dx + dy*dy < 11*11) { hit = n; break; }
        }
        if (hit) {
          selected = hit;
          // Keep the original "pin" behavior, but also make selection useful.
          hit.pinned = !hit.pinned;
        }
        needsDraw = true;
      });

      canvas.addEventListener("mousemove", (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mx = (ev.clientX - rect.left - offsetX) / scale;
        const my = (ev.clientY - rect.top - offsetY) / scale;
        let hit = null;
        for (const n of nodes) {
          if (n.hidden) continue;
          const dx = n.x - mx;
          const dy = n.y - my;
          if (dx*dx + dy*dy < 11*11) { hit = n; break; }
        }
        hovered = hit;
        if (hit) {
          tooltip.style.display = "block";
          tooltip.style.left = (ev.clientX + 14) + "px";
          tooltip.style.top = (ev.clientY + 14) + "px";
          ttH.textContent = hit.toolkit + ": " + hit.label;
          ttM.textContent = hit.pinned ? "Pinned (click to unpin)" : "Click to pin";
        } else {
          tooltip.style.display = "none";
        }
        needsDraw = true;
      });

      function applyFilter() {
        const s = (q.value || "").toLowerCase().trim();
        for (const n of nodes) {
          const hay = (n.toolkit + " " + n.label).toLowerCase();
          n.hidden = s ? !hay.includes(s) : false;
        }
        needsDraw = true;
      }
      q.addEventListener("input", applyFilter);
      applyFilter();
      toggleEdges.addEventListener("change", () => { needsDraw = true; });
      toggleFocus.addEventListener("change", () => { needsDraw = true; });

      function buildAdjacency() {
        const out = new Map();
        const incoming = new Map();
        for (const n of nodes) {
          out.set(n.id, []);
          incoming.set(n.id, []);
        }
        for (const e of edges) {
          if (!out.has(e.from) || !incoming.has(e.to)) continue;
          out.get(e.from).push(e.to);
          incoming.get(e.to).push(e.from);
        }
        return { out, incoming };
      }

      const { out: outAdj, incoming: inAdj } = buildAdjacency();

      function neighborhood(nodeId) {
        const set = new Set([nodeId]);
        const out = outAdj.get(nodeId) || [];
        const inn = inAdj.get(nodeId) || [];
        for (const x of out) set.add(x);
        for (const x of inn) set.add(x);
        return set;
      }

      function computeRanks() {
        // Kahn topo-ish ranking; cycles fall back to 0.
        const { out, incoming } = buildAdjacency();
        const indeg = new Map();
        for (const n of nodes) indeg.set(n.id, incoming.get(n.id).length);
        const q = [];
        for (const n of nodes) if (indeg.get(n.id) === 0) q.push(n.id);

        const rank = new Map();
        for (const n of nodes) rank.set(n.id, 0);

        while (q.length) {
          const id = q.shift();
          const r = rank.get(id) || 0;
          for (const to of out.get(id)) {
            rank.set(to, Math.max(rank.get(to) || 0, r + 1));
            indeg.set(to, (indeg.get(to) || 0) - 1);
            if (indeg.get(to) === 0) q.push(to);
          }
        }
        return rank;
      }

      function restartLayout() {
        const rank = computeRanks();
        const rect = canvas.getBoundingClientRect();
        const baseY = rect.height * 0.5;

        const groups = new Map();
        for (const n of nodes) {
          const key = n.toolkit.includes("github") ? "github" : "googlesuper";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(n);
        }

        const colW = 170;
        const rowH = 20;
        const leftPad = 120;
        const topPad = 80;
        const rankCap = 10; // keeps the layout from becoming infinitely wide

        const groupOrder = ["googlesuper", "github"];
        // Compute a consistent width per group so github doesn't get pushed far away.
        const cappedRanks = [];
        for (const n of nodes) cappedRanks.push(Math.min(rank.get(n.id) || 0, rankCap));
        const globalMaxRank = Math.min(rankCap, Math.max(0, ...cappedRanks));
        const groupWidth = (globalMaxRank + 1) * colW + 60;

        for (let gi = 0; gi < groupOrder.length; gi++) {
          const key = groupOrder[gi];
          const groupNodes = (groups.get(key) || []).slice();
          // stable ordering: by rank then degree-ish
          const degree = new Map();
          for (const n of groupNodes) degree.set(n.id, 0);
          for (const e of edges) {
            if (degree.has(e.from)) degree.set(e.from, degree.get(e.from) + 1);
            if (degree.has(e.to)) degree.set(e.to, degree.get(e.to) + 1);
          }
          groupNodes.sort((a, b) => {
            const ra = Math.min(rank.get(a.id) || 0, rankCap);
            const rb = Math.min(rank.get(b.id) || 0, rankCap);
            if (ra !== rb) return ra - rb;
            const da = degree.get(a.id) || 0;
            const db = degree.get(b.id) || 0;
            if (da !== db) return db - da;
            return a.id.localeCompare(b.id);
          });

          // bucket by rank => columns
          const cols = new Map();
          for (const n of groupNodes) {
            const r = Math.min(rank.get(n.id) || 0, rankCap);
            if (!cols.has(r)) cols.set(r, []);
            cols.get(r).push(n);
          }
          const maxRank = Math.min(rankCap, Math.max(0, ...Array.from(cols.keys())));

          const groupX0 = leftPad + gi * groupWidth;
          // place each column with centered y distribution
          for (let r = 0; r <= maxRank; r++) {
            const col = cols.get(r) || [];
            const startY = topPad + Math.max(0, (rect.height - topPad*2 - col.length * rowH) / 2);
            for (let i = 0; i < col.length; i++) {
              const n = col[i];
              if (n.pinned) continue;
              n.x = groupX0 + r * colW;
              n.y = startY + i * rowH;
            }
          }

          // any nodes that ended up beyond maxRank (cycles) already at rank 0
        }

        // slight wiggle to reduce perfect overlaps between groups
        for (const n of nodes) {
          if (n.pinned) continue;
          n.x += (Math.random() - 0.5) * 6;
          n.y += (Math.random() - 0.5) * 6;
        }

        needsDraw = true;
      }

      function fitView() {
        const visible = nodes.filter(n => !n.hidden);
        if (visible.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of visible) {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x);
          maxY = Math.max(maxY, n.y);
        }
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(10, maxX - minX);
        const h = Math.max(10, maxY - minY);
        const s = clamp(Math.min((rect.width - 80) / w, (rect.height - 80) / h), 0.18, 2.2);
        scale = s;
        offsetX = rect.width/2 - ((minX + maxX)/2) * scale;
        offsetY = rect.height/2 - ((minY + maxY)/2) * scale;
        needsDraw = true;
      }

      btnRestart.addEventListener("click", () => { restartLayout(); });
      btnFit.addEventListener("click", () => { fitView(); });

      function draw() {
        const rect = canvas.getBoundingClientRect();
        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);

        const showEdges = !!toggleEdges.checked;
        const focus = !!toggleFocus.checked;
        const focusSet = (focus && selected) ? neighborhood(selected.id) : null;

        // edges
        if (showEdges) {
          ctx.globalAlpha = 0.22;
          ctx.strokeStyle = "rgba(147,197,253,0.9)";
          ctx.lineWidth = 1;
          for (const e of edges) {
            if (focusSet && (!focusSet.has(e.from) || !focusSet.has(e.to))) continue;
            const a = idToNode.get(e.from);
            const b = idToNode.get(e.to);
            if (!a || !b || a.hidden || b.hidden) continue;
            ctx.beginPath();
            // slight curve for aesthetics
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const nx = (b.y - a.y) * 0.06;
            const ny = (a.x - b.x) * 0.06;
            ctx.moveTo(a.x, a.y);
            ctx.quadraticCurveTo(mx + nx, my + ny, b.x, b.y);
            ctx.stroke();
          }
        }

        // nodes
        ctx.globalAlpha = 1;
        for (const n of nodes) {
          if (n.hidden) continue;
          if (focusSet && !focusSet.has(n.id)) continue;
          const isGitHub = n.toolkit.includes("github");
          ctx.fillStyle = isGitHub ? "#fbbf24" : "#34d399";
          ctx.beginPath();
          const isHover = hovered && hovered.id === n.id;
          const isSel = selected && selected.id === n.id;
          const r = isHover ? 8 : isSel ? 7.4 : 6.3;
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.fill();
          if (n.pinned) {
            ctx.strokeStyle = "rgba(229,231,235,0.95)";
            ctx.lineWidth = 2.4;
            ctx.stroke();
          }
          if (isSel) {
            ctx.strokeStyle = "rgba(96,165,250,0.95)";
            ctx.lineWidth = 2.2;
            ctx.stroke();
          }
        }

        // hovered label
        if (hovered && !hovered.hidden) {
          if (!focusSet || focusSet.has(hovered.id)) {
          ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
          ctx.fillStyle = "rgba(229,231,235,0.95)";
          ctx.strokeStyle = "rgba(2,6,23,0.9)";
          ctx.lineWidth = 4;
          const text = hovered.toolkit + ": " + hovered.label;
          const tx = hovered.x + 10;
          const ty = hovered.y - 10;
          ctx.strokeText(text, tx, ty);
          ctx.fillText(text, tx, ty);
          }
        }

        ctx.restore();
      }

      function loop() {
        if (needsDraw) {
          draw();
          const visibleNodes = nodes.filter(n => !n.hidden).length;
          stats.textContent = \`Nodes: \${nodes.length} (visible \${visibleNodes}), Edges: \${edges.length}\`;
          needsDraw = false;
        }
        requestAnimationFrame(loop);
      }

      // initial layout and fit
      restartLayout();
      fitView();
      loop();
    </script>
  </body>
</html>`;
}

function toExplorerHtml(graph: Graph): string {
  const data = JSON.stringify(graph);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Composio Tool Dependency Graph</title>
    <style>
      :root {
        --canvas: #f6f7f9;
        --panel: #ffffff;
        --ink: #171a1f;
        --muted: #626a73;
        --line: #d9dee7;
        --soft: #eef1f5;
        --green: #16a37b;
        --amber: #c9890b;
        --blue: #3578e5;
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; overflow: hidden; background: var(--canvas); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      #wrap { display: grid; grid-template-columns: 420px minmax(0, 1fr); height: 100vh; max-height: 100vh; overflow: hidden; }
      #side { min-width: 0; min-height: 0; background: var(--panel); border-right: 1px solid var(--line); display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; height: 100vh; max-height: 100vh; overflow: hidden; }
      .section { padding: 18px 20px; border-bottom: 1px solid var(--line); }
      .title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      h1 { margin: 0; font-size: 18px; line-height: 1.2; font-weight: 740; letter-spacing: 0; }
      .badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
      .badge { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 999px; background: #fbfcfd; color: #343a42; font-size: 12px; }
      .dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }
      .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
      .metric { border: 1px solid var(--line); background: #fbfcfd; border-radius: 8px; padding: 10px; }
      .metric b { display: block; font-size: 18px; line-height: 1; margin-bottom: 5px; }
      .metric span { color: var(--muted); font-size: 11px; }
      label { display: block; color: #343a42; font-size: 12px; font-weight: 650; margin-bottom: 6px; }
      input, select { width: 100%; height: 38px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); padding: 0 10px; outline: none; font: inherit; }
      input:focus, select:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(53,120,229,.14); }
      input[type="range"] { padding: 0; height: 24px; }
      button { height: 38px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); cursor: pointer; font-weight: 650; }
      button:hover { border-color: #aeb8c7; background: #fbfcfd; }
      .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      #toolList { min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 8px; overscroll-behavior: contain; }
      .toolRow { width: 100%; height: auto; text-align: left; display: grid; grid-template-columns: 10px minmax(0,1fr) auto; gap: 10px; align-items: center; padding: 9px 10px; border: 0; border-radius: 8px; background: transparent; font-weight: 520; }
      .toolRow:hover, .toolRow.active { background: var(--soft); }
      .toolName { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .degree { color: var(--muted); font-size: 12px; }
      #selected { padding: 14px 20px; border-top: 1px solid var(--line); background: #fbfcfd; }
      #selectedTitle { font-weight: 740; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #selectedMeta { margin-top: 5px; color: var(--muted); font-size: 12px; }
      #main { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
      canvas { width: 100%; height: 100%; display: block; background: var(--canvas); }
      #tooltip { position:absolute; pointer-events:none; display:none; max-width: 520px; padding: 9px 11px; background: rgba(255,255,255,.96); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 12px 32px rgba(21,30,43,.18); }
      #tooltip .h { font-weight: 740; font-size: 13px; margin: 0 0 4px; }
      #tooltip .m { color: var(--muted); font-size: 12px; line-height: 1.35; }
      #modeHint { position: absolute; right: 18px; top: 16px; height: 30px; display: inline-flex; align-items: center; padding: 0 10px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,.86); color: var(--muted); font-size: 12px; }
    </style>
  </head>
  <body>
    <div id="wrap">
      <aside id="side">
        <div class="section">
          <div class="title">
            <h1>Tool Dependency Graph</h1>
            <span class="badge">Composio</span>
          </div>
          <div class="badges">
            <span class="badge"><span class="dot" style="background:var(--green)"></span>GoogleSuper</span>
            <span class="badge"><span class="dot" style="background:var(--amber)"></span>GitHub</span>
          </div>
          <div class="metrics">
            <div class="metric"><b id="nodeCount">0</b><span>nodes</span></div>
            <div class="metric"><b id="edgeCount">0</b><span>edges</span></div>
            <div class="metric"><b id="visibleCount">0</b><span>visible</span></div>
          </div>
        </div>
        <div class="section">
          <label for="q">Search tools</label>
          <input id="q" placeholder="gmail thread, issue, repo..." />
        </div>
        <div class="section controls">
          <div>
            <label for="edgeMode">Edge mode</label>
            <select id="edgeMode">
              <option value="focused">Neighborhood</option>
              <option value="filtered">Filtered</option>
              <option value="all">All</option>
              <option value="none">None</option>
            </select>
          </div>
          <div>
            <label for="scoreMin">Min score <span id="scoreLabel">6</span></label>
            <input id="scoreMin" type="range" min="0" max="90" value="6" />
          </div>
          <button id="fit">Fit view</button>
          <button id="restart">Reset layout</button>
        </div>
        <div id="toolList"></div>
        <div id="selected">
          <div id="selectedTitle">No tool selected</div>
          <div id="selectedMeta"></div>
        </div>
      </aside>
      <main id="main">
        <canvas id="c"></canvas>
        <div id="modeHint">Neighborhood view</div>
        <div id="tooltip">
          <div class="h" id="tt-h"></div>
          <div class="m" id="tt-m"></div>
        </div>
      </main>
    </div>
    <script>
      const graph = ${data};
      const canvas = document.getElementById("c");
      const ctx = canvas.getContext("2d");
      const q = document.getElementById("q");
      const nodeCount = document.getElementById("nodeCount");
      const edgeCount = document.getElementById("edgeCount");
      const visibleCount = document.getElementById("visibleCount");
      const btnFit = document.getElementById("fit");
      const btnRestart = document.getElementById("restart");
      const edgeMode = document.getElementById("edgeMode");
      const scoreMin = document.getElementById("scoreMin");
      const scoreLabel = document.getElementById("scoreLabel");
      const toolList = document.getElementById("toolList");
      const selectedTitle = document.getElementById("selectedTitle");
      const selectedMeta = document.getElementById("selectedMeta");
      const modeHint = document.getElementById("modeHint");
      const tooltip = document.getElementById("tooltip");
      const ttH = document.getElementById("tt-h");
      const ttM = document.getElementById("tt-m");

      function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
      function norm(s) { return String(s || "").toLowerCase(); }

      function resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        needsDraw = true;
      }

      const nodes = graph.nodes.map((n, idx) => ({ ...n, x: 0, y: 0, hidden: false, idx }));
      const edges = graph.edges.map((e) => ({ ...e }));
      const idToNode = new Map(nodes.map((n) => [n.id, n]));
      const degree = new Map(nodes.map((n) => [n.id, 0]));
      const outAdj = new Map(nodes.map((n) => [n.id, []]));
      const inAdj = new Map(nodes.map((n) => [n.id, []]));

      for (const e of edges) {
        degree.set(e.from, (degree.get(e.from) || 0) + 1);
        degree.set(e.to, (degree.get(e.to) || 0) + 1);
        if (outAdj.has(e.from)) outAdj.get(e.from).push(e.to);
        if (inAdj.has(e.to)) inAdj.get(e.to).push(e.from);
      }

      const rankedNodes = nodes.slice().sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
      let selected = rankedNodes[0] || null;
      let hovered = null;
      let scale = 1;
      let offsetX = 0;
      let offsetY = 0;
      let dragging = false;
      let dragStart = null;
      let needsDraw = true;
      const maxFocusedSide = 28;

      function neighborhood(nodeId) {
        const set = new Set([nodeId]);
        for (const x of outAdj.get(nodeId) || []) set.add(x);
        for (const x of inAdj.get(nodeId) || []) set.add(x);
        return set;
      }

      function edgeRank(edge, otherId) {
        return Number(edge.score || 0) * 1000 + (degree.get(otherId) || 0);
      }

      function focusedEdgeGroups() {
        if (!selected) return { incoming: [], outgoing: [], incomingTotal: 0, outgoingTotal: 0 };
        const minScore = Number(scoreMin.value || 0);
        const incoming = [];
        const outgoing = [];
        for (const edge of edges) {
          if (Number(edge.score || 0) < minScore) continue;
          if (edge.to === selected.id) incoming.push(edge);
          if (edge.from === selected.id) outgoing.push(edge);
        }
        incoming.sort((a, b) => edgeRank(b, b.from) - edgeRank(a, a.from));
        outgoing.sort((a, b) => edgeRank(b, b.to) - edgeRank(a, a.to));
        return {
          incoming: incoming.slice(0, maxFocusedSide),
          outgoing: outgoing.slice(0, maxFocusedSide),
          incomingTotal: incoming.length,
          outgoingTotal: outgoing.length,
        };
      }

      function focusedEdgeKeySet(groups = focusedEdgeGroups()) {
        const keys = new Set();
        for (const edge of groups.incoming) keys.add(edge.from + "\\u0000" + edge.to + "\\u0000" + edge.label);
        for (const edge of groups.outgoing) keys.add(edge.from + "\\u0000" + edge.to + "\\u0000" + edge.label);
        return keys;
      }

      function computeRanks() {
        const indeg = new Map(nodes.map((n) => [n.id, (inAdj.get(n.id) || []).length]));
        const queue = [];
        const rank = new Map(nodes.map((n) => [n.id, 0]));
        for (const n of nodes) if (indeg.get(n.id) === 0) queue.push(n.id);
        while (queue.length) {
          const id = queue.shift();
          const r = rank.get(id) || 0;
          for (const to of outAdj.get(id) || []) {
            rank.set(to, Math.max(rank.get(to) || 0, r + 1));
            indeg.set(to, (indeg.get(to) || 0) - 1);
            if (indeg.get(to) === 0) queue.push(to);
          }
        }
        return rank;
      }

      function applyFilter() {
        const query = norm(q.value).trim();
        for (const n of nodes) {
          const haystack = norm(n.toolkit + " " + n.label + " " + n.id);
          n.hidden = query ? !haystack.includes(query) : false;
        }
        renderToolList();
        needsDraw = true;
      }

      function selectNode(node) {
        selected = node;
        updateSelectedPanel();
        renderToolList();
        needsDraw = true;
      }

      function updateSelectedPanel() {
        if (!selected) return;
        const incoming = (inAdj.get(selected.id) || []).length;
        const outgoing = (outAdj.get(selected.id) || []).length;
        selectedTitle.textContent = selected.label;
        const suffix = edgeMode.value === "focused" ? " | showing top " + maxFocusedSide + " each side" : "";
        selectedMeta.textContent = selected.toolkit + " | incoming " + incoming + " | outgoing " + outgoing + " | degree " + (degree.get(selected.id) || 0) + suffix;
      }

      function renderToolList() {
        const query = norm(q.value).trim();
        const items = rankedNodes
          .filter((n) => !query || norm(n.toolkit + " " + n.label + " " + n.id).includes(query))
          .slice(0, 120);
        toolList.innerHTML = "";
        for (const n of items) {
          const row = document.createElement("button");
          row.className = "toolRow" + (selected && selected.id === n.id ? " active" : "");
          row.type = "button";
          const color = n.toolkit.includes("github") ? "var(--amber)" : "var(--green)";
          row.innerHTML = '<span class="dot" style="background:' + color + '"></span><span class="toolName"></span><span class="degree"></span>';
          row.querySelector(".toolName").textContent = n.label;
          row.querySelector(".degree").textContent = String(degree.get(n.id) || 0);
          row.addEventListener("click", () => selectNode(n));
          toolList.appendChild(row);
        }
      }

      function restartLayout() {
        const rank = computeRanks();
        const groups = new Map();
        for (const n of nodes) {
          const key = n.toolkit.includes("github") ? "github" : "googlesuper";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(n);
        }

        const groupOrder = ["googlesuper", "github"];
        const rankCap = 8;
        const rowsPerColumn = 42;
        const colW = 145;
        const rowH = 18;
        const groupWidth = (rankCap + 1) * colW + 520;
        const leftPad = 90;
        const topPad = 95;

        for (let gi = 0; gi < groupOrder.length; gi++) {
          const key = groupOrder[gi];
          const groupNodes = (groups.get(key) || []).slice();
          groupNodes.sort((a, b) => {
            const ra = Math.min(rank.get(a.id) || 0, rankCap);
            const rb = Math.min(rank.get(b.id) || 0, rankCap);
            if (ra !== rb) return ra - rb;
            const da = degree.get(a.id) || 0;
            const db = degree.get(b.id) || 0;
            if (da !== db) return db - da;
            return a.id.localeCompare(b.id);
          });

          const cols = new Map();
          for (const n of groupNodes) {
            const r = Math.min(rank.get(n.id) || 0, rankCap);
            if (!cols.has(r)) cols.set(r, []);
            cols.get(r).push(n);
          }

          const groupX0 = leftPad + gi * groupWidth;
          for (let r = 0; r <= rankCap; r++) {
            const col = cols.get(r) || [];
            for (let i = 0; i < col.length; i++) {
              const wrap = Math.floor(i / rowsPerColumn);
              const row = i % rowsPerColumn;
              col[i].x = groupX0 + r * colW + wrap * 34;
              col[i].y = topPad + row * rowH;
            }
          }
        }
        needsDraw = true;
      }

      function currentNodeSet() {
        let set = new Set(nodes.filter((n) => !n.hidden).map((n) => n.id));
        const query = norm(q.value).trim();
        if (edgeMode.value === "focused" && selected) {
          const groups = focusedEdgeGroups();
          const focus = new Set([selected.id]);
          for (const edge of groups.incoming) focus.add(edge.from);
          for (const edge of groups.outgoing) focus.add(edge.to);
          set = new Set([...set].filter((id) => focus.has(id)));
        }
        if (edgeMode.value === "filtered" && !query) {
          set = new Set(rankedNodes.slice(0, 90).map((n) => n.id));
        }
        return set;
      }

      function edgeIsVisible(e, set) {
        if (Number(e.score || 0) < Number(scoreMin.value || 0)) return false;
        if (edgeMode.value === "none") return false;
        if (edgeMode.value === "focused") {
          const keys = focusedEdgeKeySet();
          return keys.has(e.from + "\\u0000" + e.to + "\\u0000" + e.label);
        }
        return set.has(e.from) && set.has(e.to);
      }

      function fitView() {
        if (edgeMode.value === "focused") {
          scale = 1;
          offsetX = 0;
          offsetY = 0;
          needsDraw = true;
          return;
        }
        const set = currentNodeSet();
        const visible = nodes.filter((n) => set.has(n.id));
        if (!visible.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of visible) {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x);
          maxY = Math.max(maxY, n.y);
        }
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(10, maxX - minX);
        const h = Math.max(10, maxY - minY);
        scale = clamp(Math.min((rect.width - 120) / w, (rect.height - 120) / h), 0.18, 2.4);
        offsetX = rect.width / 2 - ((minX + maxX) / 2) * scale;
        offsetY = rect.height / 2 - ((minY + maxY) / 2) * scale;
        needsDraw = true;
      }

      function drawBackground(rect) {
        ctx.fillStyle = "#f6f7f9";
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.strokeStyle = "rgba(82,95,114,.10)";
        ctx.lineWidth = 1;
        for (let x = 0; x < rect.width; x += 32) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, rect.height);
          ctx.stroke();
        }
        for (let y = 0; y < rect.height; y += 32) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(rect.width, y);
          ctx.stroke();
        }
      }

      function ellipsize(text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let out = text;
        while (out.length > 4 && ctx.measureText(out + "...").width > maxWidth) {
          out = out.slice(0, -1);
        }
        return out + "...";
      }

      function drawToolCard(node, x, y, width, selectedCard = false) {
        const height = selectedCard ? 54 : 38;
        const isGitHub = node.toolkit.includes("github");
        const color = isGitHub ? "#d99414" : "#159c75";
        node.x = x;
        node.y = y;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = selectedCard ? "#171a1f" : "#cfd6e1";
        ctx.lineWidth = selectedCard ? 1.8 : 1;
        ctx.beginPath();
        ctx.roundRect(x - width / 2, y - height / 2, width, height, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x - width / 2 + 10, y - 5, 10, 10, 3);
        ctx.fill();

        ctx.fillStyle = "#171a1f";
        ctx.font = selectedCard ? "700 13px ui-sans-serif, system-ui" : "600 12px ui-sans-serif, system-ui";
        ctx.fillText(ellipsize(node.label, width - 42), x - width / 2 + 28, y - (selectedCard ? 7 : -4));
        if (selectedCard) {
          ctx.fillStyle = "#626a73";
          ctx.font = "12px ui-sans-serif, system-ui";
          ctx.fillText(node.toolkit + " | degree " + (degree.get(node.id) || 0), x - width / 2 + 28, y + 14);
        }
      }

      function drawEdgeLabel(text, x, y) {
        ctx.font = "11px ui-sans-serif, system-ui";
        const label = ellipsize(text, 120);
        const width = ctx.measureText(label).width + 12;
        ctx.fillStyle = "rgba(255,255,255,.9)";
        ctx.strokeStyle = "rgba(207,214,225,.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x - width / 2, y - 10, width, 20, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#626a73";
        ctx.fillText(label, x - width / 2 + 6, y + 4);
      }

      function drawFocusedView(rect) {
        const groups = focusedEdgeGroups();
        const set = currentNodeSet();
        const centerX = rect.width * 0.5;
        const centerY = rect.height * 0.5;
        const cardW = Math.min(260, Math.max(190, rect.width * 0.2));
        const sideW = Math.min(280, Math.max(210, rect.width * 0.22));
        const leftX = Math.max(sideW / 2 + 36, centerX - Math.min(420, rect.width * 0.28));
        const rightX = Math.min(rect.width - sideW / 2 - 36, centerX + Math.min(420, rect.width * 0.28));
        const top = 96;
        const bottom = rect.height - 72;

        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#d9dee7";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(28, 54, rect.width - 56, rect.height - 92, 12);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#626a73";
        ctx.font = "700 12px ui-sans-serif, system-ui";
        ctx.fillText("PROVIDES REQUIRED INPUTS", leftX - sideW / 2, 82);
        ctx.fillText("SELECTED TOOL", centerX - cardW / 2, 82);
        ctx.fillText("UNLOCKS DOWNSTREAM TOOLS", rightX - sideW / 2, 82);

        drawToolCard(selected, centerX, centerY, cardW, true);

        const placeSide = (edgesForSide, side) => {
          const count = edgesForSide.length;
          const gap = count <= 1 ? 0 : Math.min(48, (bottom - top) / (count - 1));
          const startY = count <= 1 ? centerY : centerY - gap * (count - 1) / 2;
          for (let i = 0; i < count; i++) {
            const edge = edgesForSide[i];
            const node = idToNode.get(side === "left" ? edge.from : edge.to);
            if (!node || node.hidden || !set.has(node.id)) continue;
            const x = side === "left" ? leftX : rightX;
            const y = clamp(startY + i * gap, top, bottom);
            drawToolCard(node, x, y, sideW, false);

            ctx.strokeStyle = "rgba(53,120,229,.42)";
            ctx.lineWidth = Math.max(1.1, Math.min(2.4, Number(edge.score || 0) / 35));
            ctx.beginPath();
            if (side === "left") {
              ctx.moveTo(x + sideW / 2, y);
              ctx.bezierCurveTo(x + sideW / 2 + 120, y, centerX - cardW / 2 - 120, centerY, centerX - cardW / 2, centerY);
              ctx.stroke();
              if (i < 10) drawEdgeLabel(edge.label, (x + centerX) / 2, (y + centerY) / 2 - 8);
            } else {
              ctx.moveTo(centerX + cardW / 2, centerY);
              ctx.bezierCurveTo(centerX + cardW / 2 + 120, centerY, x - sideW / 2 - 120, y, x - sideW / 2, y);
              ctx.stroke();
              if (i < 10) drawEdgeLabel(edge.label, (x + centerX) / 2, (y + centerY) / 2 - 8);
            }
          }
        };

        placeSide(groups.incoming, "left");
        placeSide(groups.outgoing, "right");

        ctx.fillStyle = "#626a73";
        ctx.font = "12px ui-sans-serif, system-ui";
        if (groups.incomingTotal > groups.incoming.length) {
          ctx.fillText("+" + (groups.incomingTotal - groups.incoming.length) + " more providers hidden by cap", leftX - sideW / 2, rect.height - 34);
        }
        if (groups.outgoingTotal > groups.outgoing.length) {
          ctx.fillText("+" + (groups.outgoingTotal - groups.outgoing.length) + " more downstream tools hidden by cap", rightX - sideW / 2, rect.height - 34);
        }

        nodeCount.textContent = String(nodes.length);
        edgeCount.textContent = String(edges.length);
        visibleCount.textContent = String(set.size);
        selectedMeta.textContent = selected.toolkit + " | incoming " + groups.incomingTotal + " | outgoing " + groups.outgoingTotal + " | visible " + (groups.incoming.length + groups.outgoing.length);
      }

      function draw() {
        const rect = canvas.getBoundingClientRect();
        ctx.clearRect(0, 0, rect.width, rect.height);
        drawBackground(rect);
        modeHint.textContent = edgeMode.value === "focused" ? "Neighborhood view" : "Global map";
        if (edgeMode.value === "focused" && selected) {
          drawFocusedView(rect);
          return;
        }
        const set = currentNodeSet();

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);

        ctx.fillStyle = "rgba(255,255,255,.78)";
        ctx.strokeStyle = "rgba(190,198,210,.9)";
        ctx.lineWidth = 1;
        ctx.fillRect(60, 42, 1780, 850);
        ctx.strokeRect(60, 42, 1780, 850);
        ctx.fillRect(1915, 42, 1780, 850);
        ctx.strokeRect(1915, 42, 1780, 850);
        ctx.font = "700 18px ui-sans-serif, system-ui";
        ctx.fillStyle = "#171a1f";
        ctx.fillText("GoogleSuper", 90, 75);
        ctx.fillText("GitHub", 1945, 75);

        let visibleEdges = 0;
        ctx.strokeStyle = "rgba(53,120,229,.34)";
        ctx.lineWidth = 1.15;
        for (const e of edges) {
          if (!edgeIsVisible(e, set)) continue;
          const a = idToNode.get(e.from);
          const b = idToNode.get(e.to);
          if (!a || !b || !set.has(a.id) || !set.has(b.id)) continue;
          visibleEdges++;
          ctx.beginPath();
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const bend = a.toolkit === b.toolkit ? 28 : 80;
          const nx = (b.y - a.y) > 0 ? bend : -bend;
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(mx + nx, my, b.x, b.y);
          ctx.stroke();
        }

        for (const n of nodes) {
          if (n.hidden || !set.has(n.id)) continue;
          const isGitHub = n.toolkit.includes("github");
          const isHover = hovered && hovered.id === n.id;
          const isSel = selected && selected.id === n.id;
          const r = isHover ? 7.4 : isSel ? 7 : 4.8;
          ctx.fillStyle = isGitHub ? "#f5b82e" : "#21b98f";
          ctx.beginPath();
          ctx.roundRect(n.x - r, n.y - r, r * 2, r * 2, 3);
          ctx.fill();
          if (isSel) {
            ctx.strokeStyle = "#171a1f";
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }

        const labelNode = hovered || selected;
        if (labelNode && !labelNode.hidden && set.has(labelNode.id)) {
          ctx.font = "12px ui-sans-serif, system-ui";
          const text = labelNode.label;
          const tx = labelNode.x + 12;
          const ty = labelNode.y - 10;
          const w = ctx.measureText(text).width + 14;
          ctx.fillStyle = "rgba(255,255,255,.96)";
          ctx.strokeStyle = "rgba(190,198,210,.9)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(tx - 7, ty - 16, w, 23, 6);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#171a1f";
          ctx.fillText(text, tx, ty);
        }

        ctx.restore();
        nodeCount.textContent = String(nodes.length);
        edgeCount.textContent = String(edges.length);
        visibleCount.textContent = String(set.size);
        if (selected) {
          const incoming = (inAdj.get(selected.id) || []).length;
          const outgoing = (outAdj.get(selected.id) || []).length;
          selectedMeta.textContent = selected.toolkit + " | incoming " + incoming + " | outgoing " + outgoing + " | visible edges " + visibleEdges;
        }
      }

      canvas.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        if (edgeMode.value === "focused") return;
        const factor = Math.sign(ev.deltaY) > 0 ? 0.9 : 1.1;
        scale = clamp(scale * factor, 0.15, 3.5);
        needsDraw = true;
      }, { passive: false });

      canvas.addEventListener("mousedown", (ev) => {
        if (edgeMode.value === "focused") return;
        dragging = true;
        dragStart = { x: ev.clientX, y: ev.clientY, ox: offsetX, oy: offsetY };
      });

      window.addEventListener("mouseup", () => { dragging = false; dragStart = null; });
      window.addEventListener("mousemove", (ev) => {
        if (!dragging || !dragStart) return;
        offsetX = dragStart.ox + (ev.clientX - dragStart.x);
        offsetY = dragStart.oy + (ev.clientY - dragStart.y);
        needsDraw = true;
      });

      canvas.addEventListener("click", (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mx = edgeMode.value === "focused" ? ev.clientX - rect.left : (ev.clientX - rect.left - offsetX) / scale;
        const my = edgeMode.value === "focused" ? ev.clientY - rect.top : (ev.clientY - rect.top - offsetY) / scale;
        const set = currentNodeSet();
        let hit = null;
        for (const n of nodes) {
          if (n.hidden || !set.has(n.id)) continue;
          const dx = n.x - mx;
          const dy = n.y - my;
          if (dx * dx + dy * dy < 100) { hit = n; break; }
        }
        if (hit) selectNode(hit);
      });

      canvas.addEventListener("mousemove", (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mx = edgeMode.value === "focused" ? ev.clientX - rect.left : (ev.clientX - rect.left - offsetX) / scale;
        const my = edgeMode.value === "focused" ? ev.clientY - rect.top : (ev.clientY - rect.top - offsetY) / scale;
        const set = currentNodeSet();
        let hit = null;
        for (const n of nodes) {
          if (n.hidden || !set.has(n.id)) continue;
          const dx = n.x - mx;
          const dy = n.y - my;
          if (dx * dx + dy * dy < 100) { hit = n; break; }
        }
        hovered = hit;
        if (hit) {
          tooltip.style.display = "block";
          tooltip.style.left = (ev.clientX + 14) + "px";
          tooltip.style.top = (ev.clientY + 14) + "px";
          ttH.textContent = hit.toolkit + ": " + hit.label;
          ttM.textContent = "degree " + (degree.get(hit.id) || 0);
        } else {
          tooltip.style.display = "none";
        }
        needsDraw = true;
      });

      q.addEventListener("input", applyFilter);
      edgeMode.addEventListener("change", () => { updateSelectedPanel(); fitView(); needsDraw = true; });
      scoreMin.addEventListener("input", () => { scoreLabel.textContent = scoreMin.value; needsDraw = true; });
      btnRestart.addEventListener("click", () => { restartLayout(); fitView(); });
      btnFit.addEventListener("click", fitView);
      window.addEventListener("resize", resize);

      function loop() {
        if (needsDraw) {
          draw();
          needsDraw = false;
        }
        requestAnimationFrame(loop);
      }

      restartLayout();
      resize();
      updateSelectedPanel();
      renderToolList();
      applyFilter();
      fitView();
      loop();
    </script>
  </body>
</html>`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const startedAt = nowMs();
  const profile = hasFlag("--profile");
  const toolkits = ["googlesuper", "github"] as const;
  const allTools: Array<{ toolkit: string; tool: ToolLike }> = [];

  const phaseTimes: Record<string, number> = {};
  const mark = (label: string) => {
    if (!profile) return;
    phaseTimes[label] = nowMs();
  };
  const since = (label: string) => {
    if (!profile) return 0;
    const t = phaseTimes[label] ?? startedAt;
    return nowMs() - t;
  };

  mark("start");

  for (const toolkit of toolkits) {
    const file = `${toolkit}_tools.json`;
    console.log(`[build-graph] reading ${file}...`);
    const tools = await readToolsFile(file);
    for (const tool of tools) {
      allTools.push({ toolkit, tool });
    }
  }

  console.log(`[build-graph] loaded tools=${allTools.length}`);
  mark("loaded_tools");

  const nodes: GraphNode[] = allTools.map(({ toolkit, tool }) => {
    const name = getToolName(tool);
    return {
      id: toNodeId(guessToolkit(tool, toolkit), name),
      label: toLabel(getToolLabel(tool)),
      toolkit: guessToolkit(tool, toolkit),
    };
  });

  const toolByNodeId = new Map<string, ToolLike>();
  for (const { toolkit, tool } of allTools) {
    const id = toNodeId(guessToolkit(tool, toolkit), getToolName(tool));
    toolByNodeId.set(id, tool);
  }

  // --- Build provider indexes so edge inference is not O(n^2) ---
  console.log("[build-graph] building provider token index...");
  mark("index_start");
  const tokenToProviders = new Map<string, string[]>();
  const providerMeta = new Map<
    string,
    {
      tool: ToolLike;
      slugUpper: string;
      nameNorm: string;
      descNorm: string;
      tokens: Set<string>;
      isFetcher: boolean;
    }
  >();

  const fetcherProviderIds: string[] = [];

  for (const node of nodes) {
    const tool = toolByNodeId.get(node.id);
    if (!tool) continue;
    const slugUpper = getToolName(tool).toUpperCase();
    const descLower = getToolDescription(tool).toLowerCase();
    const nameNorm = normalizeToken(getToolName(tool));
    const descNorm = normalizeToken(getToolDescription(tool));
    const isFetcher =
      /(LIST|SEARCH|FIND|GET|RETRIEVE)/.test(slugUpper) ||
      descLower.includes("list") ||
      descLower.includes("search") ||
      descLower.includes("get ");
    const tokens = toolProvidesTokens(tool);
    providerMeta.set(node.id, { tool, slugUpper, nameNorm, descNorm, tokens, isFetcher });
    if (isFetcher) fetcherProviderIds.push(node.id);

    for (const t of tokens) {
      const arr = tokenToProviders.get(t);
      if (arr) arr.push(node.id);
      else tokenToProviders.set(t, [node.id]);
    }
  }

  console.log(
    `[build-graph] token index: tokens=${tokenToProviders.size}, fetchers=${fetcherProviderIds.length}`
  );
  mark("index_done");

  const edges: GraphEdge[] = [];
  const maxEdgesPerParam = 2;
  const minScore = 6;

  console.log("[build-graph] inferring edges...");
  mark("infer_start");
  let processedConsumers = 0;
  let totalRequiredParams = 0;
  const progressEvery = 50;
  let totalCandidatesConsidered = 0;
  let maxCandidatesForAnyParam = 0;
  let candidateCacheHits = 0;
  let candidateCacheMisses = 0;
  let scoreCacheHits = 0;
  let scoreCacheMisses = 0;
  const baseCandidateCache = new Map<string, string[]>();
  const staticScoreCache = new Map<string, number>();

  const getBaseCandidatesForParam = (paramN: string) => {
    const cached = baseCandidateCache.get(paramN);
    if (cached) {
      candidateCacheHits++;
      return cached;
    }

    candidateCacheMisses++;
    const candidates = new Set<string>();
    const directCandidates = tokenToProviders.get(paramN);
    if (directCandidates) for (const id of directCandidates) candidates.add(id);

    if (paramN.endsWith("_id")) {
      const base = paramN.slice(0, -3);
      const baseCandidates = tokenToProviders.get(base);
      if (baseCandidates) for (const id of baseCandidates) candidates.add(id);
      const baseIdCandidates = tokenToProviders.get(`${base}_id`);
      if (baseIdCandidates) {
        for (const id of baseIdCandidates) candidates.add(id);
      }
    }

    if (candidates.size === 0) {
      for (const id of fetcherProviderIds.slice(0, 200)) candidates.add(id);
    }

    const result = Array.from(candidates);
    baseCandidateCache.set(paramN, result);
    return result;
  };

  const getStaticProviderParamScore = (
    providerId: string,
    meta: NonNullable<(typeof providerMeta extends Map<string, infer V> ? V : never)>,
    paramN: string
  ) => {
    const cacheKey = `${providerId}\u0000${paramN}`;
    const cached = staticScoreCache.get(cacheKey);
    if (cached !== undefined) {
      scoreCacheHits++;
      return cached;
    }

    scoreCacheMisses++;
    let score = 0;
    if (meta.isFetcher) score += 2;
    if (meta.tokens.has(paramN)) score += 6;
    if (meta.descNorm.includes(paramN)) score += 3;
    if (meta.nameNorm.includes(paramN)) score += 3;
    if (paramN.endsWith("_id")) {
      const base = paramN.slice(0, -3);
      if (base && meta.tokens.has(base)) score += 3;
      if (base && meta.descNorm.includes(base)) score += 2;
      if (base && meta.nameNorm.includes(base)) score += 2;
    }

    staticScoreCache.set(cacheKey, score);
    return score;
  };

  for (const consumerNode of nodes) {
    const consumerTool = toolByNodeId.get(consumerNode.id);
    if (!consumerTool) continue;
    const required = extractRequiredParams(consumerTool);
    totalRequiredParams += required.length;
    for (const param of required) {
      const scored: Array<{ id: string; score: number }> = [];
      const paramN = normalizeToken(param);
      const consumerNameUpper = getToolName(consumerTool).toUpperCase();

      // Candidate providers:
      // 1) Explicit “call X.Y method” hints => match provider slug tokens.
      // 2) Providers that "provide" param token (from output schema, name, etc.)
      // 3) For *_id, also consider base token.
      let candidateSet = new Set<string>(getBaseCandidatesForParam(paramN));

      const paramDesc = extractParamDescription(consumerTool, param);
      const hints = extractExplicitMethodHints(paramDesc);
      for (const h of hints) {
        const hTok = normalizeToken(h);
        // Most slugs look like: GOOGLESUPER_CALENDARLIST_LIST
        // This token becomes: calendarlist_list
        const fromToken = tokenToProviders.get(hTok);
        if (fromToken) for (const id of fromToken) candidateSet.add(id);

        // If we didn't index it as a token, we can still try slug substring match
        // but keep it bounded by scanning only fetchers.
        if (!fromToken) {
          const needle = hTok.toUpperCase();
          for (const id of fetcherProviderIds.slice(0, 250)) {
            const meta = providerMeta.get(id);
            if (meta && meta.slugUpper.includes(needle)) candidateSet.add(id);
          }
        }
      }

      if (candidateSet.size > 250) {
        const consumerTokens = new Set(
          normalizeToken(getToolName(consumerTool))
            .split("_")
            .filter((token) => token.length > 2)
        );
        const rankedCandidates = Array.from(candidateSet).sort((a, b) => {
          const metaA = providerMeta.get(a);
          const metaB = providerMeta.get(b);
          const scoreMeta = (id: string, meta: typeof metaA) => {
            if (!meta) return 0;
            let s = 0;
            if (meta.isFetcher) s += 4;
            if (id.startsWith(`${consumerNode.toolkit}::`)) s += 3;
            for (const token of consumerTokens) {
              if (meta.tokens.has(token)) s += 2;
              if (meta.slugUpper.includes(token.toUpperCase())) s += 1;
            }
            return s;
          };
          return scoreMeta(b, metaB) - scoreMeta(a, metaA);
        });
        candidateSet = new Set(rankedCandidates.slice(0, 250));
      }

      totalCandidatesConsidered += candidateSet.size;
      if (candidateSet.size > maxCandidatesForAnyParam)
        maxCandidatesForAnyParam = candidateSet.size;

      for (const providerId of candidateSet) {
        const meta = providerMeta.get(providerId);
        if (!meta) continue;
        let score = getStaticProviderParamScore(providerId, meta, paramN);
        for (const h of hints) {
          const hTok = normalizeToken(h).toUpperCase();
          if (meta.slugUpper.includes(hTok)) score += 80;
        }
        if (meta.slugUpper === consumerNameUpper) score -= 100;
        if (score >= minScore) scored.push({ id: providerId, score });
      }

      scored.sort((a, b) => b.score - a.score);
      for (const pick of scored.slice(0, maxEdgesPerParam)) {
        edges.push({
          from: pick.id,
          to: consumerNode.id,
          label: param,
          score: pick.score,
        });
      }
    }

    processedConsumers++;
    if (processedConsumers % progressEvery === 0) {
      const elapsed = nowMs() - startedAt;
      console.log(
        `[build-graph] progress consumers=${processedConsumers}/${nodes.length} edges=${edges.length} elapsed=${formatMs(
          elapsed
        )}`
      );
    }
  }

  // de-dup edges (same from/to/label)
  const dedup = new Map<string, GraphEdge>();
  for (const e of edges) {
    const k = `${e.from}||${e.to}||${e.label}`;
    const prev = dedup.get(k);
    if (!prev || e.score > prev.score) dedup.set(k, e);
  }

  const graph: Graph = {
    nodes,
    edges: Array.from(dedup.values()).sort((a, b) => b.score - a.score),
  };

  const elapsed = nowMs() - startedAt;
  console.log(
    `[build-graph] done requiredParams=${totalRequiredParams} edges=${graph.edges.length} elapsed=${formatMs(
      elapsed
    )}`
  );
  mark("infer_done");

  await writeFile("tool_graph.json", JSON.stringify(graph, null, 2), "utf-8");
  mark("wrote_json");
  await writeFile("tool_graph.dot", toDot(graph), "utf-8");
  mark("wrote_dot");
  await writeFile("tool_graph.html", toExplorerHtml(graph), "utf-8");
  mark("wrote_html");

  console.log("Wrote tool_graph.json, tool_graph.dot, tool_graph.html");

  if (profile) {
    const avgCandidates =
      totalRequiredParams === 0
        ? 0
        : totalCandidatesConsidered / totalRequiredParams;
    const total = nowMs() - startedAt;

    const loadedMs = (phaseTimes.loaded_tools ?? startedAt) - startedAt;
    const indexMs =
      (phaseTimes.index_done ?? startedAt) - (phaseTimes.index_start ?? startedAt);
    const inferMs =
      (phaseTimes.infer_done ?? startedAt) - (phaseTimes.infer_start ?? startedAt);
    const writeJsonMs =
      (phaseTimes.wrote_json ?? startedAt) - (phaseTimes.infer_done ?? startedAt);
    const writeDotMs =
      (phaseTimes.wrote_dot ?? startedAt) - (phaseTimes.wrote_json ?? startedAt);
    const writeHtmlMs =
      (phaseTimes.wrote_html ?? startedAt) - (phaseTimes.wrote_dot ?? startedAt);

    console.log("");
    console.log("[build-graph][profile]");
    console.log(`total=${formatMs(total)}`);
    console.log(`phases: load=${formatMs(loadedMs)} index=${formatMs(indexMs)} infer=${formatMs(inferMs)} writeJson=${formatMs(writeJsonMs)} writeDot=${formatMs(writeDotMs)} writeHtml=${formatMs(writeHtmlMs)}`);
    console.log(`requiredParams=${totalRequiredParams} providers=${nodes.length}`);
    console.log(`candidates: avgPerParam=${avgCandidates.toFixed(1)} maxPerParam=${maxCandidatesForAnyParam}`);
    console.log(`candidateCache: hits=${candidateCacheHits} misses=${candidateCacheMisses} uniqueParams=${baseCandidateCache.size}`);
    console.log(`scoreCache: hits=${scoreCacheHits} misses=${scoreCacheMisses} entries=${staticScoreCache.size}`);
    console.log(`edges=${graph.edges.length}`);
  }
}

await main();
