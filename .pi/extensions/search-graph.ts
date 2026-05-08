import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/**
 * Local AST graph search (requires local service running on port 9749).
 */
export default function (pi: ExtensionAPI) {
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
