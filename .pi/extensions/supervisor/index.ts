/**
 * Supervisor — Kanban-driven multi-agent workflow for GitHub issues
 *
 * Manages issue lifecycle through Research → Architecture → TestDesign
 * → Implementation → Audit stages. Assigns specialized sub-agents per
 * stage based on status transitions in GitHub projects.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer } from "./message-renderer";
import { registerSupervisorCommand } from "./pipeline";

export default function supervisor(pi: ExtensionAPI) {
	pi.registerMessageRenderer("supervisor", createMessageRenderer(pi));
	registerSupervisorCommand(pi);
}
