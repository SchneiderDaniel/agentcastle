
# Agentcastle: The Pi Stack

High-performance, secure, and local-first development environment using WSL (Ubuntu) + Zed + Git Worktrees + Pi AI (2026 Edition).
This guide configures Pi for absolute token efficiency and maximal programmatic control. It combines the context-compressing power of the Model Context Protocol (MCP) with Pi's lightweight TypeScript hooks. Your agent will search local AST graphs, scrape LLM-optimized Markdown, and execute code in airgapped OCI containers—all while keeping your system prompt ultra-lean and protecting your host OS.
## Table of Contents
 *    0. Prerequisites
 *    1. Foundation: Environment & Git
 *    2. Security & Authentication (.env)
 *    3. The Core: Editor & Agent (Zed)
 *    4. The Agent Toolchain (The MCP Bridge)
 *    5. Execution Security (Hardcoded Hooks)
 *    6. The "Brain" Protocol (Templates)
 *    7. Workflows & Best Practices
## 0. Prerequisites
Before starting, ensure your WSL (Ubuntu 24.04 LTS) environment has the necessary runtimes:
```bash
# 1. Base Runtimes
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip python3-venv jq

# 2. Docker & Daytona (Required for container sandboxing)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
curl -sfL https://download.daytona.io/daytona/install.sh | sudo bash

# 3. Pi Agent & MCP Adapter
npm install -g pi-agent pi-mcp-adapter

# 4. GitHub CLI (Replaces GitHub MCP for token-efficient repo management)
sudo apt-get install gh

```
## 1. Foundation: Environment & Git
### 1.1 WSL (Ubuntu) & SSH
Ubuntu is the primary development environment.
 * **The Golden Rule:** All code lives in the Linux filesystem (~/...). **Never** use the Windows mount (/mnt/c/) — this avoids permission errors and guarantees rapid file indexing.
**Authentication Setup:**
```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
cat ~/.ssh/id_ed25519.pub # Copy and add to https://github.com/settings/keys
ssh -T git@github.com     # Test connection

```
### 1.2 Bare Worktree Workflow
Separate Git metadata from working files to run isolated Pi agents simultaneously in different Zed windows.
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
## 2. Security & Authentication (.env)
Pi and its MCP bridges inherit environment variables from your terminal.
**1. Create your environment file:**
Create a .env file in your project root (or ~/.agent_env for system-wide keys):
```bash
# ~/my-project/.env
OPENCODE_GO_API_KEY="opencode-go-..."
APIFY_TOKEN="apify_api_..."

```
**2. Authenticate Native CLI Tools:**
```bash
gh auth login  # Use the native CLI to save tokens on GitHub operations

```
## 3. The Core: Editor & Agent (Zed)
Pi lives directly in Zed's integrated terminal, keeping the agent adjacent to your code without requiring heavy background servers or editor extensions.
**1. Configure Zed (on Windows):**
 1. Open **Zed**.
 2. Open the integrated terminal (Ctrl + ~).
 3. Ensure the terminal defaults to your WSL Ubuntu profile.
 4. **Usage:** Run the pi command inside this terminal.
## 4. The Agent Toolchain (The MCP Bridge)
We use pi.config.ts to wire up the specific MCP servers that *save* tokens by compressing context (like Crawl4AI's Markdown extraction and Codebase-Memory's AST graphs).
Create ~/.config/pi/pi.config.ts and add the MCP initialization:
```typescript
import { setupMCP } from "pi-mcp-adapter";
import { interceptTool } from "pi-core/hooks";

export default async function configurePi(pi) {
  // 1. Mount Token-Efficient Context & World Interaction MCPs
  await setupMCP(pi, {
    agentmemory: { 
      command: "npx", 
      args: ["-y", "@agentmemory/mcp"] 
    },
    crawl4ai: { 
      command: "npx", 
      args: ["-y", "@apify/actors-mcp-server", "--actors", "janbuchar/crawl4ai"],
      env: { APIFY_TOKEN: process.env.APIFY_TOKEN }
    },
    browserUse: { 
      command: "browser-use-mcp", 
      args: ["--model", "opencode-go"],
      env: { OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY }
    }
  });

  // 2. Map local AST graph to a lightweight tool for context-efficient code search
  // (Assuming you ran the codebase-memory-mcp install.sh script)
  pi.registerTool("search_graph", async (query) => {
    const res = await fetch(`http://localhost:9749/search?q=${encodeURIComponent(query)}`);
    return await res.json();
  });

```
## 5. Execution Security (Hardcoded Hooks)
**CRITICAL:** We do not waste context window tokens politely asking Pi to use Daytona. We force it at the programmatic level.
Append this interceptor to your ~/.config/pi/pi.config.ts:
```typescript
  // 3. The Daytona Sandbox Interceptor
  // Intercepts native Bash executions and routes untrusted code into an OCI container
  interceptTool("bash", (context, originalCommand) => {
    // Whitelist safe CLI tools to run natively on the host for speed
    const safePrefixes = ["git ", "gh ", "cat ", "ls ", "npx impeccable "];
    const isSafe = safePrefixes.some(prefix => originalCommand.trim().startsWith(prefix));
    
    if (isSafe) {
      return { modifiedCommand: originalCommand };
    }

    // Wrap execution (node, python, npm, pytest) safely in Daytona
    const daytonaWrapped = `daytona run --workspace default '${originalCommand}'`;
    return { modifiedCommand: daytonaWrapped };
  });
}

```
## 6. The "Brain" Protocol (Templates)
Because the TypeScript hooks enforce our sandbox and connect our tools, our system prompt can be incredibly lean.
Create ~/.config/pi/templates/caveman.md:
```markdown
### 1. Communication (Caveman)
Terse like caveman. Technical substance exact. Only fluff die. Drop articles/filler. Pattern: [action] [reason]. [next step].

### 2. Tool Routing
* Code Search: Strictly use `search_graph` to understand architecture.
* Web Search: Use `crawl4ai` to read external docs (returns clean markdown).
* Visual UI Verification: Use `browserUse` on localhost.
* GitHub: Use the `gh` cli natively via bash.

### 3. Automated Tests
When writing permanent tests, use `pytest` with `pytest-playwright` in the `tests/` directory. (Note: Your bash execution is automatically sandboxed by the system runtime).

```
**Start your session:** Run pi --template caveman in Zed's terminal.
## 7. Workflows & Best Practices
| Action | Command |
|---|---|
| **List all worktrees** | git worktree list |
| **Remove a worktree** | rm -rf <folder> && git worktree prune |
| **Check WSL status** | wsl --list --verbose |
| **Open Linux files in Windows** | explorer.exe . *(from WSL)* |
### Best Practices
 1. **Zero-Prompt Guardrails:** Never write security rules in prompts. Rely on your pi.config.ts to block destructive actions. This saves tokens and prevents hallucinated breakouts.
 2. **The Testing Duality:**
   * *Exploratory:* Tell Pi: *"Use browserUse to click through the checkout flow."*
   * *Permanent:* Tell Pi: *"Write a pytest-playwright suite."* (The TypeScript hook automatically routes this execution safely into Daytona).
 3. **Memory Hygiene:** Periodically prune your agentmemory UI (http://localhost:3113) to ensure Pi's searches only return the most relevant semantic context.
 4. **Impeccable Audits:** Because Pi uses native Bash (and we whitelisted the command), you can tell Pi: *"Run npx impeccable audit and fix the design issues."*
### Pro-Tip: The Auto-Start
Add this to your ~/.bashrc to automatically load your global secrets and ensure background services are ready whenever you open Zed's terminal:
```bash
# Load global secrets
if [ -f "$HOME/.agent_env" ]; then
    set -a
    source "$HOME/.agent_env"
    set +a
fi

# Start Daytona and Codebase-Memory graph in background if not running
pgrep -x "daytona" > /dev/null || (daytona server start > /dev/null 2>&1 &)
pgrep -f "agentmemory" > /dev/null || (npx -y @agentmemory/agentmemory > /dev/null 2>&1 &)

```
