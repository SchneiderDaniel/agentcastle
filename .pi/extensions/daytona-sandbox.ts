import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 1. Daytona Sandbox Interceptor
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const safePrefixes = ["git ", "gh ", "cat ", "ls ", "npx impeccable "];
    const isSafe = safePrefixes.some((prefix) =>
      event.input.command.trim().startsWith(prefix),
    );

    if (!isSafe) {
      const cmd = event.input.command.replace(/'/g, "'\"'\"'");
      event.input.command = `daytona exec pi-sandbox -- '${cmd}'`;
    }
  });

  // 2. Local AST graph search (Requires local service running on port 9749)
  pi.registerTool({
    name: "search_graph",
    label: "Search Graph",
    description: "Search the local AST graph database",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const res = await fetch(
        `http://localhost:9749/search?q=${encodeURIComponent(params.query)}`,
      );
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        details: data,
      };
    },
  });
}
