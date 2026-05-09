/**
 * Tests for the dependency gate logic from .pi/extensions/supervisor/deps.ts
 *
 * The parseTimelineResponse logic is duplicated here (identical to the
 * source) because the worktree path contains a '#' that Node's ESM loader
 * encodes, breaking cross-module imports.  Same approach as
 * supervisor-extensions.test.mts which duplicates resolveExtensions.
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-deps.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// ─── Types (duplicated from deps.ts) ─────────────────────────────────

interface GhBlockingIssue {
	id: string;
	number: number;
	title: string;
	state: string;
}

interface GhTimelineNode {
	__typename: string;
	blockingIssue?: GhBlockingIssue | null;
}

interface GhTimelineResponse {
	data?: {
		repository?: {
			issue?: {
				timelineItems?: {
					nodes?: GhTimelineNode[];
				};
			};
		};
	};
	errors?: Array<{ message: string }>;
}

interface BlockerInfo {
	number: number;
	title: string;
	type: "issue" | "pullrequest";
	state: string;
}

interface DepsResult {
	blocked: boolean;
	blockers: BlockerInfo[];
}

// ─── Function under test (duplicated from deps.ts) ──────────────────

function parseTimelineResponse(
	response: GhTimelineResponse | null,
): DepsResult {
	if (response?.errors && response.errors.length > 0) {
		const msgs = response.errors.map((e) => e.message).join("; ");
		throw new Error(`GitHub GraphQL error: ${msgs}`);
	}

	const nodes = response?.data?.repository?.issue?.timelineItems?.nodes;
	if (!nodes || nodes.length === 0) {
		return { blocked: false, blockers: [] };
	}

	const lastEventByIssue = new Map<string, string>();

	for (const node of nodes) {
		const blockingId = node?.blockingIssue?.id;
		if (!blockingId) continue;
		lastEventByIssue.set(blockingId, node.__typename);
	}

	const blockers: BlockerInfo[] = [];
	const seenNumbers = new Set<number>();

	for (const node of nodes) {
		const issue = node.blockingIssue;
		if (!issue) continue;

		const lastEvent = lastEventByIssue.get(issue.id);
		if (lastEvent !== "BlockedByAddedEvent") continue;

		if (seenNumbers.has(issue.number)) continue;
		seenNumbers.add(issue.number);

		const state = issue.state || "UNKNOWN";

		if (state === "CLOSED") continue;

		blockers.push({
			number: issue.number,
			title: issue.title || "",
			type: "issue",
			state,
		});
	}

	return {
		blocked: blockers.length > 0,
		blockers,
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────

function addedEvent(
	id: string,
	number: number,
	title: string,
	state: string,
): GhTimelineNode {
	return {
		__typename: "BlockedByAddedEvent",
		blockingIssue: { id, number, title, state },
	};
}

function removedEvent(
	id: string,
	number: number,
	title = "X",
	state = "OPEN",
): GhTimelineNode {
	return {
		__typename: "BlockedByRemovedEvent",
		blockingIssue: { id, number, title, state },
	};
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("parseTimelineResponse", () => {
	it("null response → not blocked", () => {
		const result = parseTimelineResponse(null);
		assert.deepStrictEqual(result, { blocked: false, blockers: [] });
	});

	it("empty timeline → not blocked", () => {
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes: [] } } } },
		};
		assert.strictEqual(parseTimelineResponse(response).blocked, false);
	});

	it("throws on GraphQL errors", () => {
		assert.throws(
			() => parseTimelineResponse({ errors: [{ message: "Bad token" }] }),
			{ message: /Bad token/ },
		);
	});

	it("all removed events → not blocked", () => {
		const response: GhTimelineResponse = {
			data: {
				repository: {
					issue: {
						timelineItems: {
							nodes: [
								addedEvent("abc", 42, "Stuff", "OPEN"),
								removedEvent("abc", 42, "Stuff", "OPEN"),
							],
						},
					},
				},
			},
		};
		assert.strictEqual(parseTimelineResponse(response).blocked, false);
	});

	// ── Latest event wins ──────────────────────────────────────────

	it("added then removed = not blocked", () => {
		const nodes = [
			addedEvent("id1", 10, "Blocker X", "OPEN"),
			removedEvent("id1", 10, "Blocker X", "OPEN"),
		];
		const response: GhTimelineResponse = {
			data: {
				repository: { issue: { timelineItems: { nodes } } },
			},
		};
		assert.strictEqual(parseTimelineResponse(response).blocked, false);
	});

	it("removed then added = blocked", () => {
		const nodes = [
			removedEvent("id1", 10, "Blocker X", "OPEN"),
			addedEvent("id1", 10, "Blocker X", "OPEN"),
		];
		const response: GhTimelineResponse = {
			data: {
				repository: { issue: { timelineItems: { nodes } } },
			},
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blocked, true);
		assert.strictEqual(result.blockers.length, 1);
		assert.strictEqual(result.blockers[0].number, 10);
	});

	it("fluctuating events: add, remove, add → last wins (blocked)", () => {
		const nodes = [
			addedEvent("id1", 10, "Blocker X", "OPEN"),
			removedEvent("id1", 10, "Blocker X", "OPEN"),
			addedEvent("id1", 10, "Blocker X", "OPEN"),
		];
		const response: GhTimelineResponse = {
			data: {
				repository: { issue: { timelineItems: { nodes } } },
			},
		};
		assert.strictEqual(parseTimelineResponse(response).blocked, true);
	});

	// ── Classification ─────────────────────────────────────────────

	it("OPEN → blocking", () => {
		const response: GhTimelineResponse = {
			data: {
				repository: {
					issue: {
						timelineItems: {
							nodes: [addedEvent("id1", 10, "Blocker", "OPEN")],
						},
					},
				},
			},
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blocked, true);
		assert.strictEqual(result.blockers[0].state, "OPEN");
	});

	it("CLOSED → resolved", () => {
		const response: GhTimelineResponse = {
			data: {
				repository: {
					issue: {
						timelineItems: {
							nodes: [addedEvent("id1", 10, "Blocker", "CLOSED")],
						},
					},
				},
			},
		};
		assert.strictEqual(parseTimelineResponse(response).blocked, false);
	});

	it("mixed: OPEN remain, CLOSED filtered", () => {
		const nodes = [
			addedEvent("id1", 10, "Closed", "CLOSED"),
			addedEvent("id2", 20, "Open", "OPEN"),
			addedEvent("id3", 30, "Also open", "OPEN"),
		];
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes } } } },
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blocked, true);
		assert.strictEqual(result.blockers.length, 2);
		const nums = result.blockers.map((b) => b.number).sort();
		assert.deepStrictEqual(nums, [20, 30]);
	});

	// ── Edge cases ─────────────────────────────────────────────────

	it("null blockingIssue → skipped gracefully", () => {
		const nodes: GhTimelineNode[] = [
			{ __typename: "BlockedByAddedEvent", blockingIssue: null },
			addedEvent("id1", 10, "Real", "OPEN"),
		];
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes } } } },
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blocked, true);
		assert.strictEqual(result.blockers.length, 1);
	});

	it("duplicate blocking issue de-duplicated", () => {
		const nodes = [
			addedEvent("dup", 99, "Same blocker", "OPEN"),
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "dup", number: 99, title: "Same blocker", state: "OPEN" },
			},
		];
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes } } } },
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blocked, true);
		assert.strictEqual(result.blockers.length, 1);
		assert.strictEqual(result.blockers[0].number, 99);
	});

	it("unknown state → treated as blocking", () => {
		const node: GhTimelineNode = {
			__typename: "BlockedByAddedEvent",
			blockingIssue: { id: "x", number: 1, title: "No state", state: "UNKNOWN" },
		};
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes: [node] } } } },
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blocked, true);
		assert.strictEqual(result.blockers[0].state, "UNKNOWN");
	});

	// ── BlockerInfo shape ──────────────────────────────────────────

	it("BlockerInfo has correct fields", () => {
		const response: GhTimelineResponse = {
			data: {
				repository: {
					issue: {
						timelineItems: {
							nodes: [addedEvent("z", 50, "Test title", "OPEN")],
						},
					},
				},
			},
		};
		const blocker = parseTimelineResponse(response).blockers[0];
		assert.strictEqual(blocker.number, 50);
		assert.strictEqual(blocker.title, "Test title");
		assert.strictEqual(blocker.type, "issue");
		assert.strictEqual(blocker.state, "OPEN");
	});

	// ── Multiple blockers ──────────────────────────────────────────

	it("multiple blocking issues", () => {
		const nodes = [
			addedEvent("a", 1, "First", "OPEN"),
			addedEvent("b", 2, "Second", "OPEN"),
			addedEvent("c", 3, "Third", "OPEN"),
		];
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes } } } },
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blocked, true);
		assert.strictEqual(result.blockers.length, 3);
	});

	it("some connected, some removed, some resolved → only unresolved active remain", () => {
		const nodes = [
			addedEvent("a", 1, "Will be removed", "OPEN"),
			removedEvent("a", 1, "Will be removed", "OPEN"),
			addedEvent("b", 2, "Already closed", "CLOSED"),
			addedEvent("c", 3, "Still open", "OPEN"),
			addedEvent("d", 4, "Removed and re-added", "OPEN"),
			removedEvent("d", 4, "Removed and re-added", "OPEN"),
			addedEvent("d", 4, "Removed and re-added", "OPEN"),
		];
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes } } } },
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blocked, true);
		const nums = result.blockers.map((b) => b.number).sort();
		// Only #3 (still open) and #4 (last event is Added) should remain
		assert.deepStrictEqual(nums, [3, 4]);
	});

	it("empty string title preserved", () => {
		const node: GhTimelineNode = {
			__typename: "BlockedByAddedEvent",
			blockingIssue: { id: "x", number: 1, title: "", state: "OPEN" },
		};
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes: [node] } } } },
		};
		const result = parseTimelineResponse(response);
		assert.strictEqual(result.blockers[0].title, "");
	});
});
