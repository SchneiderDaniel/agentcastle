/**
 * Supervisor — Kanban-driven multi-agent workflow for GitHub issues
 *
 * Manages issue lifecycle through Research → Architecture → TestDesign
 * → Implementation → Audit stages. Assigns specialized sub-agents per
 * stage based on status transitions in GitHub projects.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer, createSummaryRenderer } from "./session/message-renderer";
import { registerSupervisorCommand } from "./pipeline/index.ts";

export default function supervisor(pi: ExtensionAPI) {
	pi.registerMessageRenderer("supervisor", createMessageRenderer(pi));
	pi.registerMessageRenderer("supervisor-summary", createSummaryRenderer(pi));
	registerSupervisorCommand(pi);
}
