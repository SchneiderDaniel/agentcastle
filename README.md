# Agentcastle: The Pi Stack (Full 2026 Edition)

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

# 4. GitHub CLI 
sudo apt-get install gh
```

---

## 1. Security & Environment (The Foundation)
We need to set up the environment for the MCP tools locally within your project.

### 1.1 Create the Project Secret Store
Pi's tools (like `crawl4ai`) inherit environment variables from your terminal session. Create a `.env` file in your **project root**:
```bash
export APIFY_TOKEN="apify_api_..."
```
*(Note: Be sure to add `.env` to your `.gitignore` to avoid leaking secrets!)*

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
# ==========================================
EOF

# Apply the changes immediately to your current terminal
source ~/.bashrc
```

*(Tip: Whenever you start working on your project, remember to run `source .env` in your project root so Pi can access your local API keys, or use a tool like `direnv` to automate this).*

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
Force Pi to use OpenCode Go by default for this specific project. Create a `.pi/settings.json` file in your **project root**:

```json
{
  "defaultProvider": "opencode-go"
}
```

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
Create your Pi configuration file natively in the **project root** as `./pi.config.ts`:

```typescript
import { setupMCP } from "pi-mcp-adapter";
import { interceptTool } from "pi-core/hooks";

export default async function configurePi(pi) {
  // 1. Mount MCPs
  await setupMCP(pi, {
    agentmemory: { command: "npx", args: ["-y", "@agentmemory/mcp"] },
    crawl4ai: { 
      command: "npx", 
      args: ["-y", "@apify/actors-mcp-server", "--actors", "janbuchar/crawl4ai"],
      env: { APIFY_TOKEN: process.env.APIFY_TOKEN } // Relies on your local .env being sourced
    }
  });

  // 2. Local AST graph search (Requires local service running on port 9749)
  pi.registerTool("search_graph", async (query) => {
    const res = await fetch(`http://localhost:9749/search?q=${encodeURIComponent(query)}`);
    return await res.json();
  });
```

---

## 6. Execution Security (Hardcoded Hooks)
**CRITICAL:** This force-routes Pi's code execution into the OCI sandbox. Append the following to your **project root's** `./pi.config.ts`:

```typescript
  // 3. The Daytona Sandbox Interceptor (v0.17x Syntax)
  interceptTool("bash", async (context, originalCommand) => {
    const safePrefixes = ["git ", "gh ", "cat ", "ls ", "npx impeccable "];
    const isSafe = safePrefixes.some(prefix => originalCommand.trim().startsWith(prefix));
    
    if (isSafe) return { modifiedCommand: originalCommand };

    // Wrap execution in the pre-created pi-sandbox
    const daytonaWrapped = `daytona exec pi-sandbox -- "${originalCommand}"`;
    return { modifiedCommand: daytonaWrapped };
  });
}
```

---

## 7. The "Brain" Protocol (Templates)
Store your project-specific agent templates locally. Create `./.pi/templates/caveman.md` in your **project root**:
```markdown
### 1. Communication
Terse. technical substance exact. No fluff. Pattern: [action] [reason]. [next step].

### 2. Tool Routing
* Code Search: `search_graph` 
* Web Search: `crawl4ai` (returns clean markdown)
* GitHub: `gh` cli natively via bash.
```

---

## 8. Workflows & Pro-Tips
| Action | Command |
|---|---|
| **Load Local Secrets** | `source .env` |
| **Start Session** | `pi --template caveman` |
| **Check Sandbox** | `daytona list` |
| **Restart Docker** | `sudo service docker start` |

---

## 9. Installation Check Up (Test Your Stack)
Before writing your first line of code, verify that all components are communicating correctly.

### 9.1 Verify Base Services
Open your WSL terminal in your project folder, source your `.env`, and ensure the background auto-start scripts executed properly:
```bash
# Source local project variables
source .env

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
This ensures your project-level `pi.config.ts` interceptor is successfully capturing and routing Pi's bash commands into the Daytona sandbox. Open Zed's terminal (Ctrl + ~), ensure you are in the project root, and run:
```bash
pi --template caveman "Run 'uname -n' in bash and tell me the hostname."
```
*Expected Result:* Pi should report the hostname of the sandbox (e.g., `pi-sandbox` or a container ID). If it returns your actual WSL machine's hostname, the interceptor hook in Step 6 failed and your system is not safely isolated.
