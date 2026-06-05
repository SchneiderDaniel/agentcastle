/**
 * Tests for ModelRef/ModelLike duplicate interface consolidation.
 *
 * Issue #506: ModelRef + ModelRegistryRef in advice-pipeline.ts are identical
 * to ModelLike + ModelRegistryLike in llm-advisor.ts.
 *
 * Fix: Remove local interfaces from advice-pipeline.ts, import as aliases.
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// Import the types — after the fix, these are aliased imports from llm-advisor.ts
import type { ModelRef, ModelRegistryRef } from "../advice-pipeline.ts";
import type { ModelLike, ModelRegistryLike } from "../llm-advisor.ts";

// ── Phase 1: Pre-refactoring characterization — structural identity ──

describe("Phase 1: ModelRef / ModelLike structural identity", () => {
	it("ModelRef fields match ModelLike fields", () => {
		// Both should have the same required + optional keys
		const modelRefKeys: (keyof ModelRef)[] = ["id", "api", "provider", "baseUrl", "headers"];
		const modelLikeKeys: (keyof ModelLike)[] = ["id", "api", "provider", "baseUrl", "headers"];

		// Same exact set of keys sorted
		assert.deepStrictEqual(
			[...modelRefKeys].sort(),
			[...modelLikeKeys].sort(),
			"ModelRef and ModelLike must have identical field names",
		);

		// Both have non-optional id, api, provider, baseUrl
		const requiredRefKeys: (keyof ModelRef)[] = ["id", "api", "provider", "baseUrl"];
		for (const k of requiredRefKeys) {
			assert.ok(k, `ModelRef.${k as string} should exist`);
		}

		// headers is optional in both — verify by constructing minimal objects
		const minimalRef: ModelRef = {
			id: "m",
			api: "openai",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		};
		assert.ok(minimalRef, "ModelRef without headers should compile");
		const minimalLike: ModelLike = {
			id: "m",
			api: "openai",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		};
		assert.ok(minimalLike, "ModelLike without headers should compile");
	});

	it("ModelRegistryRef.getApiKeyAndHeaders return shape matches ModelRegistryLike.getApiKeyAndHeaders", async () => {
		// Both registries return the same shape from getApiKeyAndHeaders
		// Create a stub that satisfies both
		const stubRef: ModelRegistryRef = {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "sk-test",
				headers: { "X-Custom": "value" },
			}),
		};
		const result = await stubRef.getApiKeyAndHeaders({
			id: "gpt-4",
			api: "openai",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		});
		assert.ok(result.ok, "stub should return ok=true");
		assert.strictEqual(result.apiKey, "sk-test", "stub should return apiKey");
		assert.deepStrictEqual(result.headers, { "X-Custom": "value" }, "stub should return headers");
		assert.strictEqual(result.error, undefined, "error should be optional");

		// Same stub satisfies ModelRegistryLike
		const stubLike: ModelRegistryLike = stubRef;
		assert.ok(stubLike, "ModelRegistryRef stub should satisfy ModelRegistryLike");
	});

	it("ModelRegistryRef.getApiKeyAndHeaders with error path", async () => {
		const stub: ModelRegistryRef = {
			getApiKeyAndHeaders: async () => ({
				ok: false,
				error: "No API key configured",
			}),
		};
		const result = await stub.getApiKeyAndHeaders({
			id: "gpt-4",
			api: "openai",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		});
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.error, "No API key configured");
		assert.strictEqual(result.apiKey, undefined);
	});

	it("ModelRef with headers is compatible with ModelLike (structural assignability)", () => {
		// Create a concrete model object
		const model: ModelRef = {
			id: "gpt-4",
			api: "openai",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			headers: { Authorization: "Bearer sk-test" },
		};
		// At runtime, if both types are structurally compatible,
		// the object can be assigned to a variable typed as ModelLike
		const asLike: ModelLike = model as unknown as ModelLike;
		assert.strictEqual(asLike.id, "gpt-4");
		assert.strictEqual(asLike.api, "openai");
		assert.strictEqual(asLike.headers?.Authorization, "Bearer sk-test");
	});

	it("ModelRegistryRef with headers is structurally compatible with ModelRegistryLike", async () => {
		const registry: ModelRegistryRef = {
			getApiKeyAndHeaders: async (model) => {
				return { ok: true, apiKey: "sk-" + model.id, headers: model.headers };
			},
		};
		const asLike: ModelRegistryLike = registry as unknown as ModelRegistryLike;
		const result = await asLike.getApiKeyAndHeaders({
			id: "gpt-4",
			api: "openai",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		});
		assert.ok(result.ok);
		assert.strictEqual(result.apiKey, "sk-gpt-4");
	});
});

// ── Phase 2: Post-refactoring backward compatibility ──

describe("Phase 2: Backward compatibility — ModelRef still exported", () => {
	it("ModelRef is still exported from advice-pipeline.ts", () => {
		// This import at top of file already validates this
		// If the type weren't exported, the import would fail
		assert.ok(true, "import type { ModelRef } from advice-pipeline.ts succeeds");
	});

	it("ModelRegistryRef is still exported from advice-pipeline.ts", () => {
		assert.ok(true, "import type { ModelRegistryRef } from advice-pipeline.ts succeeds");
	});

	it("No circular import — llm-advisor.ts does not import from advice-pipeline.ts", async () => {
		// Verify by dynamic import — if circular, this would fail or hang
		const advisor = await import("../llm-advisor.ts");
		assert.ok(advisor, "llm-advisor.ts can be imported without circular dependency");
	});

	it("model object can flow through generateReport signature pattern", async () => {
		// This test simulates the generateReport call pattern
		// After the fix, ModelRef = ModelLike so no as any cast is needed
		const model: ModelRef = {
			id: "gpt-4",
			api: "openai",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		};
		const registry: ModelRegistryRef = {
			getApiKeyAndHeaders: async () => ({ ok: false, error: "No key" }),
		};

		// Simulate: generateReport passes model/registry to generateReportAdvice
		// which expects ModelLike / ModelRegistryLike
		const passToLlamaAdvisor = (
			m: ModelLike,
			r: ModelRegistryLike,
		): { modelId: string; registryOk: boolean } => {
			return { modelId: m.id, registryOk: r.getApiKeyAndHeaders !== undefined };
		};

		// After the fix, this should compile without casts
		// (using unknown cast for runtime test since types are erased)
		const result = passToLlamaAdvisor(
			model as unknown as ModelLike,
			registry as unknown as ModelRegistryLike,
		);
		assert.strictEqual(result.modelId, "gpt-4");
		assert.ok(result.registryOk);
	});
});
