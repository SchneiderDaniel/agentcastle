# agentcastle

This is a project scaffold for agentcastle.

## Project Structure

- `opencode.json` — OpenCode project configuration
- `AGENTS.md` — Project rules
- `.opencode/` — OpenCode project directory
  - `agents/` — Custom agent definitions
  - `commands/` — Custom commands
  - `skills/` — Reusable skill definitions
  - `tools/` — Custom tools
  - `themes/` — Custom UI themes
  - `plugins/` — Plugins
  - `modes/` — Custom modes

## Conventions

- Skills live in `.opencode/skills/<name>/SKILL.md`
- Agents can be defined as markdown files in `.opencode/agents/`

## Skills

- `skill-creator` — Guides the agent to create, edit, and manage OpenCode SKILL.md definitions (`.opencode/skills/skill-creator/SKILL.md`)

## Tools

The `skill` tool loads a skill by name. Use it when a task matches a skill's description.
