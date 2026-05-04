# Agentcastle: The Pi Stack

High-performance, secure, and local-first development environment using WSL (Ubuntu) + Zed + Git Worktrees + Pi AI.

## 0. Prerequisites

Ensure your WSL (Ubuntu 24.04 LTS) has the necessary runtimes. This setup bypasses the broken install scripts by pulling the binaries directly.

```bash
# 1. Base Runtimes
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip python3-venv jq unzip
sudo npm install -g npm@latest

# 2. Docker & Daytona (Native WSL Setup)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER # Apply by restarting WSL

# 2.1. Manual Daytona Install (Fixes 404/Silent Errors)
sudo curl -L "https://github.com/daytonaio/daytona/releases/latest/download/daytona-linux-amd64" -o /usr/local/bin/daytona
sudo chmod +x /usr/local/bin/daytona

# 2.2. Initialize Daytona Sandbox
daytona login
daytona create --name pi-sandbox # This is where Pi will execute code

# 3. Pi Agent
sudo npm install -g @mariozechner/pi-coding-agent

# 4. GitHub CLI (gh)
(type -p wget >/dev/null || sudo apt-get install wget -y)
sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update
sudo apt-get install gh -y

# 5. Codebase Memory (Knowledge Graph for Pi)
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --skip-config
# Ensure ~/.local/bin is in PATH:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

---

## 1. Security & Environment (The Foundation)

We need to set up the environment for the tools.

### 1.1 Create the Secret Store

Pi's tools (like `crawl4ai`) inherit environment variables from your terminal. Create `~/.agent_env` in your **home directory**:

```bash
export APIFY_TOKEN="apify_api_..."
```

> **How `web_crawl` uses APIFY_TOKEN:** The `web_crawl` tool tries local crawl4ai first (runs on the host with auto-installed venv + Chromium deps). If that fails, it falls back to Apify's official [`apify~website-content-crawler`](https://apify.com/apify/website-content-crawler) actor — a cloud-based browser extraction that returns clean markdown. The last resort is a direct HTTP fetch with regex-based HTML→markdown conversion.
>
> **System requirements for local crawl4ai:** The extension auto-creates a Python venv at `.pi/crawl4ai-venv/` and downloads Chromium system libraries to `.pi/chromium-deps/` (no sudo needed). Requires: `python3`, `python3-venv`, `python3-pip`, `dpkg`, `apt-get` (for library downloads).

### 1.2 The Auto-Start (One-Click Setup)

WSL doesn't automatically start background services like a normal Linux boot. This script automatically appends the necessary startup logic to your `~/.bashrc`.

Just copy, paste, and run this entire block in your WSL terminal:

```bash
cat << 'EOF' >> ~/.bashrc

# ==========================================
# AGENTCASTLE AUTO-START
# ==========================================
# 1. WSL Quirk: Start Docker silently if it isn't running.
if ! pgrep -x "dockerd" > /dev/null; then
    sudo service docker start > /dev/null 2>&1
fi


# 3. Environment: Load the API keys into the session.
if [ -f "$HOME/.agent_env" ]; then
    source "$HOME/.agent_env"
fi
# ==========================================
EOF

# Apply the changes immediately to your current terminal
source ~/.bashrc
```

---

## 2. AI Provider Setup (The OpenCode Config)

OpenCode Go is natively supported by Pi. We will authenticate once via the CLI.

### 2.1 One-Time Authentication

Run this command in your terminal, replacing the dummy key with your actual OpenCode Go key:

```bash
pi --provider opencode-go --api-key "your-actual-api-key-here"
```

_(Once Pi launches successfully, you can exit by pressing `Ctrl+C` twice)._

### 2.2 The Default Override (Project Local)

Force Pi to use OpenCode Go by default for this specific project. Create a `.pi/settings.json` file in your **project root** and set `defaultProvider` to `opencode-go`. See the `.pi/settings.json` file in this repository.

---

## 3. Workspace & Git

### 3.1 WSL (Ubuntu) & SSH

- **The Golden Rule:** All code lives in the Linux filesystem (`~/...`). **Never** use `/mnt/c/` for active dev work.

### 3.2 Bare Worktree Workflow

Run isolated Pi agents simultaneously in different Zed windows.

```bash
mkdir my-project && cd my-project
git clone --bare git@github.com:Username/repo.git .bare
echo "gitdir: ./.bare" > .git
echo ".env" >> .gitignore

# Add a feature branch worktree
git worktree add -b feature/logic feature-logic
cd feature-logic
```

---

## 4. The Core: Editor & Agent (Zed)

Pi lives in Zed's integrated terminal (Ctrl + ~). Ensure the terminal defaults to your **WSL Ubuntu profile**.

---

## 5. The Agent Toolchain (Extensions)

### 5.1 Custom Tools & Bash Interception

Pi does **not** use a `pi.config.ts` file. Instead, it auto-discovers extensions from `.pi/extensions/` in your **project root**.

Create `.pi/extensions/daytona-sandbox.ts` in your **project root**. See the `.pi/extensions/daytona-sandbox.ts` file in this repository for the Daytona sandbox interceptor and local AST graph search tool implementation.

Create `.pi/extensions/crawl4ai.ts` in your **project root**. See the `.pi/extensions/crawl4ai.ts` file in this repository for the `web_crawl` tool — a three-tier web crawler that tries local crawl4ai (host, with real browser), falls back to Apify's cloud actor, then direct HTTP fetch.

Extensions in `.pi/extensions/` are loaded automatically on Pi startup (no `--extension` flag needed).

#### Session Logger (`session-logger.ts`)

Writes every Pi session as an LLM-optimized Markdown file to `.pi/sessions/<session-id>/session.md` plus a `metadata.json` with token/cost stats. Feed the markdown to an LLM later to analyze your harness: spot system prompt bloat, tool description gaps, confusion patterns in thinking blocks, error loops, and context waste.

```bash
# Toggle on/off (takes effect next session):
/session-logger        # toggle
/session-logger on     # force on
/session-logger off    # force off
```

**Output per session:**

```
.pi/sessions/<uuid>/
├── session.md      # Full conversation: messages, thinking, tool calls, compactions
└── metadata.json   # Token totals, cost, model/thinking changes, compaction count
```

**Why Markdown:** JSON/HTML carry 40-70% structural token overhead. Markdown is ~5-10% overhead — the LLM spends tokens on content, not syntax. Thinking blocks preserved in full (highest signal). Tool outputs truncated to 2000+500 chars.

### 5.2 Codebase Intelligence (`codebase-memory-mcp`)

Pi uses [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) — a high-performance code intelligence engine that indexes your codebase into a persistent knowledge graph. Single static binary, zero runtime dependencies, 66 languages.

**Token savings:** Five structural queries consume ~3,400 tokens via the codebase graph vs ~412,000 tokens via file-by-file grep exploration — a **99.2% reduction**.

#### 5.2.1 Installation

The binary was installed in Step 0 (prerequisites). The extension at `.pi/extensions/codebase-memory.ts` is auto-discovered.

```bash
# Verify binary:
~/.local/bin/codebase-memory-mcp --version

# Manual reindex (extension auto-indexes on session start):
~/.local/bin/codebase-memory-mcp cli index_repository '{"repo_path": "'$(pwd)'"}'
```

#### 5.2.2 Tools Exposed

The extension registers 14 tools, one per codebase-memory-mcp capability:

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

#### 5.2.3 Ignoring Files

The `.cbmignore` file in the project root excludes `.pi/chromium-deps/` and `.pi/crawl4ai-venv/` from indexing. Add additional patterns in gitignore syntax to skip vendored code, generated files, or large assets.

#### 5.2.4 How It Works With Sandbox Routing

The extension calls the binary via `pi.exec()` directly from the Node.js runtime — it bypasses the Daytona sandbox interceptor entirely. The binary reads/writes to `~/.cache/codebase-memory-mcp/` (SQLite databases) and reads project files from the host filesystem. This is intentional: the codebase graph is a host-level index, shared across sandbox sessions.

> **Sandbox Routing:** The extension routes commands into the Daytona sandbox _except_ for file-management operations (`rm`, `mkdir`, `mv`, `cp`, `touch`, `chmod`, `chown`) which run on the host so the agent can manage actual project files. A basic guard blocks absolute paths outside the project directory. A persistent Daytona volume (`pi-sandbox-vol`) is mounted at `/workspace` so sandbox data survives restarts.
>
> **Auto-Recovery:** The extension automatically probes the sandbox state. If `pi-sandbox` is stopped, it attempts to start it (with retry backoff for transient conflicts). If the sandbox doesn't exist, it creates it (with the persistent volume) and polls until it's ready.
>
> **crawl4ai Auto-Setup:** On first `web_crawl` invocation, the extension auto-creates a Python virtual environment at `.pi/crawl4ai-venv/`, installs `crawl4ai` + Playwright Chromium, and downloads missing system libraries (libnspr4, libnss3, libasound) to `.pi/chromium-deps/` — no sudo required. `LD_LIBRARY_PATH` is set automatically so Chromium finds these libs.

---

## 6. Real-Time Code Feedback (pi-lens)

[pi-lens](https://pi.dev/packages/pi-lens) gives real-time inline code feedback on every write/edit. LSP diagnostics, tree-sitter structural rules, ast-grep security/correctness rules, format-on-save, secrets scan, read-before-edit guard.

### 6.1 Install

```bash
pi install npm:pi-lens -l
```

### 6.2 What It Does

| Hook              | Action                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **write/edit**    | Secrets scan (blocking), auto-format, auto-fix (Biome/Ruff/ESLint), LSP file sync, dispatch lint (LSP + tree-sitter + ast-grep + fact rules + linters), cascade diagnostics |
| **agent_end**     | Deferred formatting runs once per turn, summary notification                                                                                                                |
| **session_start** | Reset state, detect language profile, warm caches, LSP warm-files, tool hints                                                                                               |
| **turn_end**      | Impact cascade (review-graph), deferred findings, debt tracking                                                                                                             |

### 6.3 Key Commands

| Command                   | Purpose                            |
| ------------------------- | ---------------------------------- |
| `/lens-booboo`            | Full quality report                |
| `/lens-health`            | Runtime health, latency, telemetry |
| `/lens-tools`             | Tool installation status           |
| `/lens-tdi`               | Technical Debt Index               |
| `/lens-allow-edit <path>` | Override read-guard for one edit   |

### 6.4 Optional Flags

```bash
pi --no-lsp          # Disable LSP diagnostics
pi --no-autoformat   # Skip auto-formatting
pi --immediate-format # Format per-edit instead of deferred
pi --no-autofix      # Skip auto-fix
pi --no-tests        # Skip test runner
pi --no-delta        # Show all diagnostics, not just new ones
```

---

## 7. The "Brain" Protocol (Context & Templates)

Pi loads two different kinds of instruction files. They are **not** interchangeable.

### 7.1 Always-On Context (`AGENTS.md`) — Use This for Caveman

If you want instructions to be **automatically active** in every Pi session, put them in `AGENTS.md` (or `CLAUDE.md`) in your **project root**. Pi concatenates all discovered `AGENTS.md` files (walking up from the working directory) and appends them to the system prompt on every turn.

**This project already has an `AGENTS.md`** with the caveman protocol (communication style + tool routing). It is active as soon as you run `pi` in this directory.

### 7.2 Reusable Prompt Templates (`.pi/prompts/*.md`)

If you want **manual snippets** that you invoke on demand, create prompt templates in `.pi/prompts/`. See the `.pi/prompts/review.md` example in this repository. Invoke templates with `/review` inside Pi's editor. Templates are **not** automatically loaded — you must type `/` and select them.

---

## 8. Workflows & Pro-Tips

| Action             | Command                     |
| ------------------ | --------------------------- |
| **Start Session**  | `pi`                        |
| **Check Sandbox**  | `daytona list`              |
| **Restart Docker** | `sudo service docker start` |

---

## 9. Installation Check Up (Test Your Stack)

Before writing your first line of code, verify that all components are communicating correctly.

### 9.1 Verify Base Services

Open your WSL terminal and ensure the background auto-start scripts executed properly:

```bash
# 1. Check Docker daemon (Should output headers without permission errors)
docker ps


# 3. Check API Keys (Should print your Apify token)
echo $APIFY_TOKEN
```

### 9.2 Verify the Sandbox

Check that Daytona is running and capable of executing commands inside the isolated container.

```bash
# Verify sandbox status (Look for 'pi-sandbox' in 'Running' state)
daytona list

# Test arbitrary execution
daytona exec pi-sandbox -- echo "Sandbox active"
```

### 9.3 Verify Pi Autonomy

Ensure Pi is properly utilizing OpenCode Go without asking for provider selection.

```bash
# Ask Pi a simple question directly from the CLI
pi "Respond with exactly one word: 'Operational'."
```

### 9.4 Verify Codebase Memory (Knowledge Graph)

Confirm that codebase-memory-mcp is installed and can index the project.

```bash
# Check binary
~/.local/bin/codebase-memory-mcp --version

# Test indexing from CLI
~/.local/bin/codebase-memory-mcp cli index_repository "{\"repo_path\": \"$PWD\"}"

# Test a search query
~/.local/bin/codebase-memory-mcp cli search_graph "{\"project\": \"$(echo $PWD | sed 's|^/||; s|/|-|g')\", \"name_pattern\": \".*\", \"label\": \"Function\", \"limit\": 5}"
```

_Expected Result:_ The index command should report `"status":"indexed"` with node/edge counts. The search should return function names found in the project.

### 9.5 Verify pi-lens (Real-Time Code Feedback)

Check that pi-lens is installed and registered:

```bash
# Verify package in project settings
cat .pi/settings.json | grep pi-lens

# List installed pi packages (run inside pi session or on host)
pi list
```

_Expected Result:_ `pi-lens` should appear in the package list and `.pi/settings.json`.

### 9.6 Verify Execution Routing (The Acid Test)

This ensures your `.pi/extensions/daytona-sandbox.ts` interceptor is successfully capturing and routing Pi's bash commands correctly.

**Test A — Sandbox isolation:**
Open Zed's terminal (Ctrl + ~), ensure you are in the project root, and run:

```bash
pi -p "Run 'uname -n' in bash and tell me the hostname."
```

_Expected Result:_ Pi should report the hostname of the sandbox (e.g., `pi-sandbox` or a container ID). If it returns your actual WSL machine's hostname, the extension hook in Step 5 failed and arbitrary commands are not isolated.

**Test B — Host file operations:**

```bash
pi -p "Create a file named '.pi/test-file.txt' with the content 'host works', then tell me the absolute path where it was created."
```

_Expected Result:_ The file should appear on the host filesystem at `<project-root>/.pi/test-file.txt`. If the agent reports it can't find the path or the file doesn't appear on the host, file-management commands are being incorrectly routed to the sandbox.

> **Tip:** You can test the auto-recovery by stopping the sandbox first: `daytona stop pi-sandbox`. The extension should transparently start it back up on the next sandbox command.
