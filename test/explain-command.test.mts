/**
 * Tests for context-info/explain-command.ts — createExplainCommand factory
 *
 * Tests the factory function with mock list function and verifies
 * widget content rendering for edge cases.
 *
 * Run with:
 *   node --experimental-strip-types --test test/explain-command.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createExplainCommand } from "../.pi/extensions/context-info/explain-command.ts";

// ---------------------------------------------------------------------------
// Mock types matching ExtensionAPI subset used by the factory
// ---------------------------------------------------------------------------

interface MockCommand {
	name: string;
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface MockWidget {
	render: (width: number) => string[];
	invalidate: () => void;
}

function createMockPi(): {
	commands: MockCommand[];
	notifications: Array<{ message: string; type: string }>;
	widgets: Map<string, MockWidget>;
	pi: any;
	triggerCommand: (name: string, args?: string) => Promise<void>;
} {
	const commands: MockCommand[] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const widgets = new Map<string, MockWidget>();

	const mockCtx = {
		ui: {
			notify: (message: string, type: string) => {
				notifications.push({ message, type });
			},
			setWidget: (key: string, factoryOrUndefined: any) => {
				if (factoryOrUndefined === undefined) {
					widgets.delete(key);
				} else {
					// Factory receives (tui, theme) and returns { render, invalidate }
					const mockTui = {};
					const mockTheme = {
						fg: (color: string, s: string) => `<${color}>${s}</${color}>`,
					};
					const widget = factoryOrUndefined(mockTui, mockTheme);
					widgets.set(key, widget);
				}
			},
		},
	};

	const mockPi = {
		registerCommand: (name: string, opts: Omit<MockCommand, "name">) => {
			commands.push({ name, ...opts } as MockCommand);
		},
	};

	async function triggerCommand(name: string, _args = "") {
		const cmd = commands.find((c) => c.name === name);
		if (cmd) {
			await cmd.handler(_args, mockCtx);
		}
	}

	return {
		commands,
		notifications,
		widgets,
		pi: mockPi,
		triggerCommand,
	};
}

// ---------------------------------------------------------------------------
// Tests: factory registers command with correct metadata
// ---------------------------------------------------------------------------

describe("createExplainCommand — registration", () => {
	it("registers a command with the given name", () => {
		const { pi, commands } = createMockPi();
		createExplainCommand(pi, "explain-test", "test", () => []);
		assert.strictEqual(commands.length, 1);
		assert.strictEqual(commands[0]!.name, "explain-test");
	});

	it("registers with correct description", () => {
		const { pi, commands } = createMockPi();
		createExplainCommand(pi, "explain-widget", "widget", () => []);
		assert.strictEqual(
			commands[0]!.description,
			"List all project-local widgets with descriptions",
		);
	});

	it("registers with correct description for commands", () => {
		const { pi, commands } = createMockPi();
		createExplainCommand(pi, "explain-foo", "foo", () => []);
		assert.strictEqual(commands[0]!.description, "List all project-local foos with descriptions");
	});
});

// ---------------------------------------------------------------------------
// Tests: empty list behavior
// ---------------------------------------------------------------------------

describe("createExplainCommand — empty list", () => {
	it("shows notification when list is empty", async () => {
		const { pi, notifications, triggerCommand } = createMockPi();
		createExplainCommand(pi, "explain-empty", "item", () => []);
		await triggerCommand("explain-empty");
		assert.strictEqual(notifications.length, 1);
		assert.strictEqual(notifications[0]!.message, "No items found");
		assert.strictEqual(notifications[0]!.type, "info");
	});

	it("does not set widget when list is empty", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		createExplainCommand(pi, "explain-empty", "item", () => []);
		await triggerCommand("explain-empty");
		assert.strictEqual(widgets.size, 0);
	});
});

// ---------------------------------------------------------------------------
// Tests: widget content rendering
// ---------------------------------------------------------------------------

describe("createExplainCommand — widget content", () => {
	it("renders items with accent name and dim wrapped description", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		const items = [
			{ name: "alpha", description: "First item" },
			{ name: "beta", description: "Second item with longer description" },
		];
		createExplainCommand(pi, "explain-items", "item", () => items);
		await triggerCommand("explain-items");

		assert.ok(widgets.has("explain-items"), "widget should be set");

		const widget = widgets.get("explain-items")!;
		const rendered = widget.render(80);

		// Check accent name lines
		assert.ok(
			rendered.some((l) => l.includes("<accent>") && l.includes("alpha")),
			"should have alpha with accent",
		);
		assert.ok(
			rendered.some((l) => l.includes("<accent>") && l.includes("beta")),
			"should have beta with accent",
		);

		// Check dim description lines
		assert.ok(
			rendered.some((l) => l.includes("<dim>") && l.includes("First item")),
			"should have alpha description in dim",
		);
		assert.ok(
			rendered.some((l) => l.includes("<dim>") && l.includes("Second item")),
			"should have beta description in dim",
		);

		// Check footer line
		assert.ok(
			rendered.some((l) => l.includes("2") && l.includes("items")),
			"should have count in footer",
		);
	});

	it("renders items with null description as '(no description)'", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		const items = [{ name: "nodesc", description: null }];
		createExplainCommand(pi, "explain-null", "item", () => items);
		await triggerCommand("explain-null");

		const widget = widgets.get("explain-null")!;
		const rendered = widget.render(80);
		assert.ok(
			rendered.some((l) => l.includes("(no description)")),
			"should show no description fallback",
		);
	});

	it("renders items with undefined description as '(no description)'", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		const items = [{ name: "undef" }];
		createExplainCommand(pi, "explain-undef", "item", () => items);
		await triggerCommand("explain-undef");

		const widget = widgets.get("explain-undef")!;
		const rendered = widget.render(80);
		assert.ok(
			rendered.some((l) => l.includes("(no description)")),
			"should show no description fallback for undefined",
		);
	});

	it("uses only first line of multi-line descriptions", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		const items = [{ name: "multiline", description: "First line\nSecond line\nThird line" }];
		createExplainCommand(pi, "explain-multi", "item", () => items);
		await triggerCommand("explain-multi");

		const widget = widgets.get("explain-multi")!;
		const rendered = widget.render(80);
		assert.ok(
			rendered.some((l) => l.includes("First line")),
			"should show first line",
		);
		assert.ok(!rendered.some((l) => l.includes("Second line")), "should NOT show second line");
		assert.ok(!rendered.some((l) => l.includes("Third line")), "should NOT show third line");
	});

	it("word-wraps long descriptions", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		const longDesc = "A".repeat(30) + " B".repeat(30);
		const items = [{ name: "long", description: longDesc }];
		createExplainCommand(pi, "explain-long", "item", () => items);
		await triggerCommand("explain-long");

		const widget = widgets.get("explain-long")!;
		// Narrow width to force wrapping
		const rendered = widget.render(40);
		assert.ok(rendered.length > 3, "long descriptions should wrap to multiple lines");
	});

	it("includes footer with correct count", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		const items = [
			{ name: "a", description: "A" },
			{ name: "b", description: "B" },
			{ name: "c", description: "C" },
		];
		createExplainCommand(pi, "explain-three", "item", () => items);
		await triggerCommand("explain-three");

		const widget = widgets.get("explain-three")!;
		const rendered = widget.render(80);
		// Footer line contains dim-wrapped ─ markers, count, and title
		const footerLine = rendered.find((l) => l.includes("3") && l.includes("items"));
		assert.ok(footerLine, "should have footer line with count and title");
		assert.ok(footerLine!.includes("─"), "footer should have dash markers");
	});

	it("renders multiple items in order", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		const items = [
			{ name: "zulu", description: "Z item" },
			{ name: "alpha", description: "A item" },
			{ name: "beta", description: "B item" },
		];
		createExplainCommand(pi, "explain-order", "item", () => items);
		await triggerCommand("explain-order");

		const widget = widgets.get("explain-order")!;
		const rendered = widget.render(80);

		// Items should appear in the order the list function returns
		const accentLines = rendered.filter((l) => l.includes("<accent>"));
		assert.ok(accentLines[0]!.includes("zulu"), "first item should be zulu");
		assert.ok(accentLines[1]!.includes("alpha"), "second item should be alpha");
		assert.ok(accentLines[2]!.includes("beta"), "third item should be beta");
	});
});

// ---------------------------------------------------------------------------
// Tests: ExtensionMeta compatibility (has optional error field)
// ---------------------------------------------------------------------------

describe("createExplainCommand — ExtensionMeta compatibility", () => {
	it("handles ExtensionMeta with error property", async () => {
		const { pi, widgets, triggerCommand } = createMockPi();
		const items = [
			{ name: "good-ext", filePath: "/ext/good", description: "Works fine" },
			{ name: "bad-ext", filePath: "/ext/bad", description: null, error: "Failed to load" },
		];
		createExplainCommand(pi, "explain-exts", "extension", () => items);
		await triggerCommand("explain-exts");

		const widget = widgets.get("explain-exts")!;
		const rendered = widget.render(80);

		// Error items show their message in description area
		assert.ok(
			rendered.some((l) => l.includes("Works fine")),
			"good ext description shown",
		);
		assert.ok(
			rendered.some((l) => l.includes("error: Failed to load")),
			"bad ext error shown",
		);
	});

	it("handles empty ExtensionMeta list", async () => {
		const { pi, notifications, triggerCommand } = createMockPi();
		createExplainCommand(pi, "explain-exts", "extension", () => []);
		await triggerCommand("explain-exts");
		assert.strictEqual(notifications.length, 1);
		assert.strictEqual(notifications[0]!.message, "No extensions found");
	});
});

// ---------------------------------------------------------------------------
// Tests: Command registration returns correct metadata
// ---------------------------------------------------------------------------

describe("createExplainCommand — command description matches title", () => {
	it("explain-extensions uses title 'extension'", () => {
		const { pi, commands } = createMockPi();
		createExplainCommand(pi, "explain-extensions", "extension", () => []);
		assert.ok(commands[0]!.description.includes("extensions"));
		assert.ok(commands[0]!.description.includes("local"));
	});

	it("explain-prompts uses title 'prompt'", () => {
		const { pi, commands } = createMockPi();
		createExplainCommand(pi, "explain-prompts", "prompt", () => []);
		assert.ok(commands[0]!.description.includes("prompts"));
	});

	it("explain-skills uses title 'skill'", () => {
		const { pi, commands } = createMockPi();
		createExplainCommand(pi, "explain-skills", "skill", () => []);
		assert.ok(commands[0]!.description.includes("skills"));
	});
});
