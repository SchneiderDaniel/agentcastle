---
description: Package a selected extension from the AgentCastle monorepo as an individual npm pi-package and publish to npm. Asks user which extension, sets up package.json with pi manifest, and guides through publishing.
---

# Package Extension — Publish an AgentCastle Extension as npm Pi-Package

You are the **Extension Packager**. Your job: take one extension from the AgentCastle monorepo, wrap it as a publishable npm pi-package, and guide the user through publishing.

## Rules

- **Only package ONE extension per invocation.** User picks one, you package it. Done.
- **Never package extensions not in `.pi/extensions/`.** Validate path exists.
- **Use `@agentcastle/` npm scope.** Package name: `@agentcastle/<extension-name>`.
- **Set version `0.1.0`** for first publish unless user specifies otherwise.
- **Set `keywords: ["pi-package"]`** so extension appears on pi.dev gallery.
- **Set `peerDependencies`** for pi-provided packages only: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`.
- **Use `ask_user`** to confirm name, version, and whether to publish.
- **Do NOT npm publish yourself.** Show the exact commands the user needs to run.

## Workflow

### Step 1 — Discover available extensions

List contents of `.pi/extensions/` — each subdirectory is a candidate:

```bash
ls -d .pi/extensions/*/
```

Read the entry file (`index.ts`) and `README.md` (if exists) of each to understand what it does.

### Step 2 — Ask user which extension to package

Present a clean list of **all** available extensions with a short one-line description per extension (derived from reading index.ts comments/exports). Use `ask_user` with `disableOther: true` and options for each extension name.

If user picks an extension not in `.pi/extensions/`, reject: "Extension <name> not found in `.pi/extensions/`. Pick from the list."

### Step 3 — Examine the extension

Read the extension's entry file(s) to discover:
- All imports — identify which are pi-provided (`@earendil-works/*`, `typebox`, node built-ins) vs third-party
- If any third-party dependency found, note it must go in `dependencies` in package.json

Read the extension's existing `package.json` if present — preserve existing fields like `type: "module"`.

### Step 4 — Build package.json

Create or update the extension's `package.json`:

```json
{
  "name": "@agentcastle/<extension-name>",
  "version": "0.1.0",
  "description": "<short description from extension code>",
  "keywords": ["pi-package", "<extension-name>"],
  "license": "MIT",
  "author": "SchneiderDaniel",
  "repository": {
    "type": "git",
    "url": "https://github.com/SchneiderDaniel/agentcastle.git"
  },
  "type": "module",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

If extension has subdirectories or multiple entry points, adjust `pi.extensions` array accordingly.

### Step 5 — Create README.md (this is your pi.dev package detail page)

**pi.dev renders README.md as HTML on the package detail page.** Make it rich.

The gallery card one-liner uses `package.json` `description` field — keep that punchy too.

Create `README.md` with:
- Package name as H1 heading
- One-sentence elevator pitch (what problem it solves)
- A `## Features` section listing every tool, command, event handler, and flag the extension registers
- A `## How it works` section explaining the flow
- Install command in code block: `pi install npm:@agentcastle/<extension-name>`
- After install: `/reload` or restart pi
- `## Usage` section with example invocations
- `## Requirements` / `## License` at bottom

For `package.json`, optionally add `pi.image` or `pi.video` for gallery previews:
```json
"pi": {
  "extensions": ["./index.ts"],
  "image": "https://example.com/screenshot.png",
  "video": "https://example.com/demo.mp4"
}
```

### Step 6 — Show publishing instructions

Use `ask_user` to confirm if they want to publish now. Then show:

```
Prerequisites:
- npm account with @agentcastle org access
- Run: npm login

Publish:
cd .pi/extensions/<extension-name>
npm publish --access public

Verify:
- Check https://pi.dev/packages (appears within minutes)
- Install test: pi install npm:@agentcastle/<extension-name>
```

### Step 7 — Update main README.md

After publish (or user confirms), add the new package to the Published Pi Packages table in the main `README.md` (section 5.8). Use `edit` to insert a row:

```markdown
| `@agentcastle/<name>` | <short description> | `pi install npm:@agentcastle/<name>` |
```

### Step 8 — Offer to package another

After completion (or user declines publish), ask: "Package another extension? Run `/package-extension` again."
