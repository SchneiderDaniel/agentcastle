# agentcastle

High-performance development environment using WSL (Ubuntu) + Zed + Git Worktrees + OpenCode AI.

---

## Table of Contents

- [Environment: WSL (Ubuntu)](#1-environment-wsl-ubuntu)
- [Authentication: SSH Keys](#2-authentication-ssh-keys)
- [Bare Worktree Workflow](#3-bare-worktree-workflow)
- [Editor Integration: Zed](#4-editor-integration-zed)
- [OpenCode AI Setup](#5-opencode-ai-setup)
  - [CLI Installation](#51-install-opencode-cli-in-wsl)
  - [Zed Extension](#52-install-the-zed-extension-on-windows)
  - [Bridge WSL to Zed](#53-link-zed-to-wsl-opencode)
  - [Usage with Worktrees](#54-using-opencode-with-your-worktrees)
- [Cheat Sheet](#6-cheat-sheet)
- [Pro-Tip: Auto-Start](#7-pro-tip-the-auto-start)

---

## 1. Environment: WSL (Ubuntu)

Ubuntu is the primary development environment for native Linux performance and compatibility.

- **Distro:** Ubuntu 24.04 LTS (Recommended)
- **Golden Rule:** All code lives in the Linux filesystem (`~/home/user/..`). **Never** use the Windows mount (`/mnt/c/`) — this avoids permission errors and provides 10× faster file indexing.

---

## 2. Authentication: SSH Keys

```bash
# Generate key
ssh-keygen -t ed25519 -C "your-email@example.com"

# Copy public key
cat ~/.ssh/id_ed25519.pub

# Add to GitHub: https://github.com/settings/keys

# Test connection
ssh -T git@github.com
```

---

## 3. Bare Worktree Workflow

Instead of `git clone <url>`, this setup separates Git metadata from working files, allowing multiple branches open simultaneously.

### Initial Setup

```bash
mkdir my-project && cd my-project
git clone --bare git@github.com:Username/repo.git .bare
echo "gitdir: ./.bare" > .git
git worktree add main
```

### Adding New Branches

```bash
git worktree add -b feature/login feature-login
```

This creates a new `feature-login/` folder instantly without disturbing `main`.

---

## 4. Editor Integration: Zed

Zed runs on Windows but communicates with a headless server inside WSL.

```bash
# Open a specific worktree from the Ubuntu terminal
zed .
```

> Always open the specific worktree folder (e.g., `main/`) so Zed's LSP can correctly map the project root for autocomplete and "Go to Definition."

---

## 5. OpenCode AI Setup

[OpenCode](https://opencode.ai) is an open-source AI coding agent that lives in your terminal and integrates with Zed via the ACP protocol. The CLI runs in WSL (accessing your files directly); the extension runs in Zed on Windows.

### 5.1 Install OpenCode CLI (in WSL)

```bash
curl -fsSL https://opencode.ai/install | bash
opencode --version
opencode /connect   # Choose a provider and paste your API key
```

### 5.2 Install the Zed Extension (on Windows)

1. Open **Zed**.
2. Press `Ctrl + Shift + P` → **zed: extensions**.
3. Search for **OpenCode** (by Anomaly) → **Install**.

### 5.3 Link Zed to WSL OpenCode

```bash
# In WSL, start the OpenCode server
opencode serve --hostname 0.0.0.0
# Note the URL (usually http://localhost:4096)
```

In Zed, open Settings (`Ctrl + ,`) and add:

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

### 5.4 Using OpenCode with Your Worktrees

```bash
cd ~/git/main
# In Zed, press Ctrl+Esc and ask a question
```

**Why this is powerful:**

- **Context Awareness** — OpenCode reads files in your active worktree.
- **Multi-file Editing** — Ask for a feature and OpenCode creates/modifies files directly.
- **Independence** — Open a different worktree in a second Zed window for a separate context.

---

## 6. Cheat Sheet

| Action | Command |
| :--- | :--- |
| List all worktrees | `git worktree list` |
| Remove a worktree | `rm -rf <folder>` && `git worktree prune` |
| Check WSL status | `wsl --list --verbose` |
| Open Linux files in Windows | `explorer.exe .` (from WSL) |
| Git push | `git push --set-upstream origin main` |
| Git diff (Zed) | `Ctrl+Shift+P` → git: diff |

> **Troubleshooting:** If you encounter `Operation not permitted` errors, ensure you are not inside `/mnt/c/`. The Linux `~` (home) directory is your safe haven.

---

## 7. Pro-Tip: The Auto-Start

Add to `~/.bashrc` to start the OpenCode server automatically:

```bash
# Start OpenCode server in background if not running
pgrep -x "opencode" > /dev/null || (opencode serve --hostname 0.0.0.0 > /dev/null 2>&1 &)
```

# The Complete OpenCode Agent Stack (Local-First 2026 Edition)
This guide configures OpenCode for secure, end-to-end autonomy. Your agent will compress context, search code via local AST graphs, apply UI design systems, remember previous sessions, scrape the web, execute/test code securely in local OCI containers, visually test UIs, and manage GitHub repositories—all while protecting your host OS from sandbox breakouts.
## 1. Core Agent Configuration (opencode.json)
Paste this unified block into your .config/opencode/opencode.json (or project .mcp.json). Ensure you replace the placeholder tokens with your actual keys.
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
      "env": {
        "APIFY_TOKEN": "YOUR_APIFY_TOKEN"
      },
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
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_GITHUB_PAT"
      },
      "enabled": true
    },
    "browser-use-mcp": {
      "type": "local",
      "command": ["browser-use-mcp"],
      "args": ["--model", "gpt-4o"],
      "env": {
        "OPENAI_API_KEY": "YOUR_OPENAI_API_KEY"
      },
      "enabled": true
    }
  }
}

```
## 2. Step-by-Step Installations & Usage
### A. Context & Memory Layer
**1. Caveman (Token Compression)**
 * **Install:** npx skills add JuliusBrussee/caveman
 * **Usage:** Triggers automatically via the AGENTS.md block below. You can manually adjust intensity mid-session by telling the agent /caveman ultra or /caveman lite.
**2. AgentMemory (Persistent Memory)**
 * **Install & Start Server:** Run npx @agentmemory/agentmemory in a dedicated background terminal.
 * **Import Past Sessions:** If you have old Claude Code/OpenCode logs, import them via npx @agentmemory/agentmemory import-jsonl.
 * **Test/Demo:** Run npx @agentmemory/agentmemory demo to see how it auto-extracts architecture decisions.
 * **Validation:** View your live memory graph at http://localhost:3113.
### B. Code & Architecture Layer
**3. Codebase-Memory-MCP (Local AST Graph)**
 * **Install (macOS/Linux/WSL):** ```bash
   curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
   ```
   
   ```
 * **Install (Windows PowerShell native):**
   ```powershell
   Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1
   .\install.ps1
   
   ```
 * **Validation:** Run the UI variant with the --ui flag to explore your AST graph locally at http://localhost:9749.
**4. Impeccable (Design Language)**
 * **Install:** ```bash
   git clone https://github.com/pbakaus/impeccable.git
   cp -r impeccable/dist/opencode/.opencode ./your-project-directory/
   ```
   
   ```
 * **Usage:** Command your agent with /impeccable audit to find bad UI patterns, /impeccable craft to build a new component step-by-step, or /impeccable polish before pushing a commit.
### C. Execution & World Interaction Layer
**5. Crawl4AI (Web Scraping)**
 * **Setup:** Ensure your Apify token is in the opencode.json. This replaces Firecrawl, delivering LLM-optimized Markdown while handling JS-heavy dynamic sites.
**6. Daytona (Secure Local Execution Sandbox)**
 * **Install Daytona CLI:**
   ```bash
   curl -sfL https://download.daytona.io/daytona/install.sh | sudo bash
   
   ```
 * **Start the Engine:** Run daytona server start in a background terminal.
 * **Why Daytona instead of raw WSL?** WSL mounts your Windows C: drive by default (/mnt/c/). A rogue agent with raw WSL access could delete your Windows files. Daytona creates isolated OCI containers inside WSL, keeping your local host completely protected.
**7. Browser Use (Visual UI Testing)**
 * **Install dependencies:**
   ```bash
   pip install -e "git+https://github.com/pietrozullo/browser-use-mcp.git#egg=browser-use-mcp[all-providers]"
   playwright install chromium
   
   ```
 * **Usage:** Uses accessibility trees to "see" the UI. Tell the agent: *"Use the browser to check if the shopping cart UI actually works on localhost:3000."*
**8. GitHub MCP (Repository Management)**
 * **Setup:** Generate a Classic Personal Access Token with repo and workflow permissions and add it to your opencode.json. This allows the agent to fetch issues and push PRs natively.
## 3. The "Brain" Protocol (AGENTS.md)
Append these exact instructions into your .config/opencode/AGENTS.md (or your project's local rules file) to prevent tool hallucinations and enforce security boundaries.
```markdown
### 1. Communication Protocol (Caveman)
Terse like caveman. Technical substance exact. Only fluff die. Drop: articles, filler (just/really/basically), pleasantries, hedging. Fragments OK. Short synonyms. Code unchanged. Pattern: [thing] [action] [reason]. [next step]. ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Code/commits/PRs: normal. Off: "stop caveman" / "normal mode".

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
## 4. Best Practices for this Stack
 1. **The Testing Duality (Crucial):** Never let the agent confuse its testing tools.
   * **Exploratory:** If you just want to know if the UI looks right or if a button works, tell the agent to use the **Browser Use** tool.
   * **Permanent:** If you want a test that will live in your repo forever (CI/CD), tell the agent to "write a test suite," which will trigger the **pytest + Playwright** protocol inside Daytona.
 2. **Design First, Test Second:** Before having the agent write tests or finalize a component, explicitly tell it to run /impeccable audit. This ensures the UI doesn't contain generic AI anti-patterns (like unnecessary purple gradients or poor contrast) before you lock it in with tests.
 3. **WSL Security:** Never give OpenCode an MCP tool like server-sequential-command pointing directly at your WSL bash. Always force it through Daytona to maintain the airgap between the agent's experiments and your Windows filesystem.
 4. **Memory Hygiene:** AgentMemory is persistent. If you completely pivot a project's architecture (e.g., switching from Postgres to MongoDB), use the memory_governance_delete tool or manually prune the memory graph via the UI at http://localhost:3113 so the agent doesn't hallucinate old stack requirements.
     
