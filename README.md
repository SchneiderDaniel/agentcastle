# Agentcastle: The Pi Stack

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.72.1-6e3bf0)](https://pi.dev)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Secure, local-first AI development environment.**
WSL (Ubuntu) + Zed + Git Worktrees + Pi AI — sandboxed execution, codebase intelligence, real-time feedback.

---

## What is this?

Agentcastle is a pre-configured AI coding harness that gives the [Pi coding agent](https://pi.dev) a full toolchain:

- **Sandboxed execution** — AI commands run in an isolated Daytona container, not on your host
- **Codebase knowledge graph** — Persistent index of your entire codebase (66 languages, 14 query tools)
- **Web crawling** — Three-tier fallback: local Chromium → Apify cloud → HTTP
- **Real-time code feedback** — LSP diagnostics, secrets scan, auto-format, lint cascade via [pi-lens](https://pi.dev/packages/pi-lens)
- **Session logging** — Every session saved as LLM-optimized markdown for later analysis
- **Extensions-based** — Secure pi extensions, no MCP servers

All components run locally. No code leaves your machine (except LLM API calls to your provider).

---

## What's in this repo vs what you set up

This repository contains the **configuration and extensions**. You clone it and get a ready-to-use AI harness. But you still need to install the **system-level tools** once on your machine.

### 📦 Already in this repository

| File/Path                           | What it is                              |
| ----------------------------------- | --------------------------------------- |
| `.pi/extensions/caveman.ts`         | Token-efficient communication protocol  |
| `.pi/extensions/codebase-memory.ts` | Codebase knowledge graph (14 tools)     |
| `.pi/extensions/crawl4ai.ts`        | Three-tier web crawler                  |
| `.pi/extensions/daytona-sandbox.ts` | Sandbox command router + auto-recovery  |
| `.pi/extensions/session-logger.ts`  | Session logging to markdown             |
| `.pi/settings.json`                 | Provider config + pi-lens package       |
| `.pi/prompts/review.md`             | Example prompt template                 |
| `AGENTS.md`                         | Caveman protocol (active every session) |
| `.cbmignore`                        | Codebase index exclusions               |
| `package.json`                      | Project metadata + test script          |
| `test/session-logger.test.mts`      | Session logger test                     |

### 🔧 You install once on your machine

| Tool                            | Why                                   |
| ------------------------------- | ------------------------------------- |
| Node.js ≥22 + npm               | Pi runtime                            |
| Python 3.10+ + venv + pip       | crawl4ai local web crawler            |
| Docker + Daytona                | Sandboxed command execution           |
| GitHub CLI (gh)                 | Git operations from Pi                |
| `@mariozechner/pi-coding-agent` | The agent itself (global npm install) |
| `codebase-memory-mcp` binary    | Code intelligence engine              |
| `pi-lens` (pi package)          | Real-time code feedback               |
| `~/.agent_env` file             | API keys (Apify token, etc.)          |
| `~/.bashrc` auto-start block    | Docker + env loading on WSL boot      |

> **Rule of thumb:** Sections marked 📦 describe files you already have after cloning. Sections marked 🔧 are commands you run once on your machine.

---

## Features

| Category             | Capability                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 🔒 **Sandbox**       | Daytona container isolates all AI-executed commands. Host file ops still work. Auto-recovery if sandbox stops.     |
| 🧠 **Code Intel**    | 14 tools: search, trace, query, overview, schema, snippet, grep, change detection, ADR management, trace ingestion |
| 🕷️ **Web Crawl**     | `web_crawl` tool: local crawl4ai (real Chromium) → Apify cloud actor → direct HTTP + regex extraction              |
| 🔍 **Code Feedback** | LSP diagnostics, secrets scan (blocking), tree-sitter rules, ast-grep security/correctness, format-on-save         |
| 📝 **Session Log**   | Full conversation + thinking blocks + tool calls saved as markdown + metadata JSON                                 |
| 🦴 **Caveman Mode**  | Token-efficient communication via `AGENTS.md` — active in every session                                            |
| 📋 **SBOM**          | Full software bill of materials included in this README                                                            |
| 🧩 **Extensions**    | Auto-discovered from `.pi/extensions/`. No config files, no MCP servers.                                           |

---

## Quick Start

```bash
# 1. Install prerequisites (one-time, Ubuntu 24.04 LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip python3-venv jq unzip
sudo npm install -g @mariozechner/pi-coding-agent
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --skip-config
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

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
  - [Docker & Daytona Sandbox](#docker--daytona-sandbox)
  - [GitHub CLI](#github-cli)
  - [Codebase Memory](#codebase-memory)
  - [Security & Environment](#security--environment)
  - [AI Provider Setup](#ai-provider-setup)
  - [Workspace & Git](#workspace--git)
- [📦 Architecture](#architecture)
  - [Extensions](#extensions)
  - [Codebase Intelligence](#codebase-intelligence)
  - [Real-Time Code Feedback (pi-lens)](#real-time-code-feedback-pi-lens)
- [📦 Daily Usage](#daily-usage)
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
sudo npm install -g @mariozechner/pi-coding-agent
```

---

## 🔧 Installation & Setup

### Docker & Daytona Sandbox

```bash
# Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER   # Restart WSL after this

# Daytona (manual install — fixes 404/silent errors from the official script)
sudo curl -L "https://github.com/daytonaio/daytona/releases/latest/download/daytona-linux-amd64" -o /usr/local/bin/daytona
sudo chmod +x /usr/local/bin/daytona

# Initialize sandbox
daytona login
daytona create --name pi-sandbox
```

### GitHub CLI

```bash
(type -p wget >/dev/null || sudo apt-get install wget -y)
sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update
sudo apt-get install gh -y
```

### Codebase Memory

```bash
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --skip-config
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

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
# 1. Start Docker silently if not running
if ! pgrep -x "dockerd" > /dev/null; then
    sudo service docker start > /dev/null 2>&1
fi

# 2. Load API keys
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
  "packages": ["npm:pi-lens"],
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
│  │  │pi-lens│  │Exts  │  │AI Provider   │  │  │
│  │  │LSP    │  │.pi/  │  │OpenCode Go   │  │  │
│  │  │lint   │  │exts/ │  │Anthropic/... │  │  │
│  │  └──────┘  └──┬───┘  └──────────────┘  │  │
│  │               │                          │  │
│  └───────────────┼──────────────────────────┘  │
└──────────────────┼─────────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
┌───▼────┐  ┌──────▼─────┐  ┌───▼──────────┐
│Daytona │  │Codebase    │  │crawl4ai      │
│Sandbox │  │Memory MCP  │  │Python venv   │
│(isolat-│  │(host index)│  │(host browser)│
│ed exec)│  │            │  │              │
└────────┘  └────────────┘  └──────────────┘
```

**Key principle:** AI commands execute in the sandbox. File-management commands (`rm`, `mkdir`, `mv`, `cp`, `touch`, `chmod`, `chown`) run on the host. Codebase intelligence and web crawling run on the host (read-only for code, network-only for crawl).

### Extensions

Pi auto-discovers extensions from `.pi/extensions/` in your **project root**. No `.pi.config.ts` file needed. No `--extension` flag needed.

| Extension            | File                 | Purpose                                                                                                        |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Sandbox Router**   | `daytona-sandbox.ts` | Routes bash commands into Daytona. Auto-recovers stopped/deleted sandboxes. Persistent volume at `/workspace`. |
| **Web Crawler**      | `crawl4ai.ts`        | Three-tier web crawling: local crawl4ai → Apify cloud → HTTP fallback. Auto-installs venv + Chromium deps.     |
| **Codebase Memory**  | `codebase-memory.ts` | Wraps codebase-memory-mcp CLI. Auto-indexes on session start. 14 tools exposed.                                |
| **Session Logger**   | `session-logger.ts`  | Logs sessions to `.pi/sessions/<id>/session.md` + `metadata.json`. Toggle with `/session-logger`.              |
| **Caveman Protocol** | `caveman.ts`         | Token-efficient communication style. Active via `AGENTS.md`.                                                   |

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

### Codebase Intelligence

Uses [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) — single static binary, zero runtime dependencies, 66 languages. The extension wraps the CLI via `pi.exec()`, bypassing the Daytona sandbox (the graph is a host-level index shared across sessions).

**Token savings:** Five structural queries consume ~3,400 tokens via the graph vs ~412,000 tokens via file-by-file grep — a **99.2% reduction**.

#### Tools Exposed

| Tool                      | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `codebase_search`         | Search graph by name pattern, label, file, degree             |
| `codebase_trace`          | BFS call-path traversal (inbound/outbound/both)               |
| `codebase_query`          | Cypher-like graph queries (MATCH...RETURN...)                 |
| `codebase_overview`       | Architecture: languages, packages, routes, hotspots, clusters |
| `codebase_get_schema`     | Graph schema: node labels, edge types, properties             |
| `codebase_snippet`        | Read source code by qualified name                            |
| `codebase_grep`           | Full-text search within indexed files                         |
| `codebase_detect_changes` | Git diff → affected symbols + risk classification             |
| `codebase_adr`            | CRUD for Architecture Decision Records                        |
| `codebase_index`          | Explicit re-index trigger                                     |
| `codebase_list_projects`  | List all indexed projects                                     |
| `codebase_index_status`   | Per-project indexing status                                   |
| `codebase_delete_project` | Remove project from graph                                     |
| `codebase_ingest_traces`  | Ingest runtime traces for HTTP edge validation                |

#### File Ignoring

`.cbmignore` in the project root excludes `.pi/chromium-deps/` and `.pi/crawl4ai-venv/` from indexing. Add patterns in gitignore syntax for vendored code, generated files, or large assets.

### Real-Time Code Feedback (pi-lens)

[pi-lens](https://pi.dev/packages/pi-lens) hooks into every write/edit for inline feedback.

```bash
pi install npm:pi-lens -l
```

| Hook              | Action                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **write/edit**    | Secrets scan (blocking), auto-format, auto-fix, LSP sync, dispatch lint (LSP + tree-sitter + ast-grep + fact rules + linters), cascade diagnostics |
| **agent_end**     | Deferred formatting, summary notification                                                                                                          |
| **session_start** | Reset state, detect language profile, warm caches, LSP warm-files, tool hints                                                                      |
| **turn_end**      | Impact cascade, deferred findings, debt tracking                                                                                                   |

#### Commands

| Command                   | Purpose                            |
| ------------------------- | ---------------------------------- |
| `/lens-booboo`            | Full quality report                |
| `/lens-health`            | Runtime health, latency, telemetry |
| `/lens-tools`             | Tool installation status           |
| `/lens-tdi`               | Technical Debt Index               |
| `/lens-allow-edit <path>` | Override read-guard for one edit   |

#### Optional Flags

```bash
pi --no-lsp           # Disable LSP diagnostics
pi --no-autoformat    # Skip auto-formatting
pi --immediate-format # Format per-edit instead of deferred
pi --no-autofix       # Skip auto-fix
pi --no-tests         # Skip test runner
pi --no-delta         # Show all diagnostics, not just new ones
```

---

## 📦 Daily Usage

### Workflows

| Action                | Command                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Start session**     | `pi`                                                                                                                       |
| **Check sandbox**     | `daytona list`                                                                                                             |
| **Restart Docker**    | `sudo service docker start`                                                                                                |
| **Reindex codebase**  | Use `codebase_index` tool inside pi, or `~/.local/bin/codebase-memory-mcp cli index_repository '{"repo_path":"'$(pwd)'"}'` |
| **View session logs** | `ls .pi/sessions/`                                                                                                         |

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
docker ps                    # Should output headers without permission errors
echo $APIFY_TOKEN            # Should print your token
```

### 2. Daytona Sandbox

```bash
daytona list                 # Look for 'pi-sandbox' in 'Running' state
daytona exec pi-sandbox -- echo "Sandbox active"
```

### 3. Pi Autonomy

```bash
pi "Respond with exactly one word: 'Operational'."
```

### 4. Codebase Memory

```bash
~/.local/bin/codebase-memory-mcp --version
~/.local/bin/codebase-memory-mcp cli index_repository "{\"repo_path\": \"$PWD\"}"
~/.local/bin/codebase-memory-mcp cli search_graph "{\"project\": \"$(echo $PWD | sed 's|^/||; s|/|-|g')\", \"name_pattern\": \".*\", \"label\": \"Function\", \"limit\": 5}"
```

_Expected:_ Index reports `"status":"indexed"` with node/edge counts. Search returns function names.

### 5. pi-lens

```bash
cat .pi/settings.json | grep pi-lens
pi list                      # pi-lens should appear
```

### 6. Execution Routing (Acid Test)

**Sandbox isolation:**

```bash
pi -p "Run 'uname -n' in bash and tell me the hostname."
```

_Expected:_ Pi reports the sandbox hostname (e.g., `pi-sandbox`), not your WSL hostname.

**Host file operations:**

```bash
pi -p "Create a file named '.pi/test-file.txt' with the content 'host works', then tell me the absolute path where it was created."
```

_Expected:_ File appears on host at `<project-root>/.pi/test-file.txt`.

> **Tip:** Test auto-recovery: `daytona stop pi-sandbox` then run a sandbox command. The extension should transparently restart it.

---

## SBOM — Software Bill of Materials

| Component                                  | Version  | License      | Type       | Supplier/URL                                                                                             |
| ------------------------------------------ | -------- | ------------ | ---------- | -------------------------------------------------------------------------------------------------------- |
| **Runtime & Core**                         |          |              |            |                                                                                                          |
| @mariozechner/pi-coding-agent              | ^0.72.1  | MIT          | runtime    | [pi.dev](https://pi.dev)                                                                                 |
| @mariozechner/pi-agent-core                | 0.72.1   | MIT          | transitive | [pi.dev](https://pi.dev)                                                                                 |
| @mariozechner/pi-ai                        | 0.72.1   | MIT          | transitive | [pi.dev](https://pi.dev)                                                                                 |
| @mariozechner/clipboard                    | 0.3.5    | MIT          | transitive | [pi.dev](https://pi.dev)                                                                                 |
| @mariozechner/jiti                         | 2.6.5    | MIT          | transitive | [pi.dev](https://pi.dev)                                                                                 |
| **AI Providers**                           |          |              |            |                                                                                                          |
| @anthropic-ai/sdk                          | 0.91.1   | MIT          | transitive | [anthropic.com](https://www.anthropic.com)                                                               |
| openai                                     | 6.26.0   | Apache-2.0   | transitive | [openai.com](https://openai.com)                                                                         |
| @aws-sdk/client-bedrock-runtime            | 3.1041.0 | Apache-2.0   | transitive | [aws.amazon.com](https://aws.amazon.com)                                                                 |
| @aws-crypto/sha256-browser                 | 5.2.0    | Apache-2.0   | transitive | [aws.amazon.com](https://aws.amazon.com)                                                                 |
| **Schema & Validation**                    |          |              |            |                                                                                                          |
| typebox                                    | 1.1.37   | MIT          | transitive | [github.com/typebox/typebox](https://github.com/typebox/typebox)                                         |
| zod                                        | 4.4.2    | MIT          | transitive | [zod.dev](https://zod.dev)                                                                               |
| **Utilities**                              |          |              |            |                                                                                                          |
| fast-xml-parser                            | 5.7.2    | MIT          | transitive | [github.com/NaturalIntelligence/fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) |
| tslib                                      | 2.8.1    | 0BSD         | transitive | [github.com/microsoft/tslib](https://github.com/microsoft/tslib)                                         |
| yoctocolors                                | 2.1.2    | MIT          | transitive | [github.com/sindresorhus/yoctocolors](https://github.com/sindresorhus/yoctocolors)                       |
| std-env                                    | 3.10.0   | MIT          | transitive | [github.com/unjs/std-env](https://github.com/unjs/std-env)                                               |
| **Pi Packages**                            |          |              |            |                                                                                                          |
| pi-lens                                    | latest   | MIT          | plugin     | [pi.dev/packages/pi-lens](https://pi.dev/packages/pi-lens)                                               |
| **System Runtimes**                        |          |              |            |                                                                                                          |
| Node.js                                    | ≥22      | MIT          | system     | [nodejs.org](https://nodejs.org)                                                                         |
| Python 3                                   | ≥3.10    | PSF          | system     | [python.org](https://python.org)                                                                         |
| npm                                        | latest   | Artistic-2.0 | system     | [npmjs.com](https://npmjs.com)                                                                           |
| **Container & Sandbox**                    |          |              |            |                                                                                                          |
| Docker Engine                              | latest   | Apache-2.0   | system     | [docker.com](https://docker.com)                                                                         |
| Daytona                                    | latest   | Apache-2.0   | system     | [daytona.io](https://daytona.io)                                                                         |
| **Infrastructure Tools**                   |          |              |            |                                                                                                          |
| GitHub CLI (gh)                            | latest   | MIT          | system     | [cli.github.com](https://cli.github.com)                                                                 |
| **Code Intelligence**                      |          |              |            |                                                                                                          |
| codebase-memory-mcp                        | 0.6.0    | Apache-2.0   | CLI tool   | [github.com/DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)               |
| **Web Crawling (Python venv)**             |          |              |            |                                                                                                          |
| crawl4ai                                   | latest   | Apache-2.0   | venv       | [github.com/unclecode/crawl4ai](https://github.com/unclecode/crawl4ai)                                   |
| Playwright Chromium                        | latest   | Apache-2.0   | venv       | [playwright.dev](https://playwright.dev)                                                                 |
| **Project Extensions (`.pi/extensions/`)** |          |              |            |                                                                                                          |
| caveman.ts                                 | —        | ISC          | project    | This repository                                                                                          |
| codebase-memory.ts                         | —        | ISC          | project    | This repository                                                                                          |
| crawl4ai.ts                                | —        | ISC          | project    | This repository                                                                                          |
| daytona-sandbox.ts                         | —        | ISC          | project    | This repository                                                                                          |
| session-logger.ts                          | —        | ISC          | project    | This repository                                                                                          |

> **License Compliance:** All components use OSI-approved open-source licenses (MIT, Apache-2.0, 0BSD, ISC, PSF, Artistic-2.0). No GPL/AGPL copyleft. No proprietary or source-available licenses. Total transitive dependency count: ~256 packages (`npm ls --all`).

> **SBOM Generation:** This table is manually maintained. For automated CycloneDX/SPDX SBOM: `npx cyclonedx-npm` + `pip freeze | cyclonedx-py` in `.pi/crawl4ai-venv/`.

---

## FAQ / Troubleshooting

### Docker: "permission denied"

```bash
sudo usermod -aG docker $USER
# Restart WSL (close terminal, wsl --shutdown, reopen)
```

### `pi: command not found`

```bash
sudo npm install -g @mariozechner/pi-coding-agent
# If still missing, check: echo $PATH | grep npm
```

### Daytona sandbox won't start

```bash
daytona list                    # Check state
daytona stop pi-sandbox         # Force stop
daytona start pi-sandbox        # Restart
# If broken: daytona delete pi-sandbox && daytona create --name pi-sandbox
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

### Codebase index is stale

The extension auto-indexes on session start. For manual reindex:

```bash
~/.local/bin/codebase-memory-mcp cli index_repository "{\"repo_path\": \"$PWD\"}"
```

### WSL networking issues (can't reach API)

```bash
# Check resolver
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
```

---

## Contributing

Contributions welcome — bug reports, feature requests, documentation improvements, new extensions.

1. Fork the repository
2. Create a feature branch (`git worktree add -b feature/amazing feature-amazing` is the recommended workflow)
3. Make your changes
4. Run `node --test test/` if applicable
5. Submit a PR

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines.

---

## Security

This project takes sandbox isolation seriously. AI commands execute in a Daytona container, not on the host.

**To report a vulnerability:** Do not open a public issue. Email `security@example.com` (replace with your actual security contact). Include steps to reproduce. Expect acknowledgment within 48 hours.

**Security properties:**

- ✅ All AI-executed commands run in an isolated container
- ✅ Host file operations are path-guarded (no escape outside project root)
- ✅ No MCP servers — only pi extensions (no network-exposed tool servers)
- ✅ Secrets scan on every write/edit (via pi-lens)
- ✅ API keys loaded from `~/.agent_env`, never committed

---

## License

ISC © 2025. See [LICENSE](./LICENSE) for full text.

All third-party components are OSI-approved open source (see [SBOM](#sbom---software-bill-of-materials)).

---

## Acknowledgments

Built on top of these excellent projects:

- [Pi Coding Agent](https://pi.dev) — The agent runtime
- [Daytona](https://daytona.io) — Sandboxed execution environment
- [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) — Code intelligence engine
- [crawl4ai](https://github.com/unclecode/crawl4ai) — LLM-friendly web crawler
- [pi-lens](https://pi.dev/packages/pi-lens) — Real-time code feedback
- [Zed](https://zed.dev) — The editor
