# Agentcastle
High-performance, secure, and local-first development environment using WSL (Ubuntu) + Zed + Git Worktrees + OpenCode AI (2026 Edition).
This guide configures OpenCode for secure, end-to-end autonomy. Your agent will compress context, search code via local AST graphs, apply UI design systems, remember previous sessions, scrape the web, execute/test code securely in local OCI containers, visually test UIs, and manage GitHub repositories—all while protecting your host OS from sandbox breakouts.
## Table of Contents
 * 0. Prerequisites
 * 1. Foundation: Environment & Git
 * 2. Security: Secrets Management (.env)
 * 3. The Core: Editor & Agent
 * 4. The Agent Toolchain (MCP) Deep Dive
   * 4.1 Core Configuration
   * 4.2 Context & Memory Tools
   * 4.3 Code & Architecture Tools
   * 4.4 Execution & World Interaction Tools
 * 5. The "Brain" Protocol (AGENTS.md)
 * 6. Workflows & Best Practices
## 0. Prerequisites
Before starting, ensure your WSL (Ubuntu 24.04 LTS) environment has the necessary runtimes for the MCP tools:
```bash
# Install Node.js (for npx tools)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Python & pip (for Browser Use)
sudo apt-get install -y python3 python3-pip python3-venv

# Install Docker (Required by Daytona for container sandboxing)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

```
## 1. Foundation: Environment & Git
### 1.1 WSL (Ubuntu) & SSH
Ubuntu is the primary development environment for native Linux performance and compatibility.
 * **The Golden Rule:** All code lives in the Linux filesystem (~/...). **Never** use the Windows mount (/mnt/c/) — this avoids permission errors, node_modules bloat issues, and provides 10× faster file indexing.
**Authentication Setup:**
```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
cat ~/.ssh/id_ed25519.pub # Copy and add to https://github.com/settings/keys
ssh -T git@github.com     # Test connection

```
### 1.2 Bare Worktree Workflow
Instead of git clone <url>, this setup separates Git metadata from working files. This is vital for AI workflows, allowing you to open multiple branches simultaneously across different Zed windows for isolated agent tasks.
```bash
# 1. Initial Setup
mkdir my-project && cd my-project
git clone --bare git@github.com:Username/repo.git .bare
echo "gitdir: ./.bare" > .git

# 2. Secure the Repo globally (Ignore environment files)
echo ".env" >> .gitignore
git add .gitignore && git commit -m "chore: add .env to gitignore"

# 3. Add Branches
git worktree add main
git worktree add -b feature/login feature-login

```
## 2. Security: Secrets Management (.env)
**Never** put API keys in JSON configuration files. MCP tools automatically inherit environment variables from the terminal that starts the agent server.
**1. Create your environment file:**
Create a .env file in your project root (or a global ~/.agent_env if you prefer system-wide keys):
```bash
# ~/my-project/.env
OPENAI_API_KEY="sk-proj-..."
APIFY_TOKEN="apify_api_..."
GITHUB_PERSONAL_ACCESS_TOKEN="ghp_..."

```
**2. Ensure it's ignored:**
*(If you followed Step 1.2, .env is already in your .gitignore.)*
```bash
git check-ignore -v .env

```
**3. Source it before running the agent:**
To ensure OpenCode and MCP tools can access these keys, always run source .env before starting the agent server, or automate it (see the Auto-Start Pro-Tip).
## 3. The Core: Editor & Agent
OpenCode lives in your terminal and integrates with Zed via the ACP protocol. The CLI runs in WSL; the extension runs in Zed on Windows.
### 3.1 OpenCode & Zed Integration
**1. Install OpenCode CLI (in WSL):**
```bash
curl -fsSL https://opencode.ai/install | bash
opencode auth

```
**2. Start the OpenCode Server (in WSL):**
```bash
# Load your secrets first!
source .env
opencode serve --hostname 0.0.0.0

```
**3. Configure Zed (on Windows):**
 1. Open **Zed**.
 2. Press Ctrl + Shift + P → **zed: extensions** → Install **OpenCode** (by Anomaly).
 3. Open Settings (Ctrl + ,) and link the WSL server:
```json
{
  "extensions": {
    "opencode": {
      "server_url": "http://localhost:4096",
      "mode": "remote"
    }
  }
}

```
## 4. The Agent Toolchain (MCP) Deep Dive
### 4.1 Core Configuration (opencode.json)
Because we are using a .env file, we no longer pass hardcoded env blocks. The tools will naturally read from the inherited environment.
Paste this clean block into ~/.config/opencode/opencode.json (or your project's .mcp.json):
```json
{
  "mcp": {
    "agentmemory": {
      "type": "local",
      "command": ["npx", "-y", "@agentmemory/mcp"],
      "enabled": true
    },
    "crawl4ai-mcp": {
      "type": "local",
      "command": ["npx", "-y", "@apify/actors-mcp-server", "--actors", "janbuchar/crawl4ai"],
      "enabled": true
    },
    "daytona-mcp": {
      "type": "local",
      "command": ["daytona"],
      "args": ["mcp", "start"],
      "enabled": true
    },
    "github-mcp": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "enabled": true
    },
    "browser-use-mcp": {
      "type": "local",
      "command": ["browser-use-mcp"],
      "args": ["--model", "gpt-4o"],
      "enabled": true
    }
  }
}

```
### 4.2 Context & Memory Tools
 * **Caveman (Token Compression):** Forces the agent to speak in highly compressed fragments to save LLM context.
   * *Install:* npx skills add JuliusBrussee/caveman
 * **AgentMemory (Persistent Memory):** Gives the agent long-term recall across sessions using a local vector graph.
   * *Start Server:* Run npx @agentmemory/agentmemory in a dedicated WSL terminal. View UI at http://localhost:3113.
### 4.3 Code & Architecture Tools
 * **Codebase-Memory-MCP (Local AST Graph):** Replaces grep. Maps your codebase into an Abstract Syntax Tree (AST) so the agent understands how files connect.
   * *Install:* curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
 * **Impeccable (Design Language):** Stops the agent from hallucinating random CSS values and forces it to use your project's strict design tokens.
   * *Install:* Clone https://github.com/pbakaus/impeccable.git and copy the .opencode folder into your project. Use /impeccable craft in chat.
### 4.4 Execution & World Interaction Tools
 * **Daytona (Secure Local Sandbox):** Creates ephemeral Docker containers inside WSL. The agent writes code natively, but Daytona executes/tests it in an airgapped cage to protect your OS.
   * *Install:* curl -sfL https://download.daytona.io/daytona/install.sh | sudo bash
   * *Usage:* Run daytona server start in a background terminal.
 * **Browser Use (Visual UI Testing):** Allows the agent to "see" and click UI elements on your local dev server using Playwright.
   * *Install:* ```bash
     pip install -e "git+https://github.com/pietrozullo/browser-use-mcp.git#egg=browser-use-mcp[all-providers]"
     playwright install chromium
     ```
     
     ```
 * **Crawl4AI & GitHub MCP:** Managed automatically via your .env tokens to scrape docs and manage PRs.
## 5. The "Brain" Protocol (AGENTS.md)
Append these exact instructions into ~/.config/opencode/AGENTS.md (or your local .opencode/rules.md) to prevent tool hallucinations.
```markdown
### 1. Communication Protocol (Caveman)
Terse like caveman. Technical substance exact. Only fluff die. Drop: articles, filler (just/really/basically), pleasantries, hedging. Fragments OK. Short synonyms. Code unchanged. Pattern: [thing] [action] [reason]. [next step]. ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Code/commits/PRs: normal. Off: "stop normal mode".

### 2. Tool Routing Protocol
* **Internal Codebase:** Strictly use `search_graph` (Codebase-Memory-MCP) for architecture and code discovery. Do not use raw grep.
* **External Web Search:** Use `crawl4ai` to read external documentation.
* **Ad-hoc UI Verification:** Use `browser-use-mcp` to interactively verify a locally running dev server (e.g., clicking around to test state). Do not write raw Playwright scripts for this.

### 3. Code Execution Protocol (Daytona Sandbox)
* **CRITICAL SECURITY RULE:** You are STRICTLY FORBIDDEN from running untrusted code, installing global packages, or executing new test suites directly on the host machine.
* **Execution:** All script execution and unit testing MUST be routed through the `daytona-mcp` tools. Daytona will handle provisioning an isolated workspace.

### 4. Automated UI Testing Protocol (pytest + Playwright)
When instructed to write permanent E2E or Integration test suites:
1. Do not write raw Playwright scripts. Strictly use `pytest` combined with the `pytest-playwright` plugin.
2. Structure: Prefix files with `test_` and place them in the `tests/` directory.
3. Fixtures: Always use the built-in `page` fixture (e.g., `def test_ui_element(page):`).
4. Execution: Run these tests exclusively inside a Daytona sandbox using `pytest tests/ -v`. Fix failing assertions by reading the stdout trace.

```
## 6. Workflows & Best Practices
| Action | Command |
|---|---|
| **List all worktrees** | git worktree list |
| **Remove a worktree** | rm -rf <folder> && git worktree prune |
| **Check WSL status** | wsl --list --verbose |
| **Open Linux files in Windows** | explorer.exe . *(from WSL)* |
| **Git Push** | git push --set-upstream origin <branch> |
### Best Practices
 1. **The Testing Duality (Crucial):** * *Exploratory:* To manually check if a UI works, tell the agent: *"Use the **Browser Use** tool."*
   * *Permanent:* To build a CI pipeline test, tell the agent: *"Write a test suite."* (Triggers pytest + Daytona).
 2. **WSL Security:** Never give OpenCode a tool like server-sequential-command pointing directly at your WSL bash. **Always** force it through Daytona to maintain the airgap.
### <a name="auto-start"></a>Pro-Tip: The Auto-Start
Add this to your ~/.bashrc to automatically load your global secrets and start the OpenCode server in the background whenever you launch WSL:
```bash
# Load global secrets
if [ -f "$HOME/.agent_env" ]; then
    set -a
    source "$HOME/.agent_env"
    set +a
fi

# Start OpenCode server in background if not running
pgrep -x "opencode" > /dev/null || (opencode serve --hostname 0.0.0.0 > /dev/null 2>&1 &)

```
Would you like me to generate a bash script that automates this entire prerequisite and folder setup for you so you can spin up new "Agent Castles" with one command?

