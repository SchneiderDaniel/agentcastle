import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { HEAVY_TOOLS, QUERY_TIMEOUT, HEAVY_TIMEOUT } from "../lib/codebase-types.js";

const BINARY = `${homedir()}/.local/bin/codebase-memory-mcp`;

/** Derive unique project name from absolute path: basename-<8-char-md5-hex> */
function projectName(cwd: string): string {
  const basename = cwd.split("/").pop() || "root";
  const hash = createHash("md5").update(cwd).digest("hex").slice(0, 8);
  return `${basename}-${hash}`;
}

/** Safe JSON extraction: find first balanced { } block, parse it. Returns null on failure. */
function safeJsonParse(input: string): object | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const start = trimmed.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Call codebase-memory-mcp CLI and return parsed result */
async function cbmCli(
  pi: ExtensionAPI,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const timeout = HEAVY_TOOLS.has(tool) ? HEAVY_TIMEOUT : QUERY_TIMEOUT;
  const result = await pi.exec(BINARY, ["cli", tool, JSON.stringify(args)], {
    signal,
    timeout,
  });

  if (result.code !== 0) {
    return { ok: false, data: null, error: result.stderr || "cbm failed" };
  }

  const outer = safeJsonParse(result.stdout);
  if (!outer) {
    const preview = result.stdout ? result.stdout.slice(0, 200) : "<empty output>";
    return { ok: false, data: null, error: `parse error: ${preview}` };
  }

  // Output can be MCP content wrapper {"content":[{"type":"text","text":"<json>"}]}
  // or direct JSON from some subcommands.
  const contentArr = Array.isArray((outer as any).content) ? (outer as any).content : null;
  const rawText = contentArr?.[0]?.text ?? null;

  if ((outer as any).isError) {
    if (rawText) {
      const inner = safeJsonParse(rawText);
      if (inner) {
        return { ok: false, data: null, error: (inner as any).error || (inner as any).hint || "cbm error" };
      }
      return { ok: false, data: null, error: rawText };
    }
    return { ok: false, data: null, error: (outer as any).error || "cbm error" };
  }

  if (rawText) {
    const inner = safeJsonParse(rawText);
    if (inner) return { ok: true, data: inner };
    // rawText might not be JSON — return as-is
    return { ok: true, data: rawText };
  }

  // No MCP wrapper — treat outer as the data itself
  return { ok: true, data: outer };
}

/** Parse semver from version string. Returns [major, minor, patch] or null. */
function parseVersion(versionString: string): [number, number, number] | null {
  const match = versionString.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/** Compare version tuple against minimum. */
function isVersionAtLeast(
  version: [number, number, number],
  minMajor: number,
  minMinor: number,
  minPatch: number,
): boolean {
  const [major, minor, patch] = version;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

export default async function (pi: ExtensionAPI): Promise<void> {

// ── Version check at init time (before tool registration) ──
  let skipSemanticSearch = false;
  let versionNotificationShown = false;

  try {
    const versionResult = await pi.exec(BINARY, ["--version"], { timeout: 5_000 });
    const version = parseVersion(versionResult.stdout);
    if (!version || !isVersionAtLeast(version, 0, 6, 1)) {
      skipSemanticSearch = true;
    }
  } catch {
    // If version check itself fails, assume old version (safe default)
    skipSemanticSearch = true;
  }

  // On session start, auto-index if not already indexed (with spinner)
  pi.on("session_start", async (_event, ctx) => {
    // One-time notification for missing semantic search
    if (skipSemanticSearch && !versionNotificationShown) {
      versionNotificationShown = true;
      ctx.ui?.notify(
        "Semantic search unavailable — codebase-memory binary is < 0.6.1. Run codebase_update to upgrade.",
        "warning",
      );
    }

    const proj = projectName(ctx.cwd);
    const status = await cbmCli(pi, "list_projects", {});

    const projects: Array<{ name: string }> =
      status.ok && (status.data as any)?.projects ? (status.data as any).projects : [];

    const alreadyIndexed = projects.some((p: { name: string }) => p.name === proj);

    if (!alreadyIndexed) {
      if (ctx.hasUI && ctx.ui) {
        await ctx.ui.custom((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, "Indexing codebase...");
          (async () => {
            try {
              const res = await cbmCli(pi, "index_repository", { repo_path: ctx.cwd }, loader.signal);
              if (res.ok) {
                ctx.ui?.notify(`Codebase indexed: ${(res.data as any)?.nodes ?? "?"} nodes`, "info");
              } else {
                ctx.ui?.notify(`Codebase index failed: ${res.error}`, "warning");
              }
            } finally {
              loader.dispose();
              done(undefined);
            }
          })();
          return loader;
        }, { overlay: true });
      } else {
        const res = await cbmCli(pi, "index_repository", { repo_path: ctx.cwd });
        if (res.ok) {
          ctx.ui?.notify(`Codebase indexed: ${(res.data as any)?.nodes ?? "?"} nodes`, "info");
        } else {
          ctx.ui?.notify(`Codebase index failed: ${res.error}`, "warning");
        }
      }
    }
  });

  // ── Inject tool-use guidance into every agent turn ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const guide =
      "\n\n### Codebase Exploration Strategy\n" +
      "Before reading files or running grep, use graph tools to explore structure:\n" +
      "- `codebase_search` — find functions/classes by name pattern, label, or file. Use BEFORE reading code.\n" +
      "- `codebase_trace` — trace callers/callees of any function. Replaces manual file-by-file call-chain tracing.\n" +
      "- `codebase_overview` — get architecture overview (entry points, routes, hotspots, clusters) in one call.\n" +
      "- `codebase_query` — run Cypher-like graph queries for complex structural questions.\n" +
      "- `codebase_snippet` — read source by qualified name (from search results).\n" +
      "- `codebase_detect_changes` — map git diff to affected symbols + risk classification.\n" +
      "\nGraph queries use ~120x fewer tokens than file-by-file grep/read. Always prefer graph tools over bash grep or read for structural questions about the codebase.";

    return {
      systemPrompt: event.systemPrompt + guide,
    };
  });

  // ── 1. index_repository ──
  pi.registerTool({
    name: "codebase_index",
    label: "Index Repository",
    description:
      "Index (or re-index) a repository into the codebase graph. Auto-sync keeps it fresh after that.",
    promptSnippet: "Index/reindex the current project into the codebase knowledge graph",
    promptGuidelines: [
      "Use codebase_index when the user explicitly asks to index/reindex the project.",
      "The project is auto-indexed on session start; only use this tool if reindex is needed.",
    ],
    parameters: Type.Object({
      repo_path: Type.Optional(
        Type.String({ description: "Path to repository (defaults to current project)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = params.repo_path || ctx.cwd;
      const res = await cbmCli(pi, "index_repository", { repo_path: path }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      const d = res.data as any;
      return {
        content: [{ type: "text", text: `Indexed ${d.project}: ${d.nodes} nodes, ${d.edges} edges. Status: ${d.status}` }],
        details: d,
      };
    },
  });

  // ── 2. list_projects ──
  pi.registerTool({
    name: "codebase_list_projects",
    label: "List Projects",
    description: "List all indexed projects with node/edge counts.",
    promptSnippet: "List all indexed projects with node/edge counts",
    promptGuidelines: [
      "Use codebase_list_projects to see which projects are indexed and their sizes.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, _ctx) {
      const res = await cbmCli(pi, "list_projects", {}, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      const projects = (res.data as any)?.projects || [];
      const lines = projects.map((p: any) =>
        `  ${p.name}: ${p.nodes ?? "?"} nodes, ${p.edges ?? "?"} edges`
      );
      return {
        content: [{ type: "text", text: `Projects (${projects.length}):\n${lines.join("\n")}` }],
        details: res.data,
      };
    },
  });

  // ── 3. delete_project ──
  pi.registerTool({
    name: "codebase_delete_project",
    label: "Delete Project",
    description: "Remove a project and all its graph data.",
    promptSnippet: "Remove a project and all its graph data",
    promptGuidelines: [
      "Use codebase_delete_project when the user wants to remove a project from the index.",
      "This is irreversible; confirm with the user before calling.",
    ],
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Project name to delete (defaults to current project)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "delete_project", { project: proj }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      return {
        content: [{ type: "text", text: `Deleted project: ${proj}` }],
        details: res.data,
      };
    },
  });

  // ── 4. index_status ──
  pi.registerTool({
    name: "codebase_index_status",
    label: "Index Status",
    description: "Check indexing status of a project.",
    promptSnippet: "Check indexing status of a project",
    promptGuidelines: [
      "Use codebase_index_status to check if a project is fully indexed or still in progress.",
    ],
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Project name (defaults to current project)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "index_status", { project: proj }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
        details: res.data,
      };
    },
  });

  // ── 5. search_graph ──
  pi.registerTool({
    name: "codebase_search",
    label: "Search Graph",
    description:
      "Structured search by label, name pattern, file pattern, degree filters. Pagination via limit/offset.",
    promptSnippet: "Search codebase graph by name pattern, label, file, degree filters",
    promptGuidelines: [
      "Use codebase_search to find functions, classes, or files by name pattern before tracing calls or reading code.",
      "Prefer codebase_search over grep/bash when exploring code structure across files.",
    ],
    parameters: Type.Object({
      name_pattern: Type.String({
        description: "Regex pattern to match names (e.g. '.*Handler.*', 'ProcessOrder')",
      }),
      label: Type.Optional(
        Type.String({
          description:
            "Node label to filter: Function, Class, File, Module, Route, Package, etc.",
        }),
      ),
      file_pattern: Type.Optional(
        Type.String({ description: "Optional regex to filter by file path" }),
      ),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
      offset: Type.Optional(Type.Number({ description: "Pagination offset (default 0)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "search_graph", {
        project: proj,
        name_pattern: params.name_pattern,
        label: params.label || undefined,
        file_pattern: params.file_pattern || undefined,
        limit: params.limit || 20,
        offset: params.offset || 0,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      const data = res.data as any;
      const results = data.results || [];
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No results for "${params.name_pattern}"${params.label ? ` (label: ${params.label})` : ""}. Try broader pattern.` }], details: data };
      }
      const lines = results.map((r: any) =>
        `[${r.label}] ${r.name}  |  ${r.file_path}  |  in:${r.in_degree} out:${r.out_degree}`
      );
      return {
        content: [{ type: "text", text: `${data.total} total, showing ${results.length}:\n${lines.join("\n")}` }],
        details: data,
      };
    },
  });

  // ── 6. trace_call_path ──
  pi.registerTool({
    name: "codebase_trace",
    label: "Trace Calls",
    description:
      "BFS traversal — who calls a function and what it calls. Depth 1-5.",
    promptSnippet: "Trace call paths: inbound callers, outbound callees, or both",
    promptGuidelines: [
      "Use codebase_trace to understand call chains: find all callers of a function or all functions it calls.",
      "Use codebase_search first to find the exact function name if unsure.",
    ],
    parameters: Type.Object({
      function_name: Type.String({
        description: "Exact function name to trace (use codebase_search to find first)",
      }),
      direction: Type.Optional(
        Type.String({
          description: "Trace direction: inbound, outbound, or both (default)",
        }),
      ),
      depth: Type.Optional(
        Type.Number({ description: "Max traversal depth 1-5 (default 3)" }),
      ),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "trace_call_path", {
        project: proj,
        function_name: params.function_name,
        direction: params.direction || "both",
        depth: params.depth || 3,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      const data = res.data as any;
      const callers = data.callers || [];
      const callees = data.callees || [];
      const lines: string[] = [];
      if (callers.length > 0) {
        lines.push(`Callers (inbound, ${callers.length}):`);
        for (const c of callers) lines.push(`  ← ${c.name} (hop ${c.hop})  |  ${c.file_path || ""}`);
      }
      if (callees.length > 0) {
        lines.push(`Callees (outbound, ${callees.length}):`);
        for (const c of callees) lines.push(`  → ${c.name} (hop ${c.hop})  |  ${c.file_path || ""}`);
      }
      if (lines.length === 0) {
        return { content: [{ type: "text", text: `No call paths found for "${params.function_name}". Try codebase_search to verify the name.` }], details: data };
      }
      return {
        content: [{ type: "text", text: `Trace for ${params.function_name} (direction: ${data.direction}):\n${lines.join("\n")}` }],
        details: data,
      };
    },
  });

  // ── 6b. semantic_query ── (available in binary >= 0.6.1)
  if (!skipSemanticSearch) {
    pi.registerTool({
    name: "codebase_semantic_search",
    label: "Semantic Search",
    description:
      "Vector similarity search across codebase symbols using Nomic embeddings (binary >= 0.6.1). Falls back gracefully on older binaries.",
    promptSnippet: "Semantic vector search across the codebase graph",
    promptGuidelines: [
      "Use codebase_semantic_search for natural-language code discovery when regex patterns are insufficient.",
      "Falls back with an error on binary versions < 0.6.1 — use codebase_search instead.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural language query (e.g. 'authentication middleware')" }),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "semantic_query", {
        project: proj,
        query: params.query,
        limit: params.limit || 10,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      const data = res.data as any;
      const results = data.results || [];
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No semantic matches for "${params.query}".` }], details: data };
      }
      const lines = results.map((r: any) =>
        `[${r.label}] ${r.name} (score: ${r.score?.toFixed?.(3) ?? r.score})  |  ${r.file_path}`
      );
      return {
        content: [{ type: "text", text: `${results.length} results:\n${lines.join("\n")}` }],
        details: data,
      };
    },
  });
  }

  // ── 7. detect_changes ──
  pi.registerTool({
    name: "codebase_detect_changes",
    label: "Detect Changes",
    description:
      "Map git diff to affected symbols with risk classification and blast radius.",
    promptSnippet: "Map uncommitted git changes to affected symbols with risk classification",
    promptGuidelines: [
      "Use codebase_detect_changes to understand the impact of uncommitted changes before committing.",
    ],
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "detect_changes", { project: proj }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
        details: res.data,
      };
    },
  });

  // ── 8. query_graph ──
  pi.registerTool({
    name: "codebase_query",
    label: "Query Graph",
    description:
      "Execute Cypher-like graph queries: MATCH, WHERE, RETURN, COUNT, DISTINCT, ORDER BY, LIMIT.",
    promptSnippet: "Run Cypher-like queries on the codebase graph (MATCH...RETURN...)",
    promptGuidelines: [
      "Use codebase_query for complex structural queries like 'find all functions called by tests'.",
      "Use codebase_get_schema first to see available labels and edge types before writing queries.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Cypher-like query: MATCH (n:Label)-[r:REL_TYPE]->(m) WHERE ... RETURN ...",
      }),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "query_graph", {
        project: proj,
        query: params.query,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      const data = res.data as any;
      const rows = data.rows || data.results || [];
      return {
        content: [{ type: "text", text: `${rows.length} results:\n${JSON.stringify(rows, null, 2)}` }],
        details: data,
      };
    },
  });

  // ── 9. get_graph_schema ──
  pi.registerTool({
    name: "codebase_get_schema",
    label: "Graph Schema",
    description:
      "Node/edge counts, relationship patterns, and property definitions per label. Run this first before writing Cypher queries.",
    promptSnippet: "Show graph schema: node labels, edge types, property definitions",
    promptGuidelines: [
      "Use codebase_get_schema before writing Cypher queries to see available labels, edge types, and properties.",
    ],
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "get_graph_schema", { project: proj }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
        details: res.data,
      };
    },
  });

  // ── 10. get_code_snippet ──
  pi.registerTool({
    name: "codebase_snippet",
    label: "Get Code Snippet",
    description:
      "Read source code for a function/class by qualified name. Use codebase_search first to find the QN.",
    promptSnippet: "Read source code by qualified name from the graph",
    promptGuidelines: [
      "Use codebase_snippet to read function/class source code after finding it with codebase_search.",
      "The qualified name format is: <project>.<path>.<name> — get it from codebase_search results.",
    ],
    parameters: Type.Object({
      qualified_name: Type.String({
        description: "Full qualified name from codebase_search results",
      }),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "get_code_snippet", {
        project: proj,
        qualified_name: params.qualified_name,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      const data = res.data as any;
      const src = data.source || data.snippet || data.code || "";
      const header = data.signature ? `// ${data.signature}\n` : "";
      const full = `${header}${src}`;

      // Truncate oversized snippets: max 500 lines or 15KB
      const MAX_LINES = 500;
      const MAX_BYTES = 15_000;
      const lines = full.split("\n");

      if (lines.length <= MAX_LINES && Buffer.byteLength(full, "utf-8") <= MAX_BYTES) {
        return { content: [{ type: "text", text: full }], details: data };
      }

      // Truncate by lines first
      let truncated = lines.slice(0, MAX_LINES);
      let omitted = lines.length - MAX_LINES;
      let text = truncated.join("\n");
      const note = `// ...truncated (${omitted} lines omitted)`;

      if (Buffer.byteLength(text, "utf-8") + Buffer.byteLength(note, "utf-8") > MAX_BYTES) {
        // Binary search for line count that fits within byte limit
        let lo = 0;
        let hi = MAX_LINES;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const candidate = lines.slice(0, mid).join("\n");
          if (Buffer.byteLength(candidate, "utf-8") + Buffer.byteLength(note, "utf-8") <= MAX_BYTES) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        truncated = lines.slice(0, lo);
        omitted = lines.length - lo;
        text = truncated.join("\n");
      }

      return {
        content: [{ type: "text", text: `${text}\n// ...truncated (${omitted} lines omitted)` }],
        details: data,
      };
    },
  });

  // ── 10b. update_binary ──
  pi.registerTool({
    name: "codebase_update",
    label: "Update Binary",
    description:
      "Check codebase-memory-mcp version and upgrade to latest release.",
    promptSnippet: "Check and upgrade codebase-memory-mcp binary",
    promptGuidelines: [
      "Use codebase_update when the user asks to update the codebase memory tools.",
      "Updates check latest GitHub release and self-upgrade the binary.",
    ],
    parameters: Type.Object({
      check_only: Type.Optional(
        Type.Boolean({ description: "If true, only check version without upgrading (default false)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const args = params.check_only ? ["update", "--check"] : ["update", "-y"];
      // update subcommand is not a CLI tool — run directly
      const result = await pi.exec(BINARY, args, { signal, timeout: 60_000 });
      if (result.code !== 0) {
        return {
          content: [{ type: "text", text: `Update failed: ${result.stderr || result.stdout}` }],
          details: {} as Record<string, unknown>,
        };
      }
      return {
        content: [{ type: "text", text: result.stdout || "Update completed." }],
        details: {} as Record<string, unknown>,
      };
    },
  });

  // ── 11. get_architecture ──
  pi.registerTool({
    name: "codebase_overview",
    label: "Architecture Overview",
    description:
      "Codebase overview: languages, packages, entry points, routes, hotspots, boundaries, layers, clusters, ADR.",
    promptSnippet: "Get architecture overview: languages, entry points, routes, hotspots",
    promptGuidelines: [
      "Use codebase_overview at the start of a session to understand the project structure quickly.",
      "Prefer codebase_overview over reading many files to understand project layout.",
    ],
    parameters: Type.Object({
      aspects: Type.Optional(
        Type.String({
          description:
            "Comma-separated: languages,packages,entry_points,routes,hotspots,boundaries,layers,clusters,adr (default: all)",
        }),
      ),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const aspectsArr = params.aspects
        ? params.aspects.split(",").map((s: string) => s.trim())
        : ["all"];
      const res = await cbmCli(pi, "get_architecture", {
        project: proj,
        aspects: aspectsArr,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
        details: res.data,
      };
    },
  });

  // ── 12. search_code ──
  pi.registerTool({
    name: "codebase_grep",
    label: "Search Code",
    description:
      "Grep-like text search within indexed project files. Faster than bash grep for indexed projects.",
    promptSnippet: "Full-text search within indexed project files",
    promptGuidelines: [
      "Use codebase_grep for text search within indexed projects — faster than bash grep for large codebases.",
      "Use bash grep for non-indexed files or when you need live filesystem results.",
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description: "Text/regex pattern to search for in file contents",
      }),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const res = await cbmCli(pi, "search_code", {
        project: proj,
        pattern: params.pattern,
        limit: params.limit || 50,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      const data = res.data as any;
      const rawMatches = data.raw_matches || [];
      const graphResults = data.results || [];
      if (rawMatches.length === 0 && graphResults.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${params.pattern}"` }], details: data };
      }
      const lines: string[] = [];
      const MAX_GRAPH = 10;
      const MAX_RAW = 15;
      if (graphResults.length > 0) {
        const shown = graphResults.slice(0, MAX_GRAPH);
        const omitted = graphResults.length - shown.length;
        lines.push(`Graph matches (${graphResults.length} symbols${omitted > 0 ? `, showing ${shown.length}, ${omitted} omitted` : ""}):`);
        for (const r of shown) {
          lines.push(`  [${r.label}] ${r.node || r.name}  |  ${r.file}  |  matches at lines: ${(r.match_lines || []).slice(0, 5).join(",")}`);
        }
      }
      if (rawMatches.length > 0) {
        const shown = rawMatches.slice(0, MAX_RAW);
        const omitted = rawMatches.length - shown.length;
        lines.push(`Raw matches (${rawMatches.length} lines${omitted > 0 ? `, showing ${shown.length}, ${omitted} omitted` : ""}):`);
        for (const r of shown) {
          lines.push(`  ${r.file}:${r.line}: ${(r.content || "").substring(0, 120)}`);
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: data,
      };
    },
  });

  // ── 13. manage_adr ──
  pi.registerTool({
    name: "codebase_adr",
    label: "Manage ADR",
    description:
      "CRUD for Architecture Decision Records. Update (create/modify), retrieve, list, or delete architectural decisions.",
    promptSnippet: "Manage Architecture Decision Records (update, retrieve, list, delete)",
    promptGuidelines: [
      "Use codebase_adr to persist architectural decisions that survive across sessions.",
      "Use mode='update' to create or modify an ADR. Use mode='retrieve' to read it back.",
      "After analyzing the codebase, consider creating an ADR to document key architectural insights.",
    ],
    parameters: Type.Object({
      mode: Type.String({
        description: "Operation: update (create/modify), retrieve, list, delete",
      }),
      title: Type.Optional(Type.String({ description: "ADR title (for update/retrieve/delete)" })),
      content: Type.Optional(Type.String({ description: "ADR content in markdown (for update)" })),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      // Normalize mode: binary uses "update" not "store"
      let mode = params.mode;
      if (mode === "store") mode = "update";
      const args: Record<string, unknown> = { project: proj, mode };
      if (params.title) args.title = params.title;
      if (params.content) args.content = params.content;
      const res = await cbmCli(pi, "manage_adr", args, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
        details: res.data,
      };
    },
  });

  // ── 14. ingest_traces ──
  pi.registerTool({
    name: "codebase_ingest_traces",
    label: "Ingest Traces",
    description:
      "Ingest runtime traces to validate HTTP_CALLS edges in the graph.",
    promptSnippet: "Ingest runtime traces to validate HTTP call edges",
    promptGuidelines: [
      "Use codebase_ingest_traces to feed runtime trace data into the graph for validation.",
    ],
    parameters: Type.Object({
      traces: Type.String({
        description: "JSON array of trace objects with source, target, method, path fields",
      }),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      let traces;
      try { traces = JSON.parse(params.traces); } catch {
        return { content: [{ type: "text", text: "Error: traces must be valid JSON" }], details: {} as Record<string, unknown> };
      }
      const res = await cbmCli(pi, "ingest_traces", {
        project: proj,
        traces,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} as Record<string, unknown> };
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
        details: res.data,
      };
    },
  });
}
