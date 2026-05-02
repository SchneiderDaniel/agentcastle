import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 1. Daytona Sandbox Interceptor
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const safePrefixes = ["git ", "gh ", "cat ", "ls ", "npx impeccable "];
    const isSafe = safePrefixes.some((prefix) =>
      event.input.command.trim().startsWith(prefix),
    );

    if (!isSafe) {
      const probe = async () => {
        const result = await pi.exec(
          "daytona",
          ["exec", "pi-sandbox", "--", "true"],
          { timeout: 10000, signal: ctx.signal },
        );
        return result.code === 0;
      };

      if (!(await probe())) {
        // Try starting, with retries for transient state-change conflicts
        let started = false;
        for (let i = 0; i < 5; i++) {
          const result = await pi.exec(
            "daytona",
            ["start", "pi-sandbox"],
            { timeout: 30000, signal: ctx.signal },
          );
          if (result.code === 0) {
            started = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }

        if (!started) {
          // Fallback: create the sandbox
          const result = await pi.exec(
            "daytona",
            ["create", "--name", "pi-sandbox"],
            { timeout: 60000, signal: ctx.signal },
          );

          if (result.code === 0) {
            // creation is async; poll until the sandbox accepts commands
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 1500));
              if (await probe()) break;
            }
          }
        }
      }

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
