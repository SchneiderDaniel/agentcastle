Here is the final, corrected documentation. I have completely ripped out the broken `models.json` section and replaced it with the native OpenCode configuration, setting `opencode-go` as your permanent default so you never have to type a flag or login command again.

---

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
Pi and its MCP tools inherit environment variables from your terminal. We set this up *first* to avoid missing keys and authentication errors.

### 1.1 Create the Secret Store
Create `~/.agent_env`:
```bash
export OPENCODE_API_KEY="opencode-go-..."
export APIFY_TOKEN="apify_api_..."
```

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

## 2. Workspace & Git
### 2.1 WSL (Ubuntu) & SSH
* **The Golden Rule:** All code lives in the Linux filesystem (`~/...`). **Never** use `/mnt/c/` for active dev work.

### 2.2 Bare Worktree Workflow
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

## 3. AI Provider Setup (The OpenCode Config)
OpenCode and OpenCode Go are **natively supported** by Pi. Because we loaded the `OPENCODE_API_KEY` environment variable into our terminal memory in Section 1, Pi will automatically authenticate. We just need to tell it which model to use.

### 3.1 The Default Override (`settings.json`)
Force Pi to use the native OpenCode Go provider by default so you don't have to select it manually or pass flags every session. 

Create `~/.pi/agent/settings.json`:
```json
{
  "defaultProvider": "opencode-go"
}
```


---

## 4. The Core: Editor & Agent (Zed)
Pi lives in Zed's integrated terminal (Ctrl + ~). Ensure the terminal defaults to your **WSL Ubuntu profile**.

---

## 5. The Agent Toolchain (The MCP Bridge)
Since your `.agent_env` is sourced, `process.env.APIFY_TOKEN` will resolve properly. Create `~/.config/pi/pi.config.ts`:

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
      env: { APIFY_TOKEN: process.env.APIFY_TOKEN }
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
**CRITICAL:** This force-routes Pi's code execution into the OCI sandbox. Append to `~/.config/pi/pi.config.ts`:

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
Create `~/.config/pi/templates/caveman.md`:
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
| **Start Session** | `pi --template caveman` |
| **Check Sandbox** | `daytona list` |
| **Restart Docker** | `sudo service docker start` |
