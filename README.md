# Agentcastle: The Pi Stack

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.74.0-6e3bf0)](https://pi.dev)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Secure, local-first AI development environment.**
WSL (Ubuntu) + Zed + Git Worktrees + Pi AI — sandboxed execution, real-time feedback.

---

## What is this?

Agentcastle is a pre-configured AI coding harness that gives the [Pi coding agent](https://pi.dev) a full toolchain:

- **Web crawling** — Three-tier fallback: local Chromium → Apify cloud → HTTP
- **Session logging** — Every session saved as LLM-optimized markdown for later analysis
- **Extensions-based** — Secure pi extensions, no MCP servers

All components run locally. No code leaves your machine (except LLM API calls to your provider).

---

## What's in this repo vs what you set up

This repository contains the **configuration and extensions**. You clone it and get a ready-to-use AI harness. But you still need to install the **system-level tools** once on your machine.

### 📦 Already in this repository

| File/Path                           | What it is                              |
| ----------------------------------- | --------------------------------------- |
| `.pi/extensions/caveman.ts`              | Token-efficient communication protocol    |
| `.pi/extensions/crawl4ai.ts`             | Three-tier web crawler                    |
| `.pi/extensions/session-logger.ts`       | Session logging to markdown               |
| `.pi/extensions/ask-user.ts`             | Interactive multiple-choice questions     |
| `.pi/extensions/format-on-save.ts`       | Auto-format TypeScript/JS with Prettier   |
| `.pi/extensions/supervisor.ts`           | Kanban-driven multi-agent orchestration   |
| `.pi/agents/architect.md`               | Architect agent system prompt             |
| `.pi/agents/developer.md`               | Developer agent system prompt             |
| `flask_blogs/`                            | Submodule: Flask blog apps (hippocooking, planhead, sudoku) |
| `.pi/agents/auditor.md`                 | Auditor agent system prompt               |
| `.pi/agents/test-designer.md`           | TestDesigner agent system prompt          |
| `.pi/settings.json`                      | Provider + supervisor config              |
| `.pi/prompts/issue-cutter.md`            | Epic → sub-issues with layer labels       |
| `.pi/prompts/issue-refinement.md`        | Socratic interview + MC refinement        |
| `AGENTS.md`                              | Caveman protocol (active every session)   |
| `package.json`                           | Project metadata + test script            |
| `test/session-logger.test.mts`           | Session logger test                       |
| `test/supervisor-extensions.test.mts`    | Supervisor extension resolution tests     |
| `.gitmodules`                             | Submodule configuration                   |

### 🔧 You install once on your machine

| Tool                            | Why                                   |
| ------------------------------- | ------------------------------------- |
| Node.js ≥22 + npm               | Pi runtime                            |
| Python 3.10+ + venv + pip       | crawl4ai local web crawler            |
| GitHub CLI (gh)                 | Git operations from Pi                |
| `@earendil-works/pi-coding-agent` | The agent itself (global npm install) |
| `@ast-grep/cli`                  | AST-based code search (`structural_search` tool) |
| `~/.agent_env` file             | API keys (Apify token, etc.)          |
| `~/.bashrc` auto-start block    | Docker + env loading on WSL boot      |

> **Rule of thumb:** Sections marked 📦 describe files you already have after cloning. Sections marked 🔧 are commands you run once on your machine.

---

## Features

| Category            | Capability                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 🕷️ **Web Crawl**    | `web_crawl` tool: local crawl4ai (real Chromium) → Apify cloud actor → direct HTTP + regex extraction              |
| 📝 **Session Log**  | Full conversation + thinking blocks + tool calls saved as markdown + metadata JSON                                 |
| 🦴 **Caveman Mode** | Token-efficient communication via `AGENTS.md` — active in every session                                            |
| 📋 **SBOM**         | Full software bill of materials included in this README                                                            |
| 🤖 **Multi-Agent**  | Kanban-driven pipeline: Supervisor dispatches Architect → TestDesigner → Developer → Auditor in loop |
| 🧩 **Extensions**   | 6 extensions auto-discovered from `.pi/extensions/`. No config files, no MCP servers.                              |

---

## Quick Start

```bash
# 1. Install prerequisites (one-time, Ubuntu 24.04 LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip python3-venv jq unzip
sudo npm install -g @earendil-works/pi-coding-agent

# 2. Set your AI provider (one-time)
pi --provider opencode-go --api-key "your-key-here"

# 3. Start coding
pi
```

> **Expected output:** Pi TUI opens in your terminal. Type a prompt, press Enter. The agent thinks, uses tools, and responds.

---

## Table of Contents

- [What's in this repo vs what you set up](#whats-in-this-repo-vs-what-you-set-up)
- [🔧 Prerequisites](#prerequisites)
- [🔧 Installation & Setup](#installation--setup)
  - [GitHub CLI](#github-cli)
  - [Security & Environment](#security--environment)
  - [AI Provider Setup](#ai-provider-setup)
  - [Workspace & Git](#workspace--git)
    - [Submodule Configuration](#submodule-configuration)
    - [Developer Workflow with Submodules](#developer-workflow-with-submodules)
- [📦 Architecture](#architecture)
  - [Why extensions instead of MCP?](#why-extensions-instead-of-mcp)
  - [Extensions](#extensions)
  - [Agent Definitions](#agent-definitions)
- [📦 Daily Usage](#daily-usage)
  - [Project Setup (one-time)](#project-setup-one-time)
  - [Running the Supervisor](#running-the-supervisor)
  - [Workflows](#workflows)
  - [Context & Templates](#context--templates)
- [📦 Verification](#verification)
- [SBOM — Software Bill of Materials](#sbom---software-bill-of-materials)
- [FAQ / Troubleshooting](#faq--troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## 🔧 Prerequisites

> **Platform:** WSL2 with Ubuntu 24.04 LTS. macOS via Lima/Colima works with minor adjustments. Native Linux works directly.

### Base Runtimes

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip python3-venv jq unzip
sudo npm install -g npm@latest
```

### Pi Agent

```bash
sudo npm install -g @earendil-works/pi-coding-agent
```

### AST-grep (structural search)

AST-grep powers the `structural_search` tool — syntax-aware code search using Tree-sitter AST matching. Find function calls, class definitions, try/catch blocks, and method invocations without text-match noise from comments or strings.

```bash
sudo npm install -g @ast-grep/cli
```

Verify:

```bash
ast-grep --version   # expected: ast-grep 0.42.x
pi "Use the structural_search tool to find all console.log calls"
```

> **Note:** If `sudo npm install -g` fails with EACCES, set a user-owned global prefix:
> ```bash
> mkdir -p ~/.npm-global
> npm config set prefix ~/.npm-global
> echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
> source ~/.bashrc
> npm install -g @ast-grep/cli
> ```

---

## 🔧 Installation & Setup

### GitHub CLI

```bash
(type -p wget >/dev/null || sudo apt-get install wget -y)
sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update
sudo apt-get install gh -y

# Authenticate (web browser flow — no PAT, no key upload)
gh auth login
```

**Interactive prompts — answer as follows:**

| Prompt                                              | Your answer                      |
| --------------------------------------------------- | -------------------------------- |
| What account do you want to log into?               | **GitHub.com**                   |
| What is your preferred protocol for Git operations? | **SSH**                          |
| Upload your SSH public key to your GitHub account?  | **Skip** (key already on GitHub) |
| How would you like to authenticate GitHub CLI?      | **Login with a web browser**     |

`gh` prints a one-time code and a URL. Open the URL in your Windows browser, enter the code, confirm. Done.

```bash
gh auth status   # verify: should show "Logged in to github.com"
```

> `gh` stores an OAuth token for API operations (issues, PRs, repo management). Your SSH key in `~/.ssh/id_ed25519` handles `git push/pull` — separate, already working.

### Security & Environment

Pi's tools inherit environment variables from your terminal. Create `~/.agent_env` in your **home directory**:

```bash
export APIFY_TOKEN="apify_api_..."
```

> **How `web_crawl` uses APIFY_TOKEN:** The `web_crawl` tool tries local crawl4ai first (runs on host with auto-installed venv + Chromium deps). If that fails, it falls back to Apify's [`apify~website-content-crawler`](https://apify.com/apify/website-content-crawler) cloud actor. The last resort is a direct HTTP fetch with regex-based HTML→markdown conversion.
>
> **System requirements for local crawl4ai:** The extension auto-creates a Python venv at `.pi/crawl4ai-venv/` and downloads Chromium system libraries to `.pi/chromium-deps/` (no sudo). Requires: `python3`, `python3-venv`, `python3-pip`, `dpkg`, `apt-get`.

#### Auto-Start (WSL)

WSL doesn't auto-start background services. Append this to `~/.bashrc`:

```bash
cat << 'EOF' >> ~/.bashrc

# ==========================================
# AGENTCASTLE AUTO-START
# ==========================================
# Load API keys
if [ -f "$HOME/.agent_env" ]; then
    source "$HOME/.agent_env"
fi
# ==========================================
EOF

source ~/.bashrc
```

### AI Provider Setup

OpenCode Go is natively supported. Authenticate once:

```bash
pi --provider opencode-go --api-key "your-actual-api-key-here"
```

_(Once Pi launches, exit with `Ctrl+C` twice.)_

Set the default provider for this project in `.pi/settings.json`:

```json
{
  "defaultProvider": "opencode-go"
}
```

### Workspace & Git

- **Golden Rule:** All code lives in the Linux filesystem (`~/...`). Never use `/mnt/c/` for active dev work.
- Use SSH keys, not HTTPS, for GitHub access.

#### Bare Worktree Workflow

Run isolated Pi agents simultaneously in different Zed windows:

```bash
mkdir my-project && cd my-project
git clone --bare git@github.com:Username/repo.git .bare
echo "gitdir: ./.bare" > .git
echo ".env" >> .gitignore

# Add a feature branch worktree
git worktree add -b feature/logic feature-logic
cd feature-logic
```

#### Submodule Configuration

This repo uses git submodules. The following configs are set in the bare repo (shared across all worktrees):

```bash
# Automatically update submodules after a pull
git config submodule.recurse true

# Ensure submodule commits are pushed before pushing the main repo
git config push.recurseSubmodules check

# View submodule change history in git diff
git config diff.submodule log

# Keep a summary of submodule status in git status
git config status.submoduleSummary true
```

These prevent the "Three Pipe Problem" — submodule changes lost or uncommitted during multi-worktree workflows.

#### Developer Workflow with Submodules

When the Developer agent picks up an issue, it works on BOTH repos simultaneously using a matched-branch pattern:

```
## Issue #42 "Add user auth" → branch: worktree-git-issue-42-add-user-authentication

# 1. Create worktree for agentcastle
git worktree add ../worktree-git-issue-42-add-user-authentication main
cd ../worktree-git-issue-42-add-user-authentication

# 2. Init submodule (arrives in detached HEAD state — by design)
git submodule update --init --recursive

# 3. Create matching branch in submodule (required before editing)
cd flask_blogs
git checkout -b worktree-git-issue-42-add-user-authentication
git push -u origin worktree-git-issue-42-add-user-authentication
cd ..

# 4. Developer edits files in agentcastle AND/OR flask_blogs/

# 5. Push submodule FIRST (critical order)
cd flask_blogs
git add -A && git commit -m "feat(#42): Add user auth"
git push origin worktree-git-issue-42-add-user-authentication
cd ..

# 6. Push agentcastle (includes submodule pointer update)
git add -A
git commit -m "feat(#42): Add user auth"
git push origin worktree-git-issue-42-add-user-authentication
```

**Why submodule must be pushed first:** The agentcastle commit records a specific submodule SHA. If that SHA only exists in your local clone, teammates get `fatal: reference is not a tree` when they pull. The `push.recurseSubmodules check` config blocks the agentcastle push if submodule commits haven't been pushed yet — a safety net, not a replacement for correct order.

**Why submodules start in detached HEAD:** Git submodules pin a specific commit, not a branch. `git submodule update` checks out that exact commit. To make editable changes, you must explicitly checkout a branch — this is standard Git submodule behavior, not a bug.

**Result:** Two branches with the same name exist after the workflow:
- `agentcastle:worktree-git-issue-42-add-user-authentication` — agentcastle changes + optional submodule pointer bump
- `flask_blogs:worktree-git-issue-42-add-user-authentication` — submodule changes (only if submodule was edited)

**Disk usage note:** Each worktree clones submodules independently (under `.git/worktrees/<name>/modules/`). For large submodules, this duplicates disk usage. This is a known design tradeoff in Git's worktree implementation — submodule objects are not shared across worktrees.

#### Editor

Pi lives in Zed's integrated terminal (`Ctrl + ~`). Set the terminal profile to **WSL Ubuntu**.

---

## 📦 Architecture

```
┌──────────────────────────────────────────────┐
│  Zed Editor (WSL)                            │
│  ┌────────────────────────────────────────┐  │
│  │  Pi TUI (Terminal)                      │  │
│  │  ┌──────┐  ┌──────┐  ┌──────────────┐  │  │
│  │  │Exts  │  │AI Provider   │            │  │
│  │  │.pi/  │  │OpenCode Go   │            │  │
│  │  │exts/ │  │Anthropic/... │            │  │
│  │  └──┬───┘  └──────────────┘            │  │
│  │     │                                    │  │
│  └─────┼────────────────────────────────────┘  │
└────────┼───────────────────────────────────────┘
         │
    ┌────▼────────────┐
    │                 │
┌───▼──────────┐
│crawl4ai      │
│Python venv   │
│(host browser)│
│              │
└──────────────┘
```

**Key principle:** Web crawling runs on the host (network-only for crawl).

### Why extensions instead of MCP?

This project deliberately avoids the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). All tools are implemented as **pi extensions** — TypeScript files in `.pi/extensions/` that run inside the agent's Node.js runtime. No external MCP servers, no network-exposed tool endpoints, no separate processes.

**Two reasons: security and token efficiency.**

#### 🔒 Security

MCP servers introduce a new attack surface. OWASP now maintains the [MCP Top 10](https://owasp.org/www-project-mcp-top-10/) — a dedicated vulnerability list for MCP-based systems:

> **Bottom line:** MCP treats tool execution as a client-server protocol. Extensions treat it as a function call. No network layer = no network attack surface.

#### 📉 Token Efficiency

MCP servers expose tool descriptions via JSON-RPC introspection. Every tool's full JSON Schema is transmitted to the LLM on every request — including tools that are irrelevant to the current prompt.

Pi extensions use **prompt snippets** — concise one-line descriptions that replace full JSON Schema in the system prompt. The agent only sees the full schema when it actually calls the tool. This saves thousands of tokens per turn.

| Approach                        | Tokens per tool (system prompt) |
| ------------------------------- | ------------------------------- |
| MCP JSON-RPC (full JSON Schema) | ~300-800                        |
| Pi extension (prompt snippet)   | ~50-120                         |

> Combined with concise prompt snippets, the extension approach keeps the agent focused on your problem, not on parsing tool schemas.

### Extensions

Pi auto-discovers extensions from `.pi/extensions/` in your **project root**. No `.pi.config.ts` file needed. No `--extension` flag needed.

| Extension            | File                 | Purpose                                                                                                        |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Supervisor**       | `supervisor.ts`      | Kanban-driven multi-agent pipeline. Reads issue from GitHub project board, dispatches Architect → TestDesigner → Developer → Auditor in loop until Done. Registers `/supervisor <issue-number>` slash command. |
| **Web Crawler**      | `crawl4ai.ts`        | Three-tier web crawling: local crawl4ai → Apify cloud → HTTP fallback. Auto-installs venv + Chromium deps.     |
| **Session Logger**   | `session-logger.ts`  | Logs sessions to `.pi/sessions/<id>/session.md` + `metadata.json`. Toggle with `/session-logger`.              |
| **Caveman Protocol** | `caveman.ts`         | Token-efficient communication style. Active via `AGENTS.md`.                                                   |
| **Ask User**         | `ask-user.ts`        | Interactive multiple-choice picker for AI-to-user questions. Uses `ctx.ui.select()` with arrow-key navigation. |
| **Format on Save**   | `format-on-save.ts`  | Auto-formats TypeScript/JavaScript files with Prettier after write/edit operations. Keeps code style consistent without manual indentation fixes. |

### Agent Definitions

Agents are defined as Markdown files in `.pi/agents/` with YAML frontmatter specifying their name, description, allowed tools, and model. The supervisor reads these definitions at runtime.

| Agent              | File                   | Model                        | Tools                  |
| ------------------ | ---------------------- | ---------------------------- | ---------------------- |
| **Architect**      | `architect.md`         | `opencode-go/kimi-k2.6`      | `read`, `bash`         |
| **Developer**      | `developer.md`         | `opencode-go/deepseek-v4-pro` | `read`, `bash`, `write`, `edit` |
| **Auditor**        | `auditor.md`           | `opencode-go/glm-5.1`       | `read`, `bash`         |
| **TestDesigner**   | `test-designer.md`     | `opencode-go/deepseek-v4-flash` | `read`, `bash`        |

Each agent's system prompt defines its role in the Kanban pipeline. The supervisor reads the issue's status from the GitHub project board and dispatches the matching agent. See the [Supervisor workflow](#running-the-supervisor) below.

### Prompt Templates

User-invocable prompt expansions in `.pi/prompts/`. Type `/name` in the editor to expand a template.

| Template             | Description                                                                                                                                                                           | Config                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **issue-cutter**     | Split a refined epic into ordered, independently testable sub-issues. Each gets `refined` + layer label (e.g. `database`, `backend`). Auto-links children to parent epic via GraphQL. | Set `supervisor.repo` in `.pi/settings.json` to `owner/repo`. Invoke: `/issue-cutter <number>`     |
| **issue-refinement** | Grill an issue against the codebase, conduct Socratic interview via `ask_user` tool (≥3 MC options per question), replace body with concrete ACs.                                     | Set `supervisor.repo` in `.pi/settings.json` to `owner/repo`. Invoke: `/issue-refinement <number>` |

### Skills

Skills are expert procedural guides stored in `.pi/skills/`. The agent loads the full skill only when a task matches its trigger description — but **every skill's description is injected into the context window on every turn**, regardless of whether the skill is needed.

**Why we use skills sparingly:** Each skill description (~50-150 tokens) consumes the LLM's finite attention budget on every single turn. With many skills, these descriptions silently bloat the context window with low-signal tokens the model must attend to. This causes [**context rot**](https://docs.anthropic.com/en/docs/build-with-claude/context-windows): as token count grows, the model's recall and reasoning accuracy progressively degrade — a phenomenon documented in Anthropic's [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) and the ["Lost in the Middle"](https://arxiv.org/abs/2307.03172) paper (Liu et al., 2023).

> **Design decision:** Prefer pi **extensions** (`.pi/extensions/`) or manual **prompt templates** (`.pi/prompts/`) over skills. Extensions only expose concise prompt snippets (~50-120 tokens) instead of full JSON Schema. Prompt templates are lazy — only loaded when explicitly invoked. If a skill is truly unavoidable, keep its description minimal and its scope narrow.

Currently no skills installed.

#### Session Logger

```bash
/session-logger        # toggle on/off
/session-logger on     # force on
/session-logger off    # force off
```

Output:

```
.pi/sessions/<uuid>/
├── session.md      # Full conversation: messages, thinking, tool calls, compactions
└── metadata.json   # Token totals, cost, model/thinking changes, compaction count
```

---

## 📦 Daily Usage

### Project Setup (one-time)

Create a GitHub Project (v2) with Kanban statuses derived from your `.pi/settings.json`:

```bash
./scripts/setup-github-project.sh
```

The script:
- Reads `supervisor.statusMapping` from `.pi/settings.json`
- Prompts for a project name
- Creates a GitHub Project under the `supervisor.repo` owner
- Adds a `Workflow` single-select field with: **Backlog** → your custom statuses → **Done**
- Writes the new project number back to `.pi/settings.json`

Switch the project to **Board** layout in the browser and change **Group by** from the default `Status` to `Workflow` for a full Kanban view.

### Running the Supervisor

The supervisor processes GitHub issues through a Kanban pipeline:

1. Create an issue in your GitHub repo (`supervisor.repo` in `.pi/settings.json`)
2. Add it to the GitHub Project board with status `Architecture`
3. Inside pi, run: `/supervisor <issue-number>`

The supervisor reads the issue's status from the project board and dispatches the appropriate agent. Each agent writes its output as a GitHub comment. The supervisor then moves the issue to the next status column. The cycle repeats until the issue reaches **Done** or hits `maxRejections` (default 5).

```
Architecture → TestDesign → Implementation → Audit → Done
     ↑                                          │
     └─────────── (on rejection) ──────────────┘
```

See `.pi/settings.json` → `supervisor.statusMapping` for the status-to-agent mapping.

### Workflows

| Action                 | Command                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Start session**      | `pi`                                                                                                                       |
| **Run supervisor**     | `/supervisor <issue-number>`                                                                                               |
| **View session logs**  | `ls .pi/sessions/`                                                                                                         |

### Context & Templates

Pi loads two kinds of instruction files:

| Type          | File                                       | Behavior                                              |
| ------------- | ------------------------------------------ | ----------------------------------------------------- |
| **Always-on** | `AGENTS.md` or `CLAUDE.md` in project root | Concatenated and appended to system prompt every turn |
| **On-demand** | `.pi/prompts/*.md`                         | Invoked manually via `/prompt-name` in Pi's editor    |

This project's `AGENTS.md` contains the caveman protocol (communication style + tool routing). It's active automatically.

---

## 📦 Verification

Before writing your first line of code, verify all components.

### 1. Base Services

```bash
echo $APIFY_TOKEN            # Should print your token
```

### 2. Pi Autonomy

```bash
pi "Respond with exactly one word: 'Operational'."
```

### 3. Execution Routing (Acid Test)

```bash
pi -p "Create a file named '.pi/test-file.txt' with the content 'host works', then tell me the absolute path where it was created."
```

_Expected:_ File appears on host at `<project-root>/.pi/test-file.txt`.

---

## SBOM — Software Bill of Materials

| Component                                  | Version  | License      | Type       | Supplier/URL                                                                                             |
| ------------------------------------------ | -------- | ------------ | ---------- | -------------------------------------------------------------------------------------------------------- |
| **Runtime & Core**                         |          |              |            |                                                                                                          |
| @earendil-works/pi-coding-agent              | ^0.74.0  | MIT          | dev        | [pi.dev](https://pi.dev)                                                                                 |
| @earendil-works/pi-agent-core                | 0.74.0   | MIT          | transitive | [pi.dev](https://pi.dev)                                                                                 |
| @earendil-works/pi-ai                        | 0.74.0   | MIT          | transitive | [pi.dev](https://pi.dev)                                                                                 |
| @silvia-odwyer/photon-node                    | 0.3.4    | MIT          | transitive | [github.com/silvia-odwyer/photon-node](https://github.com/silvia-odwyer/photon-node)                     |
| jiti                                         | 2.7.0    | MIT          | transitive | [github.com/unjs/jiti](https://github.com/unjs/jiti)                                                     |
| **AI Providers**                           |          |              |            |                                                                                                          |
| @anthropic-ai/sdk                          | 0.91.1   | MIT          | transitive | [anthropic.com](https://www.anthropic.com)                                                               |
| openai                                     | 6.26.0   | Apache-2.0   | transitive | [openai.com](https://openai.com)                                                                         |
| @aws-sdk/client-bedrock-runtime            | 3.1041.0 | Apache-2.0   | transitive | [aws.amazon.com](https://aws.amazon.com)                                                                 |
| @aws-crypto/sha256-browser                 | 5.2.0    | Apache-2.0   | transitive | [aws.amazon.com](https://aws.amazon.com)                                                                 |
| **Schema & Validation**                    |          |              |            |                                                                                                          |
| typebox                                    | 1.1.37   | MIT          | transitive | [github.com/typebox/typebox](https://github.com/typebox/typebox)                                         |
| zod                                        | 4.4.2    | MIT          | transitive | [zod.dev](https://zod.dev)                                                                               |
| **Formatter**                              |          |              |            |                                                                                                          |
| prettier                                    | ^3.8.3   | MIT          | dev        | [prettier.io](https://prettier.io)                                                                       |
| **Utilities**                              |          |              |            |                                                                                                          |
| fast-xml-parser                            | 5.7.2    | MIT          | transitive | [github.com/NaturalIntelligence/fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) |
| tslib                                      | 2.8.1    | 0BSD         | transitive | [github.com/microsoft/tslib](https://github.com/microsoft/tslib)                                         |
| yoctocolors                                | 2.1.2    | MIT          | transitive | [github.com/sindresorhus/yoctocolors](https://github.com/sindresorhus/yoctocolors)                       |
| std-env                                    | 3.10.0   | MIT          | transitive | [github.com/unjs/std-env](https://github.com/unjs/std-env)                                               |
| **System Runtimes**                        |          |              |            |                                                                                                          |
| Node.js                                    | ≥22      | MIT          | system     | [nodejs.org](https://nodejs.org)                                                                         |
| Python 3                                   | ≥3.10    | PSF          | system     | [python.org](https://python.org)                                                                         |
| npm                                        | latest   | Artistic-2.0 | system     | [npmjs.com](https://npmjs.com)                                                                           |
| **Infrastructure Tools**                   |          |              |            |                                                                                                          |
| GitHub CLI (gh)                            | latest   | MIT          | system     | [cli.github.com](https://cli.github.com)                                                                 |
| AST-grep                                   | ≥0.42    | MIT          | system     | [ast-grep.github.io](https://ast-grep.github.io)                                                         |
| **Web Crawling (Python venv)**             |          |              |            |                                                                                                          |
| crawl4ai                                   | latest   | Apache-2.0   | venv       | [github.com/unclecode/crawl4ai](https://github.com/unclecode/crawl4ai)                                   |
| Playwright Chromium                        | latest   | Apache-2.0   | venv       | [playwright.dev](https://playwright.dev)                                                                 |
| **Project Extensions (`.pi/extensions/`)** |          |              |            |                                                                                                          |
| caveman.ts                                 | —        | MIT          | project    | This repository                                                                                          |
| crawl4ai.ts                                | —        | MIT          | project    | This repository                                                                                          |
| session-logger.ts                          | —        | MIT          | project    | This repository                                                                                          |
| ask-user.ts                                | —        | MIT          | project    | This repository                                                                                          |
| supervisor.ts                              | —        | MIT          | project    | This repository                                                                                          |
| format-on-save.ts                          | —        | MIT          | project    | This repository                                                                                          |

> **License Compliance:** All components use OSI-approved open-source licenses (MIT, Apache-2.0, 0BSD, PSF, Artistic-2.0). No GPL/AGPL copyleft. No proprietary or source-available licenses. Total transitive dependency count: ~256 packages (`npm ls --all`).

> **SBOM Generation:** This table is manually maintained. For automated CycloneDX/SPDX SBOM: `npx cyclonedx-npm` + `pip freeze | cyclonedx-py` in `.pi/crawl4ai-venv/`.

---

## FAQ / Troubleshooting

### `pi: command not found`

```bash
sudo npm install -g @earendil-works/pi-coding-agent
# If still missing, check: echo $PATH | grep npm
```

### Web crawl fails with Chromium errors

The extension auto-installs system libraries. If it fails:

```bash
# Check venv
.pi/crawl4ai-venv/bin/python3 -c "import crawl4ai; print('ok')"

# Check Chromium libs
ls .pi/chromium-deps/usr/lib/x86_64-linux-gnu/

# Manual reinstall
rm -rf .pi/crawl4ai-venv .pi/chromium-deps
# Next web_crawl invocation will auto-recreate both
```

### WSL networking issues (can't reach API)

```bash
# Check resolver
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
```

### `gh auth status` shows "not logged in"

Run `gh auth login` and choose **Login with a web browser** (not Paste token, not SSH key upload). If web browser fails:

```bash
# Generate a PAT at https://github.com/settings/tokens (scopes: repo, read:org)
# Then pipe it directly:
cat ~/my-pat-token.txt | gh auth login --with-token
```

---

## Contributing

Contributions welcome — bug reports, feature requests, documentation improvements, new extensions.

1. Fork the repository
2. Create a feature branch (`git worktree add -b feature/amazing feature-amazing` is the recommended workflow)
3. Make your changes
4. Run `node --test test/` if applicable
5. Submit a PR



---

## Security

**Security properties:**

- ✅ No MCP servers — only pi extensions (no network-exposed tool servers)
- ✅ API keys loaded from `~/.agent_env`, never committed

---

## License

MIT © 2025. See [LICENSE](./LICENSE) for full text.

All third-party components are OSI-approved open source (see [SBOM](#sbom---software-bill-of-materials)).

---

## Acknowledgments

Built on top of these excellent projects:

### Runtime & Tools
- [Pi Coding Agent](https://pi.dev) — The agent runtime
- [crawl4ai](https://github.com/unclecode/crawl4ai) — LLM-friendly web crawler
- [Zed](https://zed.dev) — The editor

### Agent Best Practices
- [shanraisshan/claude-code-best-practice](https://github.com/shanraisshan/claude-code-best-practice) (52k ★) — Agentic engineering patterns, context management, sub-agent workflows, skills design
- [ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books) (1.3k ★) — AI agent rules distilled from classic software engineering books. Multiple agents are guided by rule sets from this repository:
  - **Architect agent:**
    - [Clean Architecture](https://github.com/ciembor/agent-rules-books/blob/main/clean-architecture/clean-architecture.mini.md) by Robert C. Martin — Dependency rule, boundaries, entities, use cases, humble adapters
    - [Patterns of Enterprise Application Architecture](https://github.com/ciembor/agent-rules-books/blob/main/patterns-of-enterprise-application-architecture/patterns-of-enterprise-application-architecture.mini.md) by Martin Fowler — Layering, service layer, domain model, repository, DTO, transaction management
    - [A Philosophy of Software Design](https://github.com/ciembor/agent-rules-books/blob/main/a-philosophy-of-software-design/a-philosophy-of-software-design.mini.md) by John Ousterhout — Deep modules, complexity reduction, information hiding, interface design
  - **Developer agent:**
    - [Clean Code](https://github.com/ciembor/agent-rules-books/blob/main/clean-code/clean-code.mini.md) by Robert C. Martin — Small functions, precise names, readability, separate commands from queries, tests as production code
    - [Code Complete](https://github.com/ciembor/agent-rules-books/blob/main/code-complete/code-complete.mini.md) by Steve McConnell — Construction discipline, clarity over cleverness, deliberate error handling, small verifiable increments
    - [The Pragmatic Programmer](https://github.com/ciembor/agent-rules-books/blob/main/the-pragmatic-programmer/the-pragmatic-programmer.mini.md) by Andrew Hunt & David Thomas — DRY, orthogonality, tracer bullets, automation, owning the outcome, broken windows
- [WoJiSama/skill-based-architecture](https://github.com/WoJiSama/skill-based-architecture) (224 ★) — AI agent rule system lifecycle: structure, routing, validation, after-action learning
- [charles-adedotun/claude-code-sub-agents](https://github.com/charles-adedotun/claude-code-sub-agents) (30 ★) — Agent-architect bootstrapper pattern

### Communication & Workflow
- [Caveman](https://github.com/JuliusBrussee/caveman) — Token-efficient AI communication protocol
- [pi-caveman](https://github.com/jonjonrankin/pi-caveman) — Multi-level caveman mode for Pi
- [Matt Pocock's Skills](https://github.com/mattpocock/skills) — Inspiration for the `issue-refinement` prompt (grill-with-docs pattern)
