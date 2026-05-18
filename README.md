# Agentcastle: The Pi Stack (In Development)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.74.0-6e3bf0)](https://pi.dev)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Secure, local-first AI development environment.**
WSL (Ubuntu) + Zed + Git Worktrees + Pi AI — sandboxed execution, real-time feedback.

---

## Philosophy

Everyone should build their own Pi. This repo is **my personal** Pi agent harness. You can fork it as a starting point, but the real power comes from shaping it into **your own** — your preferred tools, your workflows, your guardrails.

Why? Every developer and every team is different. The most effective way of working with an AI coding harness is the one that fits **your** workflow, not a one-size-fits-all maximalist suite. A harness packed with every imaginable feature often gets in the way. The best harness is the one you build for yourself.

Customize ruthlessly. Make it yours.

---

## What is this?

Agentcastle is a pre-configured AI coding harness that gives the [Pi coding agent](https://pi.dev) a full toolchain:

- **Codebase mapping** — `map_codebase` tool via universal-ctags: symbol tree of any directory
- **Structural search** — `structural_search` tool via ast-grep: AST-aware pattern matching
- **Text search** — `ripgrep_search` tool via ripgrep: fast literal/regex code search
- **Web crawling** — `web_crawl` tool: three-tier fallback (local Chromium → Apify cloud → HTTP)
- **Rich TUI** — Custom Neovim-inspired status bar, welcome banner, live TPS estimation
- **Session logging** — Every session saved as JSONL for later query & analysis
- **Multi-agent pipeline** — Researcher → Architect → TestDesigner → Developer → Auditor
- **LSP pre-audit** — Real LSP diagnostics before merge, auto-retry on errors
- **TypeScript checkpoint** — `/check` command: `tsc --noEmit` on demand
- **PiIgnore** — `.piignore` blocks paths from agent read/write/edit/bash
- **Format on save** — Auto Prettier + ESLint after every write/edit
- **Extensions-based** — 12+ secure pi extensions, no MCP servers
- **Custom theme** — Dark cyberpunk TUI theme (agentcastle)

All components run locally. No code leaves your machine (except LLM API calls to your provider).

---

## What's in this repo vs what you set up

This repository contains the **configuration and extensions**. You clone it and get a ready-to-use AI harness. But you still need to install the **system-level tools** once on your machine.

### 📦 Already in this repository

| File/Path                           | What it is                              |
| ----------------------------------- | --------------------------------------- |
| `.pi/extensions/ask-user/`               | Interactive MC questions + CSV logger     |
| `.pi/extensions/caveman/`                | Token-efficient communication protocol    |
| `.pi/extensions/codebase-mapper.ts`       | `map_codebase` tool via universal-ctags  |
| `.pi/extensions/context-info/`            | Rich TUI status bar, welcome banner, TPS  |
| `.pi/extensions/crawl4ai/`                | Three-tier web crawler                    |
| `.pi/extensions/format-on-save/`          | Auto Prettier + ESLint after write/edit   |
| `.pi/extensions/lsp-auditor/`             | LSP diagnostics pre-audit for supervisor  |
| `.pi/extensions/piignore.ts`              | `.piignore` path blocking                 |
| `.pi/extensions/ripgrep-search.ts`        | `ripgrep_search` tool via ripgrep         |
| `.pi/extensions/session-logger/`          | Session logging to JSONL                  |
| `.pi/extensions/structural-analyzer.ts`   | `structural_search` tool via ast-grep     |
| `.pi/extensions/supervisor/`              | Kanban-driven multi-agent orchestration   |
| `.pi/extensions/tsc-checkpoint.ts`        | `/check` command: `tsc --noEmit`          |
| `.pi/agents/researcher.md`               | Researcher agent (pipeline step 1)        |
| `.pi/agents/architect.md`                | Architect agent (pipeline step 2)         |
| `.pi/agents/test-designer.md`            | TestDesigner agent (pipeline step 3)      |
| `.pi/agents/developer.md`                | Developer agent (pipeline step 4)         |
| `.pi/agents/auditor.md`                  | Auditor agent (pipeline step 5)           |
| `.pi/agent/settings.json`                | Default AI provider config                |
| `.pi/settings.json`                      | Supervisor + context status bar config    |
| `.pi/themes/agentcastle.json`            | Dark cyberpunk TUI theme                  |
| `.pi/lib/`                               | Shared types for extensions               |
| `.pi/prompts/issue-cutter.md`            | Epic → sub-issues with layer labels       |
| `.pi/prompts/issue-refinement.md`        | Socratic interview + MC refinement        |
| `.pi/prompts/extension-spec.md`          | Extension design PRD generator            |
| `.pi/prompts/handover.md`                | Session handover document                 |
| `.pi/prompts/quiz-master.md`             | PR review comprehension quiz + auto-merge |
| `.piignore`                              | Agent path blocking (gitignore syntax)    |
| `AGENTS.md`                              | Caveman protocol (active every session)   |
| `package.json`                           | Project metadata + 27 test files          |
| `scripts/postinstall.sh`                 | Patch pi footer.js pipe separator         |
| `scripts/session-query.sh`               | Query JSONL session logs with jq          |
| `scripts/setup-github-project.sh`        | Create GitHub Project from settings       |
| `test/`                                  | 27+ unit/integration test files           |
| `flask_blogs/`                           | Submodule: Flask blog apps                |
| `.gitmodules`                            | Submodule configuration                   |

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
| 🗺️ **Codebase Map** | `map_codebase` via universal-ctags: file-by-file symbol tree, max-depth filter                                    |
| 🔍 **Structural Search** | `structural_search` via ast-grep: AST-aware pattern matching (function calls, try/catch, class defs)          |
| 🔎 **Text Search**  | `ripgrep_search` via ripgrep: fast literal/regex search, respects .gitignore                                       |
| 🕷️ **Web Crawl**    | `web_crawl`: local crawl4ai (real Chromium) → Apify cloud → direct HTTP + regex extraction                         |
| 🖥️ **Rich TUI**     | Custom status bar (branch, model, token usage, TPS), welcome banner, animated working indicator                    |
| 📝 **Session Log**  | Full conversation as JSONL files, queryable via `scripts/session-query.sh` + jq                                    |
| 🦴 **Caveman Mode** | Token-efficient communication via `AGENTS.md` — active in every session                                            |
| 🤖 **Multi-Agent**  | Kanban pipeline: Researcher → Architect → TestDesigner → Developer → Auditor + auto-retry                          |
| ✅ **LSP Pre-Audit**| Real LSP diagnostics before merge, groups by server, auto-retry on errors (max 3)                                  |
| 🔬 **TSC Checkpoint**| `/check` command: `tsc --noEmit` type-check on worktree                                                          |
| 🚫 **PiIgnore**     | `.piignore` blocks paths from agent tools (read/write/edit/bash)                                                   |
| 🎨 **Format on Save**| Auto Prettier + ESLint after every write/edit                                                                     |
| 🎭 **Custom Theme** | agentcastle dark theme: cyberpunk palette (electric blue, neon mint, soft mauve)                                   |
| 🧩 **Extensions**   | 12+ extensions auto-discovered from `.pi/extensions/`. No config files, no MCP servers.                             |
| 📋 **SBOM**         | Full software bill of materials included in this README                                                            |

---

## Quick Start

```bash
# 1. Install prerequisites (one-time, Ubuntu 24.04 LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip python3-venv jq unzip
sudo npm install -g @earendil-works/pi-coding-agent @ast-grep/cli

# 2. Set your AI provider (one-time)
pi --provider opencode-go --api-key "your-key-here"

# 3. Install agentcastle theme
pi install --theme .pi/themes/agentcastle.json

# 4. Start coding
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
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
- [🤖 Supervisor — Multi-Agent Pipeline](#supervisor--multi-agent-pipeline)
  - [Pipeline Flow](#pipeline-flow)
  - [Agent Deep Dive](#agent-deep-dive)
  - [Git Worktree Lifecycle](#git-worktree-lifecycle)
  - [Submodule Strategy](#submodule-strategy)
  - [Quality Gates](#quality-gates)
  - [Merge Conflict Resolution](#merge-conflict-resolution)
  - [GitHub Interaction](#github-interaction)
  - [Configuration Reference](#configuration-reference)
  - [Complete Walkthrough](#complete-walkthrough)
- [📦 Daily Usage](#daily-usage)
  - [Project Setup (one-time)](#project-setup-one-time)
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

### Pi Agent + AST-grep + TypeScript

```bash
sudo npm install -g @earendil-works/pi-coding-agent @ast-grep/cli

# TypeScript for tsc-checkpoint extension
sudo npm install -g typescript
```

Verify:

```bash
ast-grep --version   # expected: ast-grep 0.42.x
pi --version         # expected: 0.74.x
```

> **Note:** If `sudo npm install -g` fails with EACCES, set a user-owned global prefix:
> ```bash
> mkdir -p ~/.npm-global
> npm config set prefix ~/.npm-global
> echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
> source ~/.bashrc
> npm install -g @earendil-works/pi-coding-agent @ast-grep/cli typescript
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
┌────────────────────────────────────────────────────┐
│  Zed Editor (WSL)                                  │
│  ┌──────────────────────────────────────────────┐  │
│  │  Pi TUI (Terminal) — agentcastle theme       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │  │
│  │  │ Exts     │ │ AI Prov │ │ Rich Footer  │ │  │
│  │  │ .pi/     │ │OpenCode  │ │branch model  │ │  │
│  │  │ exts/    │ │Go/...    │ │tokens TPS    │ │  │
│  │  └───┬──────┘ └──────────┘ └──────────────┘ │  │
│  │      │                                        │  │
│  └──────┼────────────────────────────────────────┘  │
└─────────┼───────────────────────────────────────────┘
          │
     ┌────▼────────────────────────────┐
     │  External tools                  │
     │  ┌──────────┐ ┌───────────────┐ │
     │  │ ctags    │ │ ast-grep      │ │
     │  │map_code- │ │structural_    │ │
     │  │base tool │ │search tool    │ │
     │  └──────────┘ └───────────────┘ │
     │  ┌──────────┐ ┌───────────────┐ │
     │  │ ripgrep  │ │ crawl4ai      │ │
     │  │ripgrep_  │ │Python venv    │ │
     │  │search    │ │(host browser) │ │
     │  └──────────┘ └───────────────┘ │
     └─────────────────────────────────┘
```

**Key principle:** All tools run locally. Web crawling runs on host (network-only for crawl). Ctags, ast-grep, ripgrep are system binaries invoked via `pi.exec()`. No MCP servers, no network-exposed tool endpoints.

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

| Extension            | Path                          | Purpose                                                                                                        |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Codebase Mapper**  | `codebase-mapper.ts`          | `map_codebase` tool via universal-ctags. Returns symbol tree (classes, functions, variables) grouped by file.  |
| **Structural Analyzer** | `structural-analyzer.ts`    | `structural_search` tool via ast-grep. AST-aware pattern matching (function calls, try/catch, class defs).    |
| **Ripgrep Search**   | `ripgrep-search.ts`           | `ripgrep_search` tool via ripgrep. Fast literal/regex code search, respects .gitignore.                       |
| **Supervisor**       | `supervisor/`                 | Kanban-driven multi-agent pipeline. Reads issue from GitHub project, dispatches Researcher → Architect → TestDesigner → Developer → Auditor in loop. Registers `/supervisor <issue-number>` command. |
| **Web Crawler**      | `crawl4ai/`                   | `web_crawl` tool: local crawl4ai → Apify cloud → HTTP fallback. Auto-installs venv + Chromium deps.           |
| **Context Info**     | `context-info/`               | Rich TUI status bar (branch, model, tokens, TPS), welcome banner, animated working indicator, telemetry.       |
| **Session Logger**   | `session-logger/`             | Logs sessions to `.pi/sessions/<id>.jsonl`. Toggle with `/session-logger`. Query with `scripts/session-query.sh`. |
| **Caveman Protocol** | `caveman/`                    | Token-efficient communication style. Active via `AGENTS.md`. Configurable intensity levels.                    |
| **Ask User**         | `ask-user/`                   | Interactive MC picker for AI-to-user questions. Uses `ctx.ui.select()` with arrow-key navigation + CSV logging.|                                       |
| **Format on Save**   | `format-on-save/`             | Auto-formats TS/JS with Prettier + ESLint --fix after write/edit. Non-blocking lint warnings.                  |
| **PiIgnore**         | `piignore.ts`                 | Blocks paths matching `.piignore` patterns from read/write/edit/bash tools. Supports negation (!).             |
| **TSC Checkpoint**   | `tsc-checkpoint.ts`           | `/check` command runs `tsc --noEmit` on worktree. Parses TS error format. Used in pipeline Implementation→Audit.|
| **LSP Auditor**      | `lsp-auditor/`                | Passive extension: runs real LSP diagnostics on modified files before merge. Groups by server, auto-retry on errors. Called by supervisor pipeline. |

### Agent Definitions

Agents are defined as Markdown files in `.pi/agents/` with YAML frontmatter specifying their name, description, allowed tools, and model. The supervisor reads these definitions at runtime.

| Agent              | File                   | Model                           | Tools                                                       | Extensions (extra)                       |
| ------------------ | ---------------------- | ------------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| **Researcher**     | `researcher.md`        | `opencode-go/deepseek-v4-flash` | `read`, `bash`, `structural_search`, `ripgrep_search`       | `caveman, codebase-mapper, crawl4ai, piignore, ripgrep-search, structural-analyzer` |
| **Architect**      | `architect.md`         | `opencode-go/deepseek-v4-flash` | `read`, `bash`, `structural_search`, `ripgrep_search`       | `caveman, codebase-mapper, crawl4ai, piignore, ripgrep-search, structural-analyzer` |
| **TestDesigner**   | `test-designer.md`     | `opencode-go/deepseek-v4-flash` | `read`, `bash`, `structural_search`, `ripgrep_search`       | `caveman, codebase-mapper, crawl4ai, piignore, ripgrep-search, structural-analyzer` |
| **Developer**      | `developer.md`         | `opencode-go/deepseek-v4-flash` | `read`, `bash`, `write`, `edit`, `structural_search`, `ripgrep_search` | `caveman, codebase-mapper, crawl4ai, format-on-save, piignore, ripgrep-search, tsc-checkpoint, structural-analyzer` |
| **Auditor**        | `auditor.md`           | `opencode-go/deepseek-v4-flash` | `read`, `bash`, `structural_search`, `ripgrep_search`       | `caveman, codebase-mapper, crawl4ai, piignore, ripgrep-search, structural-analyzer` |

Each agent's system prompt defines its role in the Kanban pipeline. The supervisor reads the issue's status from the GitHub project board and dispatches the matching agent. See the [Supervisor workflow](#running-the-supervisor) below.

### Prompt Templates

User-invocable prompt expansions in `.pi/prompts/`. Type `/name` in the editor to expand a template.

| Template             | Description                                                                                                                                                                           | Config / Usage                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **issue-cutter**     | Split a refined epic into ordered, independently testable sub-issues. Each gets `refined` + layer label (e.g. `database`, `backend`). Auto-links children to parent epic via GraphQL. | Set `supervisor.repo` in `.pi/settings.json`. Invoke: `/issue-cutter <number>`                  |
| **issue-refinement** | Grill an issue against codebase, Socratic interview via `ask_user` (≥3 MC options), replace body with concrete ACs.                                                                   | Set `supervisor.repo` in `.pi/settings.json`. Invoke: `/issue-refinement <number>`              |
| **extension-spec**   | Design a new pi extension or refactor existing one. Researches best practices from pi docs, audits TypeScript, produces PRD with implementation spec.                                  | Invoke: `/extension-spec <idea>`. Supports `refactor:<name>` mode.                             |
| **handover**         | Write concise handover document summarizing the conversation so a fresh agent can continue. Saves to `tmp/` with datetime prefix.                                                     | Invoke: `/handover`. Output: `tmp/<datetime>_<topic>.md`.                                       |
| **quiz-master**      | List open PRs across main repo + all submodules, quiz reviewer on diff with MC questions, auto-merge if score ≥80%.                                                                   | Requires `gh` auth. Set `supervisor.repo` in `.pi/settings.json`. Invoke: `/quiz-master`.       |

### Skills

Skills are expert procedural guides stored in `.pi/skills/`. The agent loads the full skill only when a task matches its trigger description — but **every skill's description is injected into the context window on every turn**, regardless of whether the skill is needed.

**Why we use skills sparingly:** Each skill description (~50-150 tokens) consumes the LLM's finite attention budget on every single turn. With many skills, these descriptions silently bloat the context window with low-signal tokens the model must attend to. This causes [**context rot**](https://docs.anthropic.com/en/docs/build-with-claude/context-windows): as token count grows, the model's recall and reasoning accuracy progressively degrade — a phenomenon documented in Anthropic's [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) and the ["Lost in the Middle"](https://arxiv.org/abs/2307.03172) paper (Liu et al., 2023).

> **Design decision:** Prefer pi **extensions** (`.pi/extensions/`) or manual **prompt templates** (`.pi/prompts/`) over skills. Extensions only expose concise prompt snippets (~50-120 tokens) instead of full JSON Schema. Prompt templates are lazy — only loaded when explicitly invoked. If a skill is truly unavoidable, keep its description minimal and its scope narrow.

Currently no skills installed. Skills dir: `.pi/skills/.gitkeep`.

#### Session Logger

```bash
/session-logger        # toggle on/off
/session-logger on     # force on
/session-logger off    # force off
```

Output (JSONL format):

```
.pi/sessions/<datetime>_<uuid>.jsonl
```

Each line is a JSON event: messages, thinking blocks, tool calls, compactions. Query with:

```bash
./scripts/session-query.sh 'select(.role == "user")'
cat .pi/sessions/latest.jsonl | ./scripts/session-query.sh 'select(.tool == "bash")'
```

Metadata stored in `.pi/sessions/metadata.json`.

---

## 🤖 Supervisor — Multi-Agent Pipeline

The supervisor (`/supervisor <issue-number>`) is the heart of this harness. It takes a GitHub issue, runs it through 5 agent stages in a Kanban loop, creates git worktrees, runs quality gates, and creates pull requests — all autonomously.

### Pipeline Flow

```
     ┌─────────────────────────────────────────────────────────────────────────┐
     │                         GITHUB PROJECT BOARD                           │
     │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌─────────┐  │
     │  │ Research │ │Architect.│ │TestDesign│ │Implement.    │ │  Audit  │  │
     │  │          │ │          │ │          │ │              │ │         │  │
     │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘ └────┬────┘  │
     │       │             │            │              │              │       │
     └───────┼─────────────┼────────────┼──────────────┼──────────────┼───────┘
             │             │            │              │              │
    ┌────────▼────────┐ ┌──▼────────┐ ┌─▼───────────┐ │    ┌─────────▼──────┐
    │  Researcher     │ │ Architect │ │ TestDesigner │ │    │   Auditor      │
    │  crawls web     │ │ proposes  │ │ writes       │ │    │   reviews      │
    │  for best       │ │ target    │ │ test plan    │ │    │   implements   │
    │  practices,     │ │ architec- │ │ from archi-  │ │    │   creates PR   │
    │  lib versions,  │ │ ture      │ │ tecture      │ │    │   or rejects   │
    │  pitfalls       │ │           │ │              │ │    │                │
    └────────┬────────┘ └──┬────────┘ └─┬───────────┘ │    └────────┬───────┘
             │             │            │              │             │
             ▼             ▼            ▼              │             ▼
     GitHub Comment   GitHub Comment  GitHub Comment   │    GitHub Comment
     ## Research      ## Architectu-  ## Test Plan      │    ## Audit Approved
     Findings         re Approach                       │    + PR created
                                                        │
                        ┌───────────────────────────────┘
                        │
                        ▼
              ┌──────────────────────┐
              │  QUALITY GATES       │
              │  ┌────────────────┐  │
              │  │ TSC --noEmit   │──│──→ pass → continue
              │  │ (tsc-checkpoint)│  │     fail → back to Implementation
              │  └────────────────┘  │
              │  ┌────────────────┐  │
              │  │ LSP pre-audit  │──│──→ pass → continue
              │  │ (lsp-auditor)  │  │     fail → back to Implementation
              │  │                │  │     (max 3 retries)
              │  └────────────────┘  │
              └──────────────────────┘
                        │
                        ▼
              ┌──────────────────────┐
              │  Auditor decision    │
              │  ┌──────────────┐    │
              │  │ APPROVED?    │──│──→ Yes → Create PR → DONE
              │  │              │    │     No  → back to Implementation
              │  └──────────────┘    │
              └──────────────────────┘
                        │
                        ▼
              ┌──────────────────────┐
              │  POST-PIPELINE       │
              │  Check PR for        │
              │  merge conflicts     │
              │  Auto-merge or       │
              │  dispatch Developer  │
              └──────────────────────┘
```

**Loop rules:**
- Each agent posts a structured GitHub comment on the issue
- Supervisor reads the agent's output for a **completion marker** to know the agent finished
- If agent times out, supervisor logs it and stops
- Auditor can reject → sends back to Implementation (counts as 1 rejection)
- LSP/TSC errors → sends back to Implementation (does NOT count as rejection, max 3 retries)
- `maxRejections` (default 5) stops the loop to prevent infinite cycles

---

### Agent Deep Dive

| # | Agent | Entry Marker | Completion Marker | Model | Tools | Thinking | Role |
|---|-------|-------------|-------------------|-------|-------|----------|------|
| 1 | **Researcher** | issue has status `Research` | `RESEARCH_COMPLETE` | opencode-go/deepseek-v4-flash | read, bash, structural_search, ripgrep_search | medium | Crawls 3-5 public web pages on the issue topic, synthesizes findings into a structured `## Research Findings` comment. Deduplicates: skips if comment already exists (re-run safe). Never makes recommendations — just presents facts with source URLs. |
| 2 | **Architect** | status `Architecture` | `ARCHITECTURE_COMPLETE` | opencode-go/deepseek-v4-flash | read, bash, structural_search, ripgrep_search | high | Reads the issue body + Research Findings comment. Applies Clean Architecture (dependency rule), PEAA (layering, service layer, domain model), Philosophy of Software Design (deep modules) principles. Proposes target architecture as a GitHub comment. |
| 3 | **TestDesigner** | status `TestDesign` | `TEST_PLAN_COMPLETE` | opencode-go/deepseek-v4-flash | read, bash, structural_search, ripgrep_search | medium | Reads the issue + Architecture comment. Writes a test plan following Clean Architecture testing discipline, PEAA responsibility-level testing, and Working Effectively with Legacy Code patterns. Posts as GitHub comment. |
| 4 | **Developer** | status `Implementation` | `IMPLEMENTATION_COMPLETE` | opencode-go/deepseek-v4-flash | read, bash, write, edit, structural_search, ripgrep_search | low | Creates a git worktree, implements code changes, commits, pushes. Also handles submodule changes. Uses `format-on-save` extension for auto-formatting. |
| 5 | **Auditor** | status `Audit` | `AUDIT_APPROVED` or `AUDIT_REJECTED` | opencode-go/deepseek-v4-flash | read, bash, structural_search, ripgrep_search | medium | Reviews code in worktree against architecture and test plan. Runs `git diff`. Creates PR if approved (with companion submodule PRs if needed), or rejects with specific issues listed. |

**Before Auditor runs**, the supervisor runs quality gates ([see below](#quality-gates)).

---

### Git Worktree Lifecycle

Each issue gets an **isolated git worktree**. This is critical — it prevents agents from interfering with each other and keeps `main` clean.

**Branch naming convention:**
```
worktree-git-issue-<number>-<title-slug>
# Example:
worktree-git-issue-42-add-user-authentication
```

**Worktree path:**
```
../worktree-git-issue-<number>-<title-slug>/
# (configurable via supervisor.worktreeBase in settings.json)
```

**Lifecycle from agent perspective:**

```
┌──────────────────────────────────────────────────────────────┐
│               WORKTREE LIFECYCLE                             │
│                                                              │
│  1. Developer enters stage                                   │
│     ┌───────────────────────────────────────────────┐       │
│     │ git worktree add ../<branch> <defaultBranch>  │       │
│     │ cd ../<branch>                                │       │
│     └───────────────────────────────────────────────┘       │
│                          │                                   │
│  2. Implement + commit                                      │
│     ┌───────────────────────────────────────────────┐       │
│     │ git add -A                                     │       │
│     │ git commit -m "feat(#42): Add user auth"       │       │
│     │ git push origin <branch>                       │       │
│     └───────────────────────────────────────────────┘       │
│                          │                                   │
│  3. Auditor reviews in same worktree                        │
│     ┌───────────────────────────────────────────────┐       │
│     │ cd ../<branch>                                │       │
│     │ git diff <defaultBranch>  ← review changes    │       │
│     └───────────────────────────────────────────────┘       │
│                          │                                   │
│  4. On approval: Auditor creates PR                         │
│     ┌───────────────────────────────────────────────┐       │
│     │ gh pr create --repo owner/repo               │       │
│     │   --base <defaultBranch>                     │       │
│     │   --head <branch>                            │       │
│     │   --title "feat(#42): Add user auth"          │       │
│     │   --body "Closes #42"                        │       │
│     └───────────────────────────────────────────────┘       │
│                          │                                   │
│  5. Post-pipeline: merge conflict check                     │
│     ┌───────────────────────────────────────────────┐       │
│     │ gh pr view <branch> --json mergeable,...      │       │
│     │ If conflicted → auto-merge or dispatch dev    │       │
│     └───────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

**Key rules:**
- Developer MUST `cd` into worktree before any write/edit/bash — never work in project root
- All Git operations (add, commit, push) happen inside the worktree
- The worktree persists after approval — cleanup is manual (`git worktree remove`)
- Configurable via `supervisor.worktreeBase` and `supervisor.branchPrefix` in `.pi/settings.json`

---

### Submodule Strategy

When the repository has submodules (configured via `.gitmodules` or `supervisor.submodules`), the Developer works on **both repos simultaneously** using a **matched-branch pattern**:

```
┌─ Main repo (agentcastle)  ──────────────────────────────────┐
│  Branch: worktree-git-issue-42-add-user-authentication      │
│  Commit includes submodule pointer update (pinned SHA)      │
└─────────────────────────────────────────────────────────────┘
                          ║
                    same branch name
                          ║
┌─ Submodule (flask_blogs) ───────────────────────────────────┐
│  Branch: worktree-git-issue-42-add-user-authentication      │
│  Actual code changes live here                               │
└─────────────────────────────────────────────────────────────┘
```

**Auditor handles PR creation in correct order:**

```
Step 1 — Create submodule PR FIRST (if submodule has changes):
  cd flask_blogs
  gh pr create --repo owner/flask_blogs \
    --base main --head <branch> \
    --title "feat(#42): ..."

Step 2 — Create main repo PR SECOND (includes submodule pointer):
  gh pr create --repo owner/agentcastle \
    --base main --head <branch> \
    --title "feat(#42): ..." \
    --body "Closes #42"
```

**Critical order:** Submodule PR must be created **first**. If main repo PR is created first, the submodule SHA doesn't exist remotely and teammates get `fatal: reference is not a tree` when they pull. The `push.recurseSubmodules check` git config is a safety net.

---

### Quality Gates

Before transitioning `Implementation → Audit`, the supervisor runs two automated checks on the worktree:

**1. TSC Checkpoint** (`tsc-checkpoint` extension)
- Runs `npx tsc --noEmit` on the worktree
- Parses tsc error format: `file(line,col): error TS<code>: message`
- Only runs if `tsconfig.json` exists
- Non-blocking if tsc binary not found
- Output: formatted diagnostic list per file

**2. LSP Pre-Audit** (`lsp-auditor` extension)
- Runs real Language Server Protocol diagnostics on **modified files only** (git diff vs `defaultBranch`)
- Groups files by language server (TypeScript, Python, ESLint, etc.)
- Each group is audited concurrently via separate LSP server process
- Auto-retries on errors (max 3 attempts), with exponential backoff
- Only blocks if: a) LSP server is available AND b) server reports errors
- If no LSP server for a language, that file passes silently

**Decision table:**

| TSC result | LSP result | Outcome |
|-----------|-----------|---------|
| pass      | pass      | → Audit |
| pass      | fail      | → Implementation (retry LSP, max 3) |
| pass      | N/A (no LSP) | → Audit |
| fail      | (skipped) | → Implementation |
| N/A (no tsconfig) | pass | → Audit |

---

### Merge Conflict Resolution

After the pipeline reaches `Done`, the supervisor checks the created PR for merge conflicts:

```
                        ┌─────────────────────┐
                        │  PR created          │
                        │  (pipeline done)     │
                        └──────────┬──────────┘
                                   │
                         ┌─────────▼─────────┐
                         │  gh pr view ...    │
                         │  --json mergeable  │
                         └─────────┬─────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
              ┌─────▼─────┐               ┌──────▼──────┐
              │ Conflict? │               │ No conflict │
              │           │               │  → done     │
              └─────┬─────┘               └─────────────┘
                    │
         ┌──────────▼──────────┐
         │  Ask user: fix?     │
         │  (ctx.ui.confirm)   │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │  Auto-merge attempt │
         │  (git merge base)   │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │  Auto-merge         │
         │  succeeded?         │
         └──────────┬──────────┘
                    │
       ┌────────────┴────────────┐
       │                         │
  ┌────▼────┐             ┌──────▼──────┐
  │ Yes     │             │ No — dispatch│
  │ git push│             │ Developer    │
  │ done    │             │ agent to     │
  └─────────┘             │ resolve      │
                          └─────────────┘
```

---

### GitHub Interaction

The supervisor interacts with GitHub on every step. Here's the full contract:

| Action | Method | Purpose |
|--------|--------|---------|
| `gh issue view <N> --json number,title,body,author,comments` | pi.exec | Fetch issue data (pre-filtered to trusted codeowners) |
| `gh project view <projectNumber> --owner <owner> --json fields` | pi.exec | Get field IDs (status options) |
| `gh project item-list <projectNumber> --owner <owner> --format json` | pi.exec | Find issue's project item, read current status |
| `gh api graphql ...` (set status) | pi.exec | Move issue to next status on board |
| `gh issue comment <N> --repo <R> --body <B>` | pi.exec | Agent posts structured comment (research, architecture, test plan, audit) |
| `gh pr create --repo <R> --base <B> --head <H>` | pi.exec | Auditor creates PR on approval |
| `gh pr view <branch> --json ...` | pi.exec | Post-pipeline merge conflict check |

**Security:** All issue data is **pre-filtered** before reaching agents — only the body (if author is a codeowner) and comments from trusted codeowners are passed. The agent is explicitly instructed: "Use ONLY the issue data provided above. Do NOT run `gh issue view`." This prevents prompt injection via untrusted issue comments.

---

### Configuration Reference

All supervisor settings live in `.pi/settings.json` under the `supervisor` key:

```jsonc
{
  "supervisor": {
    // REQUIRED — GitHub repo in owner/repo format
    "repo": "SchneiderDaniel/agentcastle",

    // REQUIRED — GitHub Project (v2) number
    "projectNumber": 3,

    // REQUIRED — maps board status name → agent file stem
    "statusMapping": {
      "Research": "researcher",
      "Architecture": "architect",
      "TestDesign": "test-designer",
      "Implementation": "developer",
      "Audit": "auditor"
    },

    // REQUIRED — trusted GitHub usernames (filters issue data)
    "codeowners": ["SchneiderDaniel"],

    // Name of the single-select field on the project board
    "statusField": "Status",

    // Max times Auditor can reject before loop stops (default: 5)
    "maxRejections": 5,

    // Remote name for git push (default: "origin")
    "remote": "origin",

    // Default branch for worktree base and PR target (default: "main")
    "defaultBranch": "main",

    // Parent directory for worktrees (default: "../")
    "worktreeBase": "../",

    // Prefix for auto-generated branch names (default: "worktree-git-issue-")
    "branchPrefix": "worktree-git-issue-",

    // Per-agent timeout in minutes (optional)
    "agentTimeoutsMin": {
      "researcher": 10,
      "developer": 30
    },

    // Override submodules (auto-parsed from .gitmodules if absent)
    "submodules": [
      { "path": "flask_blogs", "repo": "Owner/flask_blogs" }
    ]
  }
}
```

---

### Complete Walkthrough

Here's what happens end-to-end when you run `/supervisor 42`:

```
You: /supervisor 42

── Step 1: Fetch ────────────────────────────────────────────────
Supervisor reads .pi/settings.json → repo, project board, statuses
Fetches issue #42 from GitHub, filters to trusted codeowners only
Reads issue's current status from project board → "Research"

── Step 2: Researcher ───────────────────────────────────────────
Spins up:  pi -p --mode json --system-prompt <researcher.md> --task "..."
Agent crawls 3-5 web pages about the issue topic
Posts:  gh issue comment 42 --repo owner/repo --body "## Research Findings..."
Outputs: RESEARCH_COMPLETE
Supervisor moves issue → "Architecture" on board

── Step 3: Architect ────────────────────────────────────────────
Spins up agent with architect system prompt + issue data + research
Uses read, bash, structural_search, ripgrep_search to analyze codebase
Proposes architecture following Clean Architecture + PEAA principles
Posts:  gh issue comment 42 --body "## Architecture Approach..."
Outputs: ARCHITECTURE_COMPLETE
Supervisor moves issue → "TestDesign"

── Step 4: TestDesigner ─────────────────────────────────────────
Spins up agent with test-designer prompt + issue + architecture
Writes test plan: unit, integration, characterization tests
Posts:  gh issue comment 42 --body "## Test Plan..."
Outputs: TEST_PLAN_COMPLETE
Supervisor moves issue → "Implementation"

── Step 5: Developer ────────────────────────────────────────────
Spins up agent with developer prompt + issue + arch + test plan
  Creates worktree:  git worktree add ../<branch> main
  cd ../<branch>
  Implements feature, runs tests, formats code
  git add -A && git commit -m "feat(#42): ..."
  git push origin <branch>
Outputs: IMPLEMENTATION_COMPLETE

── Step 6: Quality Gates ────────────────────────────────────────
  TSC: runs npx tsc --noEmit on worktree → pass
  LSP: runs diagnostics on modified files → pass
Supervisor moves issue → "Audit"

── Step 7: Auditor ──────────────────────────────────────────────
Spins up agent with auditor prompt + all previous data
  cd ../<branch>
  git diff main (reviews changes)
  Reviews against architecture + test plan
  Decision: APPROVED ✔
  Creates submodule PRs if needed
  Creates main PR: gh pr create --repo owner/repo --head <branch> --title "feat(#42): ..."
  Posts: ## Audit Approved
Outputs: AUDIT_APPROVED
Supervisor moves issue → "Done"

── Step 8: Post-pipeline ────────────────────────────────────────
  Checks PR for merge conflicts
  If conflicted → asks you if you want to auto-fix
  If yes → attempts auto-merge
  If auto-merge fails → dispatches Developer to resolve

── Done ─────────────────────────────────────────────────────────
Issue #42 is complete with a PR ready for final review.
```

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

### Workflows

| Action                     | Command / Usage                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| **Start session**          | `pi`                                                                                              |
| **Run supervisor**         | `/supervisor <issue-number>`                                                                      |
| **Run TSC type-check**     | `/check`                                                                                          |
| **Toggle session logger**  | `/session-logger on` / `/session-logger off`                                                       |
| **Toggle caveman level**   | `/caveman` (cycle: lite → full → off) or `/caveman lite`                                          |
| **Query session logs**     | `./scripts/session-query.sh 'select(.role == "user")'`                                           |
| **Design an extension**    | `/extension-spec <idea>`                                                                          |
| **Write handover**         | `/handover`                                                                                       |
| **Quiz PR reviewer**       | `/quiz-master`                                                                                    |
| **View session logs**      | `ls .pi/sessions/`                                                                                |
| **Reload config**          | `/reload` (after editing .piignore, settings.json, etc.)                                          |

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

### 2. Tool Verification

```bash
# Codebase mapper
pi "Run map_codebase on the root with max_depth=1"

# Structural search
pi "Use structural_search to find all console.log calls in TypeScript files"

# Text search
pi "Use ripgrep_search to find 'TODO' in the project"
```

### 3. Pi Autonomy

```bash
pi "Respond with exactly one word: 'Operational'."
```

### 4. Execution Routing (Acid Test)

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
| **TUI & UI**                              |          |              |            |                                                                                                          |
| @earendil-works/pi-tui                      | ^0.74.0  | MIT          | prod       | [pi.dev](https://pi.dev)                                                                                 |
| boxen                                       | ^7.1.1   | MIT          | prod       | [github.com/sindresorhus/boxen](https://github.com/sindresorhus/boxen)                                   |
| **LSP**                                   |          |              |            |                                                                                                          |
| vscode-jsonrpc                              | ^8.2.1   | MIT          | prod       | [github.com/microsoft/vscode-jsonrpc](https://github.com/microsoft/vscode-jsonrpc)                       |
| **TypeScript**                            |          |              |            |                                                                                                          |
| typescript                                  | ^6.0.3   | Apache-2.0   | dev        | [typescriptlang.org](https://www.typescriptlang.org)                                                     |
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
| Universal Ctags                           | latest   | GPL-2.0      | system     | [ctags.io](https://ctags.io)                                                                             |
| ripgrep (rg)                              | latest   | MIT          | system     | [github.com/BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep)                                   |
| **Web Crawling (Python venv)**             |          |              |            |                                                                                                          |
| crawl4ai                                   | latest   | Apache-2.0   | venv       | [github.com/unclecode/crawl4ai](https://github.com/unclecode/crawl4ai)                                   |
| Playwright Chromium                        | latest   | Apache-2.0   | venv       | [playwright.dev](https://playwright.dev)                                                                 |
| **Project Extensions (`.pi/extensions/`)** |          |              |            |                                                                                                          |
| codebase-mapper.ts                         | —        | MIT          | project    | This repository                                                                                          |
| structural-analyzer.ts                     | —        | MIT          | project    | This repository                                                                                          |
| ripgrep-search.ts                          | —        | MIT          | project    | This repository                                                                                          |
| caveman/                                   | —        | MIT          | project    | This repository                                                                                          |
| crawl4ai/                                  | —        | MIT          | project    | This repository                                                                                          |
| session-logger/                            | —        | MIT          | project    | This repository                                                                                          |
| ask-user/                                  | —        | MIT          | project    | This repository                                                                                          |
| supervisor/                                | —        | MIT          | project    | This repository                                                                                          |
| format-on-save/                            | —        | MIT          | project    | This repository                                                                                          |
| context-info/                              | —        | MIT          | project    | This repository                                                                                          |
| lsp-auditor/                               | —        | MIT          | project    | This repository                                                                                          |
| piignore.ts                                | —        | MIT          | project    | This repository                                                                                          |
| tsc-checkpoint.ts                          | —        | MIT          | project    | This repository                                                                                          |

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

### `map_codebase` fails with "ctags not found"

Install universal-ctags with JSON output:

```bash
sudo apt-get install -y universal-ctags
ctags --list-output-formats   # should include 'json'
```

### `structural_search` fails with "ast-grep not found"

```bash
sudo npm install -g @ast-grep/cli
ast-grep --version   # expected: 0.42.x
```

### `ripgrep_search` fails with "rg not found"

```bash
sudo apt-get install -y ripgrep
rg --version
```

### `/check` fails with "tsc not found"

```bash
sudo npm install -g typescript
tsc --version
```

### `.piignore` blocking legitimate paths

Edit `.piignore` and add a negation pattern:
```
# Allow specific path that would otherwise be blocked
!path/to/allow
```
Reload: `/reload`

---

## Contributing

Contributions welcome — bug reports, feature requests, documentation improvements, new extensions.

1. Fork the repository
2. Create a feature branch (`git worktree add -b feature/amazing feature-amazing` is the recommended workflow)
3. Make your changes
4. Run tests: `npm test` (runs all 27+ test files)
5. Submit a PR



---

## Security

**Security properties:**

- ✅ No MCP servers — only pi extensions (no network-exposed tool servers)
- ✅ API keys loaded from `~/.agent_env`, never committed
- ✅ `.piignore` path blocking — block sensitive files from agent read/write/edit/bash

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

### Extensions & Tools
- [Pi SDK & Extensions Documentation](https://pi.dev/docs/latest) — Extension API, commands, hooks, theme system
- [ast-grep](https://ast-grep.github.io) — Structural code search via Tree-sitter AST
- [ripgrep](https://github.com/BurntSushi/ripgrep) — Ultra-fast literal/regex code search
- [universal-ctags](https://ctags.io) — Codebase symbol indexing
