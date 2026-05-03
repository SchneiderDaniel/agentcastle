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

# 3. Pi Agent & MCP Adapter
# Install the agent first:
sudo npm install -g @mariozechner/pi-coding-agent

# Install the adapter via Pi:
sudo pi install npm:pi-mcp-adapter

# 4. GitHub CLI (gh)
(type -p wget >/dev/null || sudo apt-get install wget -y)
sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update
sudo apt-get install gh -y
```

---

## 1. Security & Environment (The Foundation)
We need to set up the environment for the MCP tools.

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

# 2. Background Task: Keep the local AgentMemory vector store alive for Pi.
if ! pgrep -f "agentmemory" > /dev/null; then
    npx -y @agentmemory/agentmemory > /dev/null 2>&1 &
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
*(Once Pi launches successfully, you can exit by pressing `Ctrl+C` twice).*

### 2.2 The Default Override (Project Local)
Force Pi to use OpenCode Go by default for this specific project. Create a `.pi/settings.json` file in your **project root** and set `defaultProvider` to `opencode-go`. See the `.pi/settings.json` file in this repository.

---

## 3. Workspace & Git
### 3.1 WSL (Ubuntu) & SSH
* **The Golden Rule:** All code lives in the Linux filesystem (`~/...`). **Never** use `/mnt/c/` for active dev work.

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

## 5. The Agent Toolchain (The MCP Bridge)

### 5.1 MCP Server Configuration
Pi discovers MCP servers from `.mcp.json` in your **project root**. See the `.mcp.json` file in this repository for the `agentmemory` and `crawl4ai` server definitions.

Make sure `pi-mcp-adapter` is installed so Pi can load these servers:
```bash
pi install npm:pi-mcp-adapter
```

### 5.2 Custom Tools & Bash Interception (Pi Extension)
Pi does **not** use a `pi.config.ts` file. Instead, it auto-discovers extensions from `.pi/extensions/` in your **project root**.

Create `.pi/extensions/daytona-sandbox.ts` in your **project root**. See the `.pi/extensions/daytona-sandbox.ts` file in this repository for the Daytona sandbox interceptor and local AST graph search tool implementation.

Create `.pi/extensions/crawl4ai.ts` in your **project root**. See the `.pi/extensions/crawl4ai.ts` file in this repository for the `web_crawl` tool — a three-tier web crawler that tries local crawl4ai (host, with real browser), falls back to Apify's cloud actor, then direct HTTP fetch.

Extensions in `.pi/extensions/` are loaded automatically on Pi startup (no `--extension` flag needed).

> **Sandbox Routing:** The extension routes commands into the Daytona sandbox *except* for file-management operations (`rm`, `mkdir`, `mv`, `cp`, `touch`, `chmod`, `chown`) which run on the host so the agent can manage actual project files. A basic guard blocks absolute paths outside the project directory. A persistent Daytona volume (`pi-sandbox-vol`) is mounted at `/workspace` so sandbox data survives restarts.
>
> **Auto-Recovery:** The extension automatically probes the sandbox state. If `pi-sandbox` is stopped, it attempts to start it (with retry backoff for transient conflicts). If the sandbox doesn't exist, it creates it (with the persistent volume) and polls until it's ready.
>
> **crawl4ai Auto-Setup:** On first `web_crawl` invocation, the extension auto-creates a Python virtual environment at `.pi/crawl4ai-venv/`, installs `crawl4ai` + Playwright Chromium, and downloads missing system libraries (libnspr4, libnss3, libasound) to `.pi/chromium-deps/` — no sudo required. `LD_LIBRARY_PATH` is set automatically so Chromium finds these libs.

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
| Action | Command |
|---|---|
| **Start Session** | `pi` |
| **Check Sandbox** | `daytona list` |
| **Restart Docker** | `sudo service docker start` |

---

## 9. Installation Check Up (Test Your Stack)
Before writing your first line of code, verify that all components are communicating correctly.

### 9.1 Verify Base Services
Open your WSL terminal and ensure the background auto-start scripts executed properly:
```bash
# 1. Check Docker daemon (Should output headers without permission errors)
docker ps

# 2. Check AgentMemory (Should return a process ID integer)
pgrep -f "agentmemory"

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

### 9.4 Verify Execution Routing (The Acid Test)
This ensures your `.pi/extensions/daytona-sandbox.ts` interceptor is successfully capturing and routing Pi's bash commands correctly.

**Test A — Sandbox isolation:**
Open Zed's terminal (Ctrl + ~), ensure you are in the project root, and run:
```bash
pi -p "Run 'uname -n' in bash and tell me the hostname."
```
*Expected Result:* Pi should report the hostname of the sandbox (e.g., `pi-sandbox` or a container ID). If it returns your actual WSL machine's hostname, the extension hook in Step 5 failed and arbitrary commands are not isolated.

**Test B — Host file operations:**
```bash
pi -p "Create a file named '.pi/test-file.txt' with the content 'host works', then tell me the absolute path where it was created."
```
*Expected Result:* The file should appear on the host filesystem at `<project-root>/.pi/test-file.txt`. If the agent reports it can't find the path or the file doesn't appear on the host, file-management commands are being incorrectly routed to the sandbox.

> **Tip:** You can test the auto-recovery by stopping the sandbox first: `daytona stop pi-sandbox`. The extension should transparently start it back up on the next sandbox command.
