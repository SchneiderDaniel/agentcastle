---
name: extension-spec
description: Designs pi extensions — new or refactoring — with full PRD, TypeScript best practices, anti-pattern audit, and migration plan. Use when creating, updating, or refactoring a pi extension.
---

# Extension Spec Skill

Design pi extensions following pi docs, TypeScript best practices, and anti-pattern audit.

## Setup

No setup needed. All reference docs included.

## How It Works

1. Load full spec: `read references/extension-spec.md`
2. Follow phases — ANALYZE SCOPE → RESEARCH → ARCHITECTURE → PRD → DELIVERY
3. Check pi docs: `read /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
4. Check examples: `ls /usr/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`
5. List existing extensions: `ls .pi/extensions/*.ts .pi/extensions/*/index.ts 2>/dev/null`

## Mode Detection

See `references/extension-spec.md` Mode Detection table.

| Input                                              | Mode     | Action                                                  |
| -------------------------------------------------- | -------- | ------------------------------------------------------- |
| `refactor:<name>` / `update:<name>` / `fix:<name>` | Refactor | Read existing extension, audit, produce PRD + migration |
| `$@` file in `.pi/extensions/`                     | Refactor | Same — read, audit, produce PRD                         |
| Other / no arg                                     | New      | Analyze, research, design from scratch                  |

## Rules

- **Designer not coder** — PRD first, code second
- **Research before propose** — pi docs, existing extensions, best practices
- **PRD standalone** — not a diff, not snippets
- **No `any` types, no `details: {}`, no module-level mutable state**
- **Files < 300 lines, entry < 100 lines**
- **Use `pi.exec()`, `ctx.sessionManager`, `ctx.ui.*`, `pi.sendUserMessage()`, `ctx.cwd`**
- **Refactor: read existing first, preserve external contracts**

## Output

- Write PRD to `.pi/specs/<name>-prd.md`
- Offer to implement or create GitHub issue
- If `$@ --implement`: code after PRD

## Reference

See [full spec](references/extension-spec.md) for:

- Complete PRD template
- Anti-pattern checklist (C1-C14, M1-M8, R1-R6, P1-P24)
- Phase details (0-4)
- Security considerations
- Priority matrix (P0-P3)
