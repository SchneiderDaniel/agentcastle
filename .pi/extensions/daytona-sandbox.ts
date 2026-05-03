import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Daytona Sandbox Interceptor
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command.trim();

    // These commands always run on the host (safe, or need host filesystem access)
    const hostPrefixes = [
      "git ",
      "gh ",
      "cat ",
      "ls ",
      "curl ",
      "python3 ",
      "pip3 ",
      "pip ",
      "npx impeccable ",
      "rm ",
      "mkdir ",
      "mv ",
      "cp ",
      "touch ",
      "chmod ",
      "chown ",
    ];
    const runsOnHost = hostPrefixes.some((prefix) =>
      command.startsWith(prefix),
    );

    if (runsOnHost) {
      // Basic guard: block absolute paths outside the project directory
      const absPaths = command.match(/\s(\/[^ ]+)/g);
      if (absPaths) {
        for (const match of absPaths) {
          const path = match.trim();
          if (!path.startsWith(ctx.cwd)) {
            return {
              block: true,
              reason: `Blocked: absolute path "${path}" is outside the project directory "${ctx.cwd}". Use relative paths instead.`,
            };
          }
        }
      }
      return; // run on host unchanged
    }

    // Everything else goes to the Daytona sandbox
    const probe = async () => {
      const result = await pi.exec(
        "daytona",
        ["exec", "pi-sandbox", "--", "true"],
        { timeout: 10000, signal: ctx.signal },
      );
      return result.code === 0;
    };

    if (!(await probe())) {
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
        // Ensure a persistent volume exists for the sandbox
        const volResult = await pi.exec(
          "daytona",
          ["volume", "create", "pi-sandbox-vol"],
          { timeout: 30000, signal: ctx.signal },
        );
        // volume create may fail if it already exists; that's okay

        const createResult = await pi.exec(
          "daytona",
          [
            "create",
            "--name",
            "pi-sandbox",
            "--volume",
            "pi-sandbox-vol:/workspace",
          ],
          { timeout: 60000, signal: ctx.signal },
        );

        if (createResult.code === 0) {
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            if (await probe()) break;
          }
        }
      }
    }

    const cmd = event.input.command.replace(/'/g, "'\"'\"'");
    event.input.command = `daytona exec pi-sandbox -- '${cmd}'`;
  });

  // Local AST graph search (Requires local service running on port 9749)
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
