/**
 * Supervisor — Kanban-driven agent orchestration for GitHub issues
 *
 * Entry point. Delegates to modules.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer } from "./message-renderer";
import { registerSupervisorCommand } from "./pipeline";

export default function supervisor(pi: ExtensionAPI) {
	pi.registerMessageRenderer("supervisor", createMessageRenderer(pi));
	registerSupervisorCommand(pi);
}
