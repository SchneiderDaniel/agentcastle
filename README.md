# AgentCastle: Kanban-Centred Pi AI Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.74.0-6e3bf0)](https://pi.dev)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Kanban-centred Pi agent with token-efficient tools, security guardrails, and efficient workflow enhancements.** Docker + Pi AI — autonomous Kanban pipeline, sandboxed execution, real-time feedback.

---

## Table of Contents

- [Your Journey](#your-journey)
  - [1. Discovery — What is AgentCastle?](#1-discovery--what-is-agentcastle)
  - [2. Philosophy — Why build your own?](#2-philosophy--why-build-your-own)
  - [3. Preparation — What you need on your machine](#3-preparation--what-you-need-on-your-machine)
  - [4. Installation — How to set it up](#4-installation--how-to-set-it-up)
  - [5. Orientation — What did I just install?](#5-orientation--what-did-i-just-install)
  - [6. Verification — Does everything work?](#6-verification--does-everything-work)
  - [7. Daily Use — How to work with AgentCastle](#7-daily-use--how-to-work-with-agentcastle)
  - [8. Power User — The Multi-Agent Pipeline](#8-power-user--the-multi-agent-pipeline)
  - [9. Troubleshooting — Something broke](#9-troubleshooting--something-broke)
  - [10. Contributing — I want to help](#10-contributing--i-want-to-help)
- [Appendix](#appendix)
  - [SBOM — Software Bill of Materials](#sbom--software-bill-of-materials)
  - [Security](#security)
  - [License](#license)
  - [Legacy Installation (host-level)](#legacy-installation-host-level)
  - [Acknowledgments](#acknowledgments)

---

## Your Journey

This README follows your path from first encounter to daily use. Each section is one step in that journey.

---

### 1. Discovery — What is AgentCastle?

AgentCastle is a **Kanban-centred AI agent** built on the [Pi coding agent](https://pi.dev). It uses a GitHub Project board to drive an autonomous multi-agent pipeline — Researcher → Architect → TestDesigner → Developer → Auditor — with tools designed to minimise token waste, enforce security boundaries, and streamline the dev workflow. Clone this repo and you get a complete toolchain:

- **Codebase mapping** — `ranked_map` via universal-ctags: auto-mode (query → ranked, no query → full dump for small repos, recency-ranked for large repos)
- **Structural search** — `structural_search` via ast-grep: AST-aware pattern matching
- **Text search** — `ripgrep_search` via ripgrep: fast literal/regex code search
- **Web crawling** — `web_crawl`: local crawl4ai → Apify cloud → HTTP fallback
- **Rich TUI** — Custom status bar (branch, model, token usage, TPS), welcome banner
- **Session logging** — Every conversation saved as JSONL, queryable with jq
- **Multi-agent pipeline** — Autonomous Kanban: Researcher → Architect → TestDesigner → Developer → Auditor
- **LSP pre-audit** — Real LSP diagnostics before merge, auto-retry on errors
- **TypeScript checkpoint** — `/check` command: `tsc --noEmit` on demand
- **PiIgnore** — Block paths from agent read/write/edit/bash
- **Format on save** — Auto Prettier + ESLint after every write/edit
- **Extensions-based** — 12+ secure pi extensions, no MCP servers, no network-exposed endpoints
- **Custom theme** — Dark cyberpunk TUI (agentcastle)

All components run locally. No code leaves your machine (except LLM API calls to your provider).

---

### 2. Philosophy — Why build your own?

Everyone should build their own Pi. This repo is **my personal** Pi agent harness. Fork it as a starting point, but the real power comes from shaping it into **your own** — your preferred tools, your workflows, your guardrails.

Why? Every developer and every team is different. The most effective way of working with an AI coding harness is the one that fits **your** workflow, not a one-size-fits-all maximalist suite. A harness packed with every imaginable feature often gets in the way. The best harness is the one you build for yourself.

Customize ruthlessly. Make it yours.

---

### 3. Preparation — What you need on your machine

**One dependency:** Docker Engine ≥24.0 with Compose V2.

| Platform | Install Link |
|----------|-------------|
| **Linux** | [Docker Engine](https://docs.docker.com/engine/install/) + [Compose V2](https://docs.docker.com/compose/install/linux/) |
| **macOS** | [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac/) (includes Engine + Compose V2) |
| **Windows** | WSL2 + [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows/) |

**Platform:** Docker-only. Linux native, macOS via Docker Desktop, Windows via WSL2 + Docker Desktop.

**API keys:** Copy `docker/agent_env.example` to `.agent_env` and fill in your keys. The container loads this file automatically.

---

### 4. Installation — How to set it up

#### Quick-start

```bash
git clone git@github.com:SchneiderDaniel/agentcastle.git
cd agentcastle
./agent-castle.sh
```

That's it. The wrapper script:
1. Builds the OCI image from `docker/Dockerfile` (first run, ~2 min; cached thereafter)
2. Starts the container with your repo bind-mounted, API keys loaded, and UID/GID mapped
3. Drops you into the Pi TUI inside the container

#### Step-by-step

**1. Clone the repo**
```bash
git clone git@github.com:SchneiderDaniel/agentcastle.git && cd agentcastle
```

**2. Configure API keys**
```bash
cp docker/agent_env.example .agent_env
# Edit .agent_env with your keys (e.g., APIFY_TOKEN)
```

**3. Launch**
```bash
./agent-castle.sh
```

**4. Set provider (first session only)**
```bash
pi --provider opencode-go --api-key "your-key"
```
Exit with `Ctrl+C` twice. The provider is persisted in `.pi/settings.json`.

#### What happens under the hood

`./agent-castle.sh` runs `docker compose up` with:
- Image built from `docker/Dockerfile` (Debian 12-slim, Node.js 22, Python 3, ctags, ripgrep, ast-grep, pi, gosu)
- Repo root bind-mounted to `/workspaces/main` inside the container
- `.agent_env` file mounted and sourced automatically
- Host UID/GID mapped to container user `agentuser` (no permission issues with bind mounts)
- Interactive TTY for the Pi TUI

---

### 5. Orientation — What did I just install?

#### 5.1 Architecture

```
┌────────────────────────────────────────────────────┐
│  Terminal (Docker)                                  │
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

#### 5.2 Why extensions instead of MCP?

This project deliberately avoids the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). All tools are **pi extensions** — TypeScript files in `.pi/extensions/` that run inside the agent's Node.js runtime. No external MCP servers, no network-exposed tool endpoints, no separate processes.

**Two reasons: security and token efficiency.**

**🔒 Security:** MCP servers introduce a new attack surface (OWASP maintains the [MCP Top 10](https://owasp.org/www-project-mcp-top-10/)). Extensions treat tool execution as a function call. No network layer = no network attack surface.

**📉 Token Efficiency:** MCP servers expose full JSON Schema tool descriptions to the LLM on every request. Pi extensions use **prompt snippets** — concise one-line descriptions (~50-120 tokens vs ~300-800 for MCP). Full schema is only loaded when the tool is actually called. Saves thousands of tokens per turn.

#### 5.3 What's in the box — File Manifest

| File/Path | What it is |
|-----------|------------|
| `.pi/extensions/ranked-map.ts` | `ranked_map` tool — unified codebase mapper (auto-mode: ranked/full dump) via ctags + rg + git recency |
| `.pi/extensions/structural-analyzer.ts` | `structural_search` tool via ast-grep |
| `.pi/extensions/ripgrep-search.ts` | `ripgrep_search` tool via ripgrep |
| `.pi/extensions/crawl4ai/` | `web_crawl` tool: local crawl4ai → Apify → HTTP fallback |
| `.pi/extensions/supervisor/` | Kanban-driven multi-agent orchestration |
| `.pi/extensions/context-info/` | Rich TUI status bar, welcome banner, TPS |
| `.pi/extensions/session-logger/` | Session logging to JSONL |
| `.pi/extensions/agent-harness/` | Runtime tool call validation — blocks `bash | grep`, `cat` file reads, redundant reads, error retry loops, same-tool cascades |
| `.pi/extensions/ask-user/` | Interactive MC questions + CSV logger |
| `.pi/extensions/caveman/` | Token-efficient communication protocol |
| `.pi/extensions/format-on-save/` | Auto Prettier + ESLint after write/edit |
| `.pi/extensions/lsp-auditor/` | LSP diagnostics pre-audit for supervisor |
| `.pi/extensions/piignore.ts` | `.piignore` path blocking |
| `.pi/extensions/tsc-checkpoint.ts` | `/check` command: `tsc --noEmit` |
| `.pi/extensions/session-advice/` | Session advice — improvement recommendations per session |
| `.pi/extensions/check-extensions/` | `/check-extensions` — audit extensions against pi CHANGELOG API changes |
| `.pi/agents/researcher.md` | Researcher agent (pipeline step 1) |
| `.pi/agents/architect.md` | Architect agent (pipeline step 2) |
| `.pi/agents/test-designer.md` | TestDesigner agent (pipeline step 3) |
| `.pi/agents/developer.md` | Developer agent (pipeline step 4) |
| `.pi/agents/auditor.md` | Auditor agent (pipeline step 5) |
| `scripts/session-advice.ts` | Post-hoc batch session analysis runner |
| `scripts/session-advice.sh` | Shell wrapper for session-advice.ts |
| `.pi/settings.json` | Supervisor + context status bar config |
| `.pi/themes/agentcastle.json` | Dark cyberpunk TUI theme |
| `.pi/prompts/issue-cutter.md` | Epic → sub-issues with layer labels |
| `.pi/prompts/issue-refinement.md` | Socratic interview + MC refinement |
| `.pi/prompts/extension-spec.md` | Extension design PRD generator |
| `.pi/prompts/handover.md` | Session handover document |
| `.pi/prompts/quiz-master.md` | PR review quiz + auto-merge |
| `.piignore` | Agent path blocking (gitignore syntax) |
| `AGENTS.md` | Caveman protocol (active every session) |
| `scripts/setup-github-project.sh` | Create GitHub Project from settings |
| `scripts/session-query.sh` | Query JSONL session logs with jq |
| `Makefile` | Deprecated — see `./agent-castle.sh` for Docker-based launch |
| `test/` | 27+ unit/integration test files |
| `flask_blogs/` | Submodule: Flask blog apps |

#### 5.4 Extensions Deep Dive

Pi auto-discovers extensions from `.pi/extensions/` in the **project root**. No config file needed. No `--extension` flag.

| Extension | Purpose |
|-----------|---------|
| **Ranked Repo Map** | `ranked_map` via ctags + rg + git recency. Auto-mode: query → ranked, no query + small repo → full dump, no query + large repo → recency-ranked. Replaces map_codebase. |
| **Structural Analyzer** | `structural_search` via ast-grep. AST-aware pattern matching (function calls, try/catch, class defs). |
| **Ripgrep Search** | `ripgrep_search` via ripgrep. Fast literal/regex code search, respects `.gitignore`. |
| **Supervisor** | Kanban-driven multi-agent pipeline. Reads issue from GitHub project, dispatches agents in loop. Registers `/supervisor <issue-number>` command. |
| **Web Crawler** | `web_crawl`: local crawl4ai → Apify cloud → HTTP fallback. Auto-installs venv + Chromium deps. |
| **Context Info** | Rich TUI status bar (branch, model, tokens, TPS), welcome banner, animated working indicator. |
| **Session Logger** | Logs sessions to `.pi/sessions/<id>.jsonl`. Generates `.md` reports with sub-agent output from supervisor pipeline. Toggle with `/session-logger`. Query with `scripts/session-query.sh`. |
| **Session Advice** | Analyzes each session after shutdown for inefficient patterns. Generates `.advice.md` with fix recommendations. Post-hoc batch analysis via `scripts/session-advice.ts`. Report with `/session-advice report`. |
| **Agent Harness** | Runtime tool call validation via `agent-harness` extension. Blocks `bash` with `grep`/`rg` (redirects to `ripgrep_search`), `bash` with `cat`/`head`/`tail` (redirects to `read`). Caches reads to prevent redundant file reads. Tracks errors per tool to block retry loops (2+ errors). Tracks consecutive same-tool calls to break cascades (4+). Complements Session Advice (post-hoc) with runtime prevention. |
| **Caveman Protocol** | Token-efficient communication. Active via `AGENTS.md`. Configurable intensity levels. |
| **Ask User** | Interactive MC picker for AI-to-user questions. Uses arrow-key navigation + CSV logging. |
| **Format on Save** | Auto-formats TS/JS with Prettier + ESLint --fix after write/edit. Non-blocking lint warnings. |
| **PiIgnore** | Blocks paths matching `.piignore` patterns from read/write/edit/bash. Supports negation (`!`). |
| **TSC Checkpoint** | `/check` command runs `tsc --noEmit` on worktree. Used in pipeline Implementation→Audit. |
| **Check Extensions** | `/check-extensions` parses pi CHANGELOG.md, scans `.pi/extensions/` for affected API usage, creates GitHub issues with `extension-audit` label for each extension needing updates. Skips duplicates. |
| **LSP Auditor** | Runs real LSP diagnostics on modified files before merge. Groups by server, auto-retry (max 3). Called by supervisor. |

#### 5.5 Agent Definitions

Agents are Markdown files in `.pi/agents/` with YAML frontmatter. The supervisor reads them at runtime.

| Agent | File | Tools |
|-------|------|-------|
| **Researcher** | `researcher.md` | read, bash, structural_search, ripgrep_search |
| **Architect** | `architect.md` | read, bash, structural_search, ripgrep_search |
| **TestDesigner** | `test-designer.md` | read, bash, structural_search, ripgrep_search |
| **Developer** | `developer.md` | read, bash, write, edit, structural_search, ripgrep_search |
| **Auditor** | `auditor.md` | read, bash, structural_search, ripgrep_search |

All agents use `opencode-go/deepseek-v4-flash` model. Developer additionally uses format-on-save and tsc-checkpoint extensions.

#### 5.6 Prompt Templates

Invocable via `/name` in Pi's editor:

| Template | Usage | What it does |
|----------|-------|-------------|
| **issue-cutter** | `/issue-cutter <number>` | Split epic into ordered, testable sub-issues with layer labels. Auto-links children to parent via GraphQL. |
| **issue-refinement** | `/issue-refinement <number>` | Grill issue against codebase, Socratic interview via `ask_user` (≥3 MC options), replace body with concrete ACs. |
| **extension-spec** | `/extension-spec <idea>` | Design new extension or refactor existing one. Researches pi docs, audits TypeScript, produces PRD. |
| **handover** | `/handover` | Write handover doc summarizing conversation. Saves to `tmp/` with datetime prefix. |
| **model-select** | `/model-select <objective>` | Research + recommend models per agent role. Crawls providers, benchmarks, pricing. Three objectives: cost-optimized, performance-optimized, balanced. Applies `model:` field in agent files. |
| **quiz-master** | `/quiz-master` | List open PRs across repo + submodules, quiz reviewer on diff with MC questions, auto-merge if score ≥80%. |

#### 5.7 Tool Benchmark

Empirical token consumption comparing tool configurations on a real audit task ("Audit test coverage of chart/figure generation methods"). Config 4 (ripgrep) is the most token-efficient tool-enabled config.

| Config | Avg Input | Avg Output | Avg Total | Avg Duration | vs Config 2 (total) |
|--------|----------|-----------|-----------|-------------|-------------------|
| 1 — no tools | 15 | 959 | 1,870 | 15,842ms | — |
| 2 — mapper | 14,958 | 7,028 | 281,506 | 76,133ms | baseline |
| 3 — mapper + structural | 24,264 | 5,056 | 299,784 | 62,461ms | +6% |
| **4 — mapper + structural + rg** | **15,248** | **4,131** | **204,532** | **51,345ms** | **-27%** |
| **5 — ranked_map (query)** | **~1,500** | **~500** | **~2,000** | **~30,000ms** | **-99%** |

Config 4 uses **27% fewer total tokens** and runs **33% faster** than mapper-only (config 2). The ripgrep fix resolved the earlier issue where ripgrep made token consumption worse.

The agent footer also shows a **TPS (tokens-per-second)** gauge during streaming, computed from a rolling 30s window, plus worktree name in brackets next to the branch when inside a git worktree.

> Run with `scripts/benchmark-tools.sh` (2 runs per config). Results saved to `scripts/benchmark-results/`.

#### 5.8 Skills

Currently **no skills installed** (`.pi/skills/.gitkeep`). Skills are used sparingly in this project — every skill's description injects ~50-150 tokens into the context window on every turn, causing [context rot](https://docs.anthropic.com/en/docs/build-with-claude/context-windows). Prefer extensions (concise prompt snippets) or prompt templates (lazy-loaded) over skills.

---

### 6. Verification — Does everything work?

All checks run inside the container (after `./agent-castle.sh`).

#### 6.1 Environment

```bash
echo $APIFY_TOKEN   # Should print your token
```

#### 6.2 Tool Verification

```bash
# Codebase mapper — unified tool (replace old map_codebase use)
pi "Run ranked_map on the root"

# Ranked search (pass query for keyword scoring)
pi "Call ranked_map with query='login auth' tokenBudget=2048"

# Structural search
pi "Use structural_search to find all console.log calls in TypeScript files"

# Text search
pi "Use ripgrep_search to find 'TODO' in the project"
```

#### 6.3 Pi Autonomy

```bash
pi "Respond with exactly one word: 'Operational'."
```

#### 6.4 Execution Routing (Acid Test)

```bash
pi -p "Create a file named '.pi/test-file.txt' with the content 'container works', then tell me the absolute path where it was created."
```

**Expected:** `/workspaces/main/.pi/test-file.txt`

---

### 7. Daily Use — How to work with AgentCastle

#### 7.1 Project Setup (one-time per GitHub project)

Create a GitHub Project (v2) with Kanban statuses from `.pi/settings.json`:

```bash
./scripts/setup-github-project.sh
```

The script reads `supervisor.statusMapping`, prompts for a project name, creates the project under the `supervisor.repo` owner, adds a `Workflow` single-select field with your custom statuses, and writes the project number back to `settings.json`.

Switch the project to **Board** layout in the browser and change **Group by** to `Workflow`.

#### 7.2 Daily Commands

| Action | Command |
|--------|---------|
| Start session | `pi` |
| Run supervisor pipeline | `/supervisor <issue-number>` |
| Run TSC type-check | `/check` |
| Toggle session advice | `/session-advice on` / `/session-advice off` |
| Session advice report | `/session-advice report` — generates report, prompts cleanup + GitHub issue creation |
| Batch advice analysis | `npx tsx scripts/session-advice.ts` (all) or `--latest` |
| Toggle session logger | `/session-logger on` / `/session-logger off` |
| Toggle caveman level | `/caveman` (cycle: lite → full → off) or `/caveman lite` |
| Query session logs | `./scripts/session-query.sh 'select(.role == "user")'` |
| Design an extension | `/extension-spec <idea>` |
| Write handover | `/handover` |
| Quiz PR reviewer | `/quiz-master` |
| View session logs | `ls .pi/sessions/` |
| Reload config | `/reload` (after editing .piignore, settings.json, etc.) |

#### 7.3 Session Logger Details

Commands: `/session-logger`, `/session-logger on`, `/session-logger off`

Output formats:

- **JSONL log**: `.pi/sessions/<datetime>_<uuid>.jsonl` — event stream per session
- **Markdown report**: `.pi/sessions/<sessionId>.md` — human-readable session summary
- **Metadata**: `.pi/sessions/<sessionId>.metadata.json` — structured session metadata
- **Advice**: `.pi/sessions/<sessionId>.advice.md` — improvement recommendations (see 7.3b)
- **Latest symlinks**: `.pi/sessions/latest.*` — convenience symlinks to most recent report/metadata/advice

Each session produces uniquely-named `.md` and `.metadata.json` files (keyed by `sessionId`), so no data is overwritten between sessions.

The markdown report includes sub-agent output from supervisor pipeline agents
(developer, auditor, researcher, test-designer). Each sub-agent turn is rendered
with agent header, status, tool count, token count, duration, thinking blocks,
tool calls and results, raw output (collapsed), and audit score. Failed sub-agents
show error output. Sub-agent entries are clearly distinguished from primary
turns via `### Agent:` heading level.

The JSONL log is a newline-delimited JSON event stream: messages, thinking blocks, tool calls, compactions.

```bash
./scripts/session-query.sh 'select(.role == "user")'
cat .pi/sessions/latest.jsonl | ./scripts/session-query.sh 'select(.tool == "bash")'
```

#### 7.3b Session Advice

**Extension:** `session-advice` (`.pi/extensions/session-advice/`)

Detects inefficient patterns in each session and writes `.advice.md` alongside the session files.

**Patterns detected:**

| Pattern | Severity | Example |
|---------|----------|---------|
| Tool mismatch | error | `bash \| grep` instead of `ripgrep_search` |
| Error not actioned | error | Tool errors, then retries same tool 4x |
| Identical call loop | error | Same tool+args 3x in last 12 calls |
| Same-tool cascade | warning | `bash` called 12x consecutively |
| Tool coverage gap | warning | Code files present but `structural_search` unused |
| Structural-search underuse | warning | 3+ code files read/edited, `structural_search` never called |
| Redundant reads | warning | Same file read 3x within 2 turns |
| Immediate redundant read | warning | Same file read again within 1 turn |
| Excessive turns | warning | 20+ tool calls with no file changes |

**Feedback loop (before_agent_start):** On next session start, reads `latest.advice.md` and injects top 3 past findings as `⚠️ Past Session Lessons` into system prompt — agent learns from its own mistakes without manual intervention.

**Per-session advice** — automatic on session shutdown:
- `session_shutdown` hook generates `.advice.md` for the closing session
- `session_start` recovery generates advice for any past sessions missing it
- `latest.advice.md` symlink points to most recent advice
- `before_agent_start` injects past lessons into next session's system prompt

**Cross-session report** — manual, run via:
```
/session-advice report
```
Aggregates all sessions into `advice-report.md` with:
- Priority summary table (🔴 High / 🟡 Medium / 🟢 Low) with severity + example
- Per-category detail with sample findings, fix idea, effort estimate (Low/Medium/High)
- Per-session findings breakdown

After report generation, user is prompted to **clean up** the sessions folder (delete raw `.jsonl`, `.md`, `.metadata.json`) and then asked whether to **create a GitHub issue** from the report in the project repo (read from `supervisor.repo` in `.pi/settings.json`). Report file is preserved.

**Batch analysis** (post-hoc for past sessions):
```bash
npx tsx scripts/session-advice.ts              # all sessions
npx tsx scripts/session-advice.ts --latest     # latest only
npx tsx scripts/session-advice.ts 2026-05-23   # by prefix
```

#### 7.4 Context & Templates

| Type | File | Behavior |
|------|------|----------|
| **Always-on** | `AGENTS.md` in project root | Concatenated and appended to system prompt every turn |
| **On-demand** | `.pi/prompts/*.md` | Invoked manually via `/prompt-name` in Pi's editor |

`AGENTS.md` contains the caveman protocol (communication style + tool routing) and **🛠 Tool Discipline** section (pre-call checklist, DO/DON'T table, error recovery procedure, batching triggers). Each agent `.md` in `.pi/agents/` also has a role-specific Tool Discipline box at top. Active automatically every session.

---

### 8. Power User — The Multi-Agent Pipeline

The supervisor (`/supervisor <issue-number>`) is the heart of this harness. It takes a GitHub issue, runs it through 5 agent stages in a Kanban loop, creates git worktrees, runs quality gates, and creates pull requests — all autonomously.

#### 8.1 Pipeline Flow

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

#### 8.2 Agent Deep Dive

| # | Agent | Entry Marker | Completion Marker | Tools | Thinking | Role |
|---|-------|-------------|-------------------|-------|----------|------|
| 1 | **Researcher** | `Research` | `RESEARCH_COMPLETE` | read, bash, structural_search, ripgrep_search | medium | Crawls 3-5 web pages on issue topic, synthesizes findings. Posts `## Research Findings`. Never makes recommendations. |
| 2 | **Architect** | `Architecture` | `ARCHITECTURE_COMPLETE` | read, bash, structural_search, ripgrep_search | high | Applies Clean Architecture, PEAA, Philosophy of Software Design principles. Proposes target architecture. |
| 3 | **TestDesigner** | `TestDesign` | `TEST_PLAN_COMPLETE` | read, bash, structural_search, ripgrep_search | medium | Writes test plan: unit, integration, characterization tests. |
| 4 | **Developer** | `Implementation` | `IMPLEMENTATION_COMPLETE` | read, bash, write, edit, structural_search, ripgrep_search | low | Implements code in pre-created worktree, commits, pushes. Handles submodule changes. |
| 5 | **Auditor** | `Audit` | `AUDIT_APPROVED` or `AUDIT_REJECTED` | read, bash, structural_search, ripgrep_search | medium | Reviews code against architecture + test plan. Creates PR if approved, or rejects with specifics. |

#### 8.3 Git Worktree Lifecycle

Each issue gets an **isolated git worktree**. This prevents agents from interfering with each other and keeps `main` clean.

**Branch naming:** `worktree-git-issue-<number>-<title-slug>` (e.g., `worktree-git-issue-42-add-user-authentication`)

**Worktree path:** `../worktree-git-issue-<number>-<title-slug>/`

**Lifecycle (supervisor-owned):**

```
1. Supervisor creates worktree before Developer dispatch
   └── git worktree add -b <branch> ../<branch> <defaultBranch>

2. Supervisor dispatches Developer agent with cwd=<worktree-path>
   └── Agent tools (write, edit, bash, read) resolve against worktree

3. Developer implements, commits, pushes (inside worktree via cwd)
   ├── git add -A
   ├── git commit -m "feat(#42): Add user auth"
   └── git push origin <branch>

4. Supervisor dispatches Auditor agent with same cwd=<worktree-path>
   └── git diff <defaultBranch>

5. On approval: Auditor creates PR
   └── gh pr create --repo owner/repo --base <defaultBranch> --head <branch> --title "feat(#42): ..." --body "Closes #42"

6. Post-pipeline: supervisor cleans up worktree
   ├── git worktree remove --force ../<branch>
   ├── git worktree prune
   └── git branch -D <branch>
```

**Key rules:**
- Worktree is created and owned by the supervisor pipeline — agents never create or remove worktrees
- Agent cwd is set to worktree path automatically — no `cd` needed in agent tasks
- All Git operations happen inside the worktree (tools resolve against cwd)
- Worktree persists across feedback loops (auditor reject → re-implement)
- Supervisor cleans up worktree after pipeline completes (success, failure, or stop)
- Configurable via `supervisor.worktreeBase` and `supervisor.branchPrefix` in `.pi/settings.json`

#### 8.4 Submodule Strategy

When the repo has submodules, the Developer works on **both repos simultaneously** using a **matched-branch pattern**:

```
Main repo (agentcastle)          Submodule (flask_blogs)
│                                │
├─ Branch: worktree-git-...     ├─ Branch: worktree-git-... (same name)
├─ Commit includes submodule    ├─ Actual code changes
│  pointer update (pinned SHA)  │
└───────────────────────────────┴───────────────────────────────
```

**Detailed workflow:**

```
## Issue #42 "Add user auth"

# 1. Create worktree for agentcastle
git worktree add ../worktree-git-issue-42-add-user-authentication main
cd ../worktree-git-issue-42-add-user-authentication

# 2. Init submodule (arrives in detached HEAD — by design)
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

**Why submodule must be pushed first:** The agentcastle commit records a specific submodule SHA. If that SHA only exists locally, teammates get `fatal: reference is not a tree`. The `push.recurseSubmodules check` config blocks the push if submodule commits haven't been pushed — a safety net, not a replacement for correct order.

**Why submodules start in detached HEAD:** Git submodules pin a specific commit, not a branch. `git submodule update` checks out that exact commit. You must explicitly checkout a branch to make editable changes — standard Git behavior.

**Result:** Two branches with same name exist:
- `agentcastle:worktree-git-issue-42-add-user-authentication`
- `flask_blogs:worktree-git-issue-42-add-user-authentication`

**Disk usage note:** Each worktree clones submodules independently (under `.git/worktrees/<name>/modules/`). Not shared across worktrees — known Git design tradeoff.

**Auditor PR creation order:**

```
Step 1 — Create submodule PR FIRST (if submodule has changes):
  cd flask_blogs
  gh pr create --repo owner/flask_blogs --base main --head <branch> --title "feat(#42): ..."

Step 2 — Create main repo PR SECOND (includes submodule pointer):
  gh pr create --repo owner/agentcastle --base main --head <branch> --title "feat(#42): ..." --body "Closes #42"
```

#### 8.5 Quality Gates

Before transitioning `Implementation → Audit`, the supervisor runs two checks on the worktree:

**1. TSC Checkpoint** (`tsc-checkpoint` extension)
- Runs `npx tsc --noEmit` on the worktree
- Only runs if `tsconfig.json` exists
- Non-blocking if tsc binary not found

**2. LSP Pre-Audit** (`lsp-auditor` extension)
- Runs real LSP diagnostics on **modified files only** (git diff vs `defaultBranch`)
- Groups files by language server (TypeScript, Python, ESLint, etc.)
- Each group audited concurrently via separate LSP server process
- Auto-retries on errors (max 3 attempts), exponential backoff
- Only blocks if LSP server is available AND reports errors

**Decision table:**

| TSC | LSP | Outcome |
|-----|-----|---------|
| pass | pass | → Audit |
| pass | fail | → Implementation (retry LSP, max 3) |
| pass | N/A (no LSP) | → Audit |
| fail | (skipped) | → Implementation |
| N/A (no tsconfig) | pass | → Audit |

#### 8.6 Merge Conflict Resolution

After pipeline reaches `Done`, supervisor checks the created PR for merge conflicts:

```
PR created (pipeline done)
  └─ gh pr view ... --json mergeable
       ├─ No conflict → done
       └─ Conflict?
            └─ Ask user: fix? (ctx.ui.confirm)
                 ├─ Yes → auto-merge attempt (git merge base)
                 │    ├─ Success → git push → done
                 │    └─ Fail → dispatch Developer agent to resolve
                 └─ No → done
```

#### 8.7 GitHub Interaction

The supervisor interacts with GitHub on every step:

| Action | Method | Purpose |
|--------|--------|---------|
| `gh issue view <N> --json ...` | pi.exec | Fetch issue data (pre-filtered to trusted codeowners) |
| `gh project view <projectNumber> ...` | pi.exec | Get field IDs for status options |
| `gh project item-list <projectNumber> ...` | pi.exec | Find issue's project item, read current status |
| `gh api graphql ...` (set status) | pi.exec | Move issue to next status on board |
| `gh issue comment <N> --repo <R> --body <B>` | pi.exec | Agent posts structured comment |
| `gh pr create --repo <R> --base <B> --head <H>` | pi.exec | Auditor creates PR on approval |
| `gh pr view <branch> --json ...` | pi.exec | Post-pipeline merge conflict check |

**Security:** All issue data is **pre-filtered** before reaching agents — only the body (if author is a codeowner) and comments from trusted codeowners are passed. The agent is explicitly instructed: "Use ONLY the issue data provided above. Do NOT run `gh issue view`." This prevents prompt injection via untrusted issue comments.

#### 8.8 Configuration Reference

All supervisor settings in `.pi/settings.json` under the `supervisor` key:

```jsonc
{
  "supervisor": {
    "repo": "SchneiderDaniel/agentcastle",        // REQUIRED — owner/repo format
    "projectNumber": 3,                            // REQUIRED — GitHub Project (v2) number
    "statusMapping": {                              // REQUIRED — board status → agent file
      "Research": "researcher",
      "Architecture": "architect",
      "TestDesign": "test-designer",
      "Implementation": "developer",
      "Audit": "auditor"
    },
    "codeowners": ["SchneiderDaniel"],             // REQUIRED — trusted GitHub usernames
    "statusField": "Status",                       // Single-select field on project board
    "maxRejections": 5,                            // Max Auditor rejections before loop stops
    "remote": "origin",                            // Remote name for git push
    "defaultBranch": "main",                       // Worktree base and PR target
    "worktreeBase": "../",                         // Parent dir for worktrees
    "branchPrefix": "worktree-git-issue-",         // Prefix for auto-generated branch names
    "agentTimeoutsMin": {                          // Per-agent timeout (optional)
      "researcher": 10,
      "developer": 30
    },
    "submodules": [                                // Auto-parsed from .gitmodules if absent
      { "path": "flask_blogs", "repo": "Owner/flask_blogs" }
    ]
  }
}
```

#### 8.9 Complete Walkthrough

Here's what happens end-to-end when you run `/supervisor 42`:

```
You: /supervisor 42

── Step 1: Fetch ────────────────────────────────────────────────
Supervisor reads .pi/settings.json → repo, project board, statuses
Fetches issue #42 from GitHub, filters to trusted codeowners only
Reads issue's current status from project board → "Research"

── Step 2: Researcher ───────────────────────────────────────────
Spins up agent with researcher system prompt + issue data
Agent crawls 3-5 web pages about the issue topic
Posts:  gh issue comment 42 --repo owner/repo --body "## Research Findings..."
Outputs: RESEARCH_COMPLETE
Supervisor moves issue → "Architecture" on board

── Step 3: Architect ────────────────────────────────────────────
Spins up agent with architect prompt + issue + research findings
Analyzes codebase using read, bash, structural_search, ripgrep_search
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
Supervisor creates worktree:  git worktree add -b <branch> ../<branch> main
Spins up agent with developer prompt + issue + arch + test plan, cwd=<worktree-path>
  Implements feature, runs tests, formats code
  git add -A && git commit -m "feat(#42): ..."
  git push origin <branch>
Outputs: IMPLEMENTATION_COMPLETE

── Step 6: Quality Gates ────────────────────────────────────────
  TSC: runs npx tsc --noEmit on worktree → pass
  LSP: runs diagnostics on modified files → pass
Supervisor moves issue → "Audit"

── Step 7: Auditor ──────────────────────────────────────────────
Spins up agent with auditor prompt + all previous data, cwd=<worktree-path>
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

> **Note:** The walkthrough above shows the updated pipeline: dependency gate, in-process agent execution (live TUI widget), architecture-before-research sequence, auditor summary file protocol, and post-pipeline merge conflict resolution.

---

### 9. Troubleshooting — Something broke

#### Container doesn't start

Rebuild the image without cache:

```bash
docker compose build --no-cache
./agent-castle.sh
```

#### Web crawl fails with Chromium errors

The extension auto-installs system libraries inside the container. If it persists:

```bash
rm -rf .pi/crawl4ai-venv .pi/chromium-deps    # Next call auto-recreates
```

#### Permission errors on bind-mounted files

UID/GID mapping is automatic via `agent-castle.sh`. If you need to run manually:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up
```

#### `gh auth status` shows "not logged in"

Inside the container, run:

```bash
gh auth login
```

Authenticate with **Login with a web browser**.

#### `.piignore` blocking legitimate paths

Edit `.piignore` and add a negation pattern:
```
!path/to/allow
```
Reload: `/reload`

---

### 10. Contributing — I want to help

Contributions welcome — bug reports, feature requests, documentation improvements, new extensions.

1. Fork the repository
2. Create a feature branch (`git worktree add -b feature/amazing feature-amazing` is the recommended workflow)
3. Make your changes
4. Run tests: `npm test` (runs all 27+ test files)
5. Submit a PR

---

## Appendix

### SBOM — Software Bill of Materials

| Component | Version | License | Type | Supplier/URL |
|-----------|---------|---------|------|-------------|
| **Runtime & Core** | | | | |
| @earendil-works/pi-coding-agent | ^0.74.0 | MIT | dev | [pi.dev](https://pi.dev) |
| @earendil-works/pi-agent-core | 0.74.0 | MIT | transitive | [pi.dev](https://pi.dev) |
| @earendil-works/pi-ai | 0.74.0 | MIT | transitive | [pi.dev](https://pi.dev) |
| @silvia-odwyer/photon-node | 0.3.4 | MIT | transitive | [github.com/silvia-odwyer/photon-node](https://github.com/silvia-odwyer/photon-node) |
| jiti | 2.7.0 | MIT | transitive | [github.com/unjs/jiti](https://github.com/unjs/jiti) |
| **AI Providers** | | | | |
| @anthropic-ai/sdk | 0.91.1 | MIT | transitive | [anthropic.com](https://www.anthropic.com) |
| openai | 6.26.0 | Apache-2.0 | transitive | [openai.com](https://openai.com) |
| @aws-sdk/client-bedrock-runtime | 3.1041.0 | Apache-2.0 | transitive | [aws.amazon.com](https://aws.amazon.com) |
| @aws-crypto/sha256-browser | 5.2.0 | MIT | transitive | [aws.amazon.com](https://aws.amazon.com) |
| **Schema & Validation** | | | | |
| typebox | 1.1.37 | MIT | transitive | [github.com/typebox/typebox](https://github.com/typebox/typebox) |
| zod | 4.4.2 | MIT | transitive | [zod.dev](https://zod.dev) |
| **Formatter** | | | | |
| prettier | ^3.8.3 | MIT | dev | [prettier.io](https://prettier.io) |
| **TUI & UI** | | | | |
| @earendil-works/pi-tui | ^0.74.0 | MIT | prod | [pi.dev](https://pi.dev) |
| boxen | ^7.1.1 | MIT | prod | [github.com/sindresorhus/boxen](https://github.com/sindresorhus/boxen) |
| **LSP** | | | | |
| vscode-jsonrpc | ^8.2.1 | MIT | prod | [github.com/microsoft/vscode-jsonrpc](https://github.com/microsoft/vscode-jsonrpc) |
| **TypeScript** | | | | |
| typescript | ^6.0.3 | Apache-2.0 | dev | [typescriptlang.org](https://www.typescriptlang.org) |
| **Utilities** | | | | |
| fast-xml-parser | 5.7.2 | MIT | transitive | [github.com/NaturalIntelligence/fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) |
| tslib | 2.8.1 | 0BSD | transitive | [github.com/microsoft/tslib](https://github.com/microsoft/tslib) |
| yoctocolors | 2.1.2 | MIT | transitive | [github.com/sindresorhus/yoctocolors](https://github.com/sindresorhus/yoctocolors) |
| std-env | 3.10.0 | MIT | transitive | [github.com/unjs/std-env](https://github.com/unjs/std-env) |
| **System Runtimes** | | | | |
| Node.js | ≥22 | MIT | system | [nodejs.org](https://nodejs.org) |
| Python 3 | ≥3.10 | PSF | system | [python.org](https://python.org) |
| npm | latest | Artistic-2.0 | system | [npmjs.com](https://npmjs.com) |
| **Infrastructure Tools** | | | | |
| GitHub CLI (gh) | latest | MIT | system | [cli.github.com](https://cli.github.com) |
| AST-grep | ≥0.42 | MIT | system | [ast-grep.github.io](https://ast-grep.github.io) |
| Universal Ctags | latest | GPL-2.0 | system | [ctags.io](https://ctags.io) |
| ripgrep (rg) | latest | MIT | system | [github.com/BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) |
| **Web Crawling (Python venv)** | | | | |
| crawl4ai | latest | Apache-2.0 | venv | [github.com/unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) |
| Playwright Chromium | latest | Apache-2.0 | venv | [playwright.dev](https://playwright.dev) |
| **Project Extensions (`.pi/extensions/`)** | | | | |
| ranked-map.ts | — | MIT | project | This repository (unified ctags mapper)
| structural-analyzer.ts | — | MIT | project | This repository |
| ripgrep-search.ts | — | MIT | project | This repository |
| caveman/ | — | MIT | project | This repository |
| crawl4ai/ | — | MIT | project | This repository |
| session-logger/ | — | MIT | project | This repository |
| ask-user/ | — | MIT | project | This repository |
| supervisor/ | — | MIT | project | This repository |
| format-on-save/ | — | MIT | project | This repository |
| context-info/ | — | MIT | project | This repository |
| lsp-auditor/ | — | MIT | project | This repository |
| piignore.ts | — | MIT | project | This repository |
| tsc-checkpoint.ts | — | MIT | project | This repository |

> **License Compliance:** All components use OSI-approved open-source licenses (MIT, Apache-2.0, 0BSD, PSF, Artistic-2.0). No GPL/AGPL copyleft. No proprietary or source-available licenses. Total transitive dependency count: ~256 packages (`npm ls --all`).
>
> **SBOM Generation:** This table is manually maintained. For automated CycloneDX/SPDX SBOM: `npx cyclonedx-npm` + `pip freeze | cyclonedx-py` in `.pi/crawl4ai-venv/`.

### Security

**Security properties:**

- ✅ No MCP servers — only pi extensions (no network-exposed tool servers)
- ✅ API keys loaded from `.agent_env` (repo root), never committed
- ✅ `.piignore` path blocking — block sensitive files from agent read/write/edit/bash
- ✅ **npm package age gate** — agent refuses to install npm packages < 14 days old (typosquatting protection)

### License

MIT © 2025. See [LICENSE](./LICENSE) for full text.

All third-party components are OSI-approved open source (see [SBOM](#sbom--software-bill-of-materials)).

### Legacy Installation (host-level)

For users who prefer a host-level install (Node.js, apt packages, Pi on bare metal), the original install scripts are preserved in `scripts/legacy/`:

| File | Purpose |
|------|---------|
| `scripts/legacy/install.sh` | Automated apt + npm install for Ubuntu/Debian hosts |
| `scripts/legacy/postinstall.sh` | Patch Pi footer pipe separator |

These scripts are **deprecated** — the Docker workflow is the supported path. They remain for reference and for users who cannot run Docker.

### Acknowledgments

Built on top of these excellent projects:

**Runtime & Tools:**
- [Pi Coding Agent](https://pi.dev) — The agent runtime
- [crawl4ai](https://github.com/unclecode/crawl4ai) — LLM-friendly web crawler
- [Zed](https://zed.dev) — The editor

**Agent Best Practices:**
- [shanraisshan/claude-code-best-practice](https://github.com/shanraisshan/claude-code-best-practice) (52k ★) — Agentic engineering patterns, context management, sub-agent workflows
- [ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books) (1.3k ★) — AI agent rules distilled from classic software engineering books:
  - **Architect agent:** Clean Architecture (R. Martin), PEAA (M. Fowler), A Philosophy of Software Design (J. Ousterhout)
  - **Developer agent:** Clean Code (R. Martin), Code Complete (S. McConnell), The Pragmatic Programmer (Hunt & Thomas)
- [WoJiSama/skill-based-architecture](https://github.com/WoJiSama/skill-based-architecture) (224 ★) — AI agent rule system lifecycle
- [charles-adedotun/claude-code-sub-agents](https://github.com/charles-adedotun/claude-code-sub-agents) (30 ★) — Agent-architect bootstrapper pattern

**Communication & Workflow:**
- [Caveman](https://github.com/JuliusBrussee/caveman) — Token-efficient AI communication protocol
- [pi-caveman](https://github.com/jonjonrankin/pi-caveman) — Multi-level caveman mode for Pi
- [Matt Pocock's Skills — improve-codebase-architecture](https://github.com/mattpocock/skills/tree/main/skills/engineering/improve-codebase-architecture) — Architecture deepening methodology integrated as `.pi/skills/improve-codebase-architecture/`. Also inspiration for `issue-refinement` prompt pattern.

**Extensions & Tools:**
- [Pi SDK & Extensions Documentation](https://pi.dev/docs/latest) — Extension API, commands, hooks, theme system
- [ast-grep](https://ast-grep.github.io) — Structural code search via Tree-sitter AST
- [ripgrep](https://github.com/BurntSushi/ripgrep) — Ultra-fast literal/regex code search
- [universal-ctags](https://ctags.io) — Codebase symbol indexing
test change
