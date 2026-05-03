import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const BINARY = `${process.env.HOME}/.local/bin/codebase-memory-mcp`;

/** Derive project name from cwd path: /home/miria/git/main → home-miria-git-main */
function projectName(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/\//g, "-");
}

/** Call codebase-memory-mcp CLI and return parsed result */
async function cbmCli(
  pi: ExtensionAPI,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const result = await pi.exec(BINARY, ["cli", tool, JSON.stringify(args)], {
    signal,
    timeout: 120_000,
  });

  if (result.code !== 0) {
    return { ok: false, data: null, error: result.stderr || "cbm failed" };
  }

  try {
    // Output is MCP content wrapper: {"content":[{"type":"text","text":"<json>"}]}
    const outer = JSON.parse(result.stdout);
    if (outer.isError) {
      const inner = JSON.parse(outer.content[0]?.text || "{}");
      return { ok: false, data: null, error: inner.error || inner.hint || "cbm error" };
    }
    const inner = JSON.parse(outer.content[0]?.text || "{}");
    return { ok: true, data: inner };
  } catch (e) {
    return { ok: false, data: null, error: `parse error: ${e}` };
  }
}

export default async function (pi: ExtensionAPI) {
  // On session start, auto-index if not already indexed
  pi.on("session_start", async (_event, ctx) => {
    const proj = projectName(ctx.cwd);
    const status = await cbmCli(pi, "list_projects", {});

    const projects: Array<{ name: string }> =
      status.ok && (status.data as any)?.projects ? (status.data as any).projects : [];

    const alreadyIndexed = projects.some((p: { name: string }) => p.name === proj);

    if (!alreadyIndexed) {
      const res = await cbmCli(pi, "index_repository", { repo_path: ctx.cwd });
      if (res.ok) {
        ctx.ui?.notify(`Codebase indexed: ${(res.data as any)?.nodes ?? "?"} nodes`, "info");
      } else {
        ctx.ui?.notify(`Codebase index failed: ${res.error}`, "warning");
      }
    }
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
      const data = res.data as any;
      const callers = data.callers || [];
      const callees = data.callees || [];
      const lines: string[] = [];
      if (callers.length > 0) {
        lines.push(`Callers (inbound, ${callers.length}):`);
        for (const c of callers) lines.push(`  ← ${c.name} (hop ${c.hop})`);
      }
      if (callees.length > 0) {
        lines.push(`Callees (outbound, ${callees.length}):`);
        for (const c of callees) lines.push(`  → ${c.name} (hop ${c.hop})`);
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
      const data = res.data as any;
      const src = data.source || data.snippet || data.code || "";
      const header = data.signature ? `// ${data.signature}\n` : "";
      return {
        content: [{ type: "text", text: `${header}${src}` }],
        details: data,
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
      const data = res.data as any;
      const rawMatches = data.raw_matches || [];
      const graphResults = data.results || [];
      if (rawMatches.length === 0 && graphResults.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${params.pattern}"` }], details: data };
      }
      const lines: string[] = [];
      if (graphResults.length > 0) {
        lines.push(`Graph matches (${graphResults.length} symbols):`);
        for (const r of graphResults.slice(0, 10)) {
          lines.push(`  [${r.label}] ${r.node || r.name}  |  ${r.file}  |  matches at lines: ${(r.match_lines || []).slice(0, 5).join(",")}`);
        }
      }
      if (rawMatches.length > 0) {
        lines.push(`Raw matches (${rawMatches.length} lines):`);
        for (const r of rawMatches.slice(0, 15)) {
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
      "CRUD for Architecture Decision Records. Store, retrieve, list, or delete architectural decisions.",
    promptSnippet: "Manage Architecture Decision Records (store, retrieve, list, delete)",
    promptGuidelines: [
      "Use codebase_adr to persist architectural decisions that survive across sessions.",
      "After analyzing the codebase, consider creating an ADR to document key architectural insights.",
    ],
    parameters: Type.Object({
      mode: Type.String({
        description: "Operation: store, retrieve, list, delete",
      }),
      title: Type.Optional(Type.String({ description: "ADR title (for store/retrieve/delete)" })),
      content: Type.Optional(Type.String({ description: "ADR content in markdown (for store)" })),
      project: Type.Optional(
        Type.String({ description: "Project name (auto-detected if omitted)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const proj = params.project || projectName(ctx.cwd);
      const args: Record<string, unknown> = { project: proj, mode: params.mode };
      if (params.title) args.title = params.title;
      if (params.content) args.content = params.content;
      const res = await cbmCli(pi, "manage_adr", args, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
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
        return { content: [{ type: "text", text: "Error: traces must be valid JSON" }], details: {} };
      }
      const res = await cbmCli(pi, "ingest_traces", {
        project: proj,
        traces,
      }, signal);
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${res.error}` }], details: {} };
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
        details: res.data,
      };
    },
  });
}
