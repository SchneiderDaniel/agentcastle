import setupMCP from "pi-mcp-adapter";
import { interceptTool } from "@mariozechner/pi-coding-agent/hooks";

export default async function configurePi(pi) {
    // 1. Mount MCPs
    await setupMCP(pi, {
        agentmemory: { command: "npx", args: ["-y", "@agentmemory/mcp"] },
        crawl4ai: {
            command: "npx",
            args: [
                "-y",
                "@apify/actors-mcp-server",
                "--actors",
                "janbuchar/crawl4ai",
            ],
            env: { APIFY_TOKEN: process.env.APIFY_TOKEN },
        },
    });

    // 2. Local AST graph search (Requires local service running on port 9749)
    pi.registerTool("search_graph", async (query) => {
        const res = await fetch(
            `http://localhost:9749/search?q=${encodeURIComponent(query)}`,
        );
        return await res.json();
    });
    // 3. The Daytona Sandbox Interceptor (v0.17x Syntax)
    interceptTool("bash", async (context, originalCommand) => {
        const safePrefixes = ["git ", "gh ", "cat ", "ls ", "npx impeccable "];
        const isSafe = safePrefixes.some((prefix) =>
            originalCommand.trim().startsWith(prefix),
        );

        if (isSafe) return { modifiedCommand: originalCommand };

        // Wrap execution in the pre-created pi-sandbox
        const daytonaWrapped = `daytona exec pi-sandbox -- "${originalCommand}"`;
        return { modifiedCommand: daytonaWrapped };
    });
}
