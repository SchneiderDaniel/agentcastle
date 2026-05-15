// ─── Status Transitions ────────────────────────────────────────────
// Maps agent output markers to next board status.

export function determineNextStatus(agentName: string, output: string): string | null {
	switch (agentName) {
		case "architect":
			return output.includes("ARCHITECTURE_COMPLETE") ? "Research" : null;
		case "researcher":
			return output.includes("RESEARCH_COMPLETE") ? "TestDesign" : null;
		case "test-designer":
			return output.includes("TEST_PLAN_COMPLETE") ? "Implementation" : null;
		case "developer":
			return output.includes("IMPLEMENTATION_COMPLETE") ? "Audit" : null;
		case "auditor": {
			const idxApproved = output.lastIndexOf("AUDIT_APPROVED");
			const idxRejected = output.lastIndexOf("AUDIT_REJECTED");
			if (idxRejected > idxApproved) return "Implementation";
			if (idxApproved > idxRejected) return "Done";
			return null;
		}
		default:
			return null;
	}
}
