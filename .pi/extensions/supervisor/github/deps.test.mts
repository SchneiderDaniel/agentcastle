// ─── Tests: github/deps.ts — dependency gate ─────────────────────
// Tests for checkBlockedByDependencies.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkBlockedByDependencies } from "./deps.ts";
import type { GhTimelineResponse } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────

function createMockPi(ghResult: { code: number; stdout: string; stderr: string }): ExtensionAPI {
	return {
		exec: async () => ghResult,
	} as unknown as ExtensionAPI;
}

// ─── Tests: checkBlockedByDependencies() ──────────────────────────

describe("checkBlockedByDependencies()", () => {
	it("returns blocked=false when no timeline events exist", async () => {
		const response: GhTimelineResponse = {
			data: { repository: { issue: { timelineItems: { nodes: [] } } } },
		};
		const pi = createMockPi({ code: 0, stdout: JSON.stringify(response), stderr: "" });
		const result = await checkBlockedByDependencies(pi, 123, "owner/repo");
		assert.equal(result.blocked, false);
		assert.deepEqual(result.blockers, []);
	});

	it("returns blocked=false when blocking issues are closed", async () => {
		const response: GhTimelineResponse = {
			data: {
				repository: {
					issue: {
						timelineItems: {
							nodes: [
								{
									__typename: "BlockedByAddedEvent",
									blockingIssue: {
										id: "i1",
										number: 456,
										title: "Blocking issue",
										state: "CLOSED",
									},
								},
							],
						},
					},
				},
			},
		};
		const pi = createMockPi({ code: 0, stdout: JSON.stringify(response), stderr: "" });
		const result = await checkBlockedByDependencies(pi, 123, "owner/repo");
		assert.equal(result.blocked, false);
		assert.equal(result.blockers.length, 0);
	});

	it("returns blocked=true with blocking issues when open blockers exist", async () => {
		const response: GhTimelineResponse = {
			data: {
				repository: {
					issue: {
						timelineItems: {
							nodes: [
								{
									__typename: "BlockedByAddedEvent",
									blockingIssue: { id: "i1", number: 456, title: "Open blocker", state: "OPEN" },
								},
							],
						},
					},
				},
			},
		};
		const pi = createMockPi({ code: 0, stdout: JSON.stringify(response), stderr: "" });
		const result = await checkBlockedByDependencies(pi, 123, "owner/repo");
		assert.equal(result.blocked, true);
		assert.equal(result.blockers.length, 1);
		assert.equal(result.blockers[0].number, 456);
		assert.equal(result.blockers[0].title, "Open blocker");
	});

	it("handles removed events — ignores issues that had BlockedByRemovedEvent after BlockedByAddedEvent", async () => {
		const response: GhTimelineResponse = {
			data: {
				repository: {
					issue: {
						timelineItems: {
							nodes: [
								{
									__typename: "BlockedByAddedEvent",
									blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
								},
								{
									__typename: "BlockedByRemovedEvent",
									blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
								},
							],
						},
					},
				},
			},
		};
		const pi = createMockPi({ code: 0, stdout: JSON.stringify(response), stderr: "" });
		const result = await checkBlockedByDependencies(pi, 123, "owner/repo");
		assert.equal(result.blocked, false, "last event was removed, so not blocked");
		assert.equal(result.blockers.length, 0);
	});

	it("throws on invalid repo format", async () => {
		const pi = createMockPi({ code: 0, stdout: "{}", stderr: "" });
		await assert.rejects(
			() => checkBlockedByDependencies(pi, 123, "invalid-repo"),
			/Invalid repo format/,
		);
	});

	it("throws on GraphQL errors", async () => {
		const response = { errors: [{ message: "Not authorized" }] };
		const pi = createMockPi({ code: 0, stdout: JSON.stringify(response), stderr: "" });
		await assert.rejects(
			() => checkBlockedByDependencies(pi, 123, "owner/repo"),
			/GitHub GraphQL error: Not authorized/,
		);
	});
});
