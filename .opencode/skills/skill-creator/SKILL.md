---
name: skill-creator
description: Guides the agent to create, edit, and manage OpenCode SKILL.md definitions with proper YAML frontmatter, naming conventions, and directory structure
license: MIT
compatibility: opencode
metadata:
  source: anthropic
  version: 1.0.0
---

## Overview

You are a skill creation specialist. You help create reusable OpenCode skills that follow the official SKILL.md specification.

## Naming Rules

- Must be 1–64 characters
- Lowercase alphanumeric with single hyphen separators
- Must not start or end with `-`
- Must not contain consecutive `--`
- Must match the directory name containing SKILL.md
- Regex: `^[a-z0-9]+(-[a-z0-9]+)*$`

## SKILL.md Structure

Each SKILL.md must start with YAML frontmatter:

```yaml
---
name: <skill-name>
description: <short description, 1-1024 chars>
license: <SPDX identifier> (optional)
compatibility: opencode (optional)
metadata:
  key: value (optional, string-to-string map)
---
```

## Placement

Place skills in one of these locations:
- `.opencode/skills/<name>/SKILL.md` (project)
- `~/.config/opencode/skills/<name>/SKILL.md` (global)
- `.claude/skills/<name>/SKILL.md` (Claude Code compatible, project)
- `~/.claude/skills/<name>/SKILL.md` (Claude Code compatible, global)

## When Creating a Skill

1. Ask the user what task the skill should automate
2. Propose a skill name following the naming rules
3. Create the directory `.opencode/skills/<name>/`
4. Write `SKILL.md` with proper frontmatter
5. Include clear markdown body with "What I do" and "When to use me" sections

## When Editing a Skill

1. Read the existing SKILL.md
2. Validate the frontmatter
3. Make targeted edits preserving the structure

## When Deleting a Skill

1. Remove the skill directory
2. Confirm no other files reference it
