Here is the refined and corrected version of the **Agentcastle** stack. I’ve reordered the sections so that your environment variables exist *before* the tools try to call them, and I've integrated the `OPENCODE` key into the toolchain so it actually serves a purpose.

---

# Agentcastle: The Pi Stack (Full 2026 Edition)

High-performance, secure, and local-first development environment using **WSL (Ubuntu) + Zed + Git Worktrees + Pi AI**.

## 0. Prerequisites & Runtimes
This setup bypasses broken install scripts by pulling binaries directly to ensure stability in WSL Ubuntu 24.04.

```bash
# 1. Base Runtimes
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip python3-venv jq unzip
sudo npm install -g npm@latest

# 2. Docker & Daytona
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER # Restart WSL after this

# 2.1. Manual Daytona Install
sudo curl -L "https://github.com/daytonaio/daytona/releases/latest/download/daytona-linux-amd64" -o /usr/local/bin/daytona
sudo chmod +x /usr/local/bin/daytona

# 3. Pi Agent & MCP Adapter
sudo npm install -g @mariozechner/pi-coding-agent
```

---

## 1. Security & Environment (The Foundation)
We set this up **first** so the agent doesn't throw "undefined" errors during configuration.

### 1.1 Create your Global Secret Store
Create a file at `~/.agent_env`:
```bash
# ~/ .agent_env
export OPENCODE_GO_API_KEY="opencode-go-..."
export APIFY_TOKEN="apify_api_..."
```

### 1.2 Link to Bash
Add this to the bottom of your `~/.bashrc` to ensure variables are always available:
```bash
if [ -f "$HOME/.agent_env" ]; then
    source "$HOME/.agent_env"
fi
```
**Run `source ~/.bashrc` now to load them.**

---

## 2. Workspace & Git
### 2.1 The Golden Rule
All code lives in the Linux filesystem (`~/...`). **Never** use `/mnt/c/`; it destroys Docker performance and breaks the agent's file-watching capabilities.

### 2.2 Bare Worktree Workflow
Run isolated Pi agents simultaneously in different Zed windows without context bleeding.
```bash
mkdir my-project && cd my-project
git clone --bare git@github.com:Username/repo.git .bare
echo "gitdir: ./.bare" > .git

# Add a feature branch worktree
git worktree add -b feature/logic feature-logic
cd feature-logic
```

---

## 3. The Core: Editor & Agent Configuration
Pi lives in Zed's integrated terminal (**Ctrl + ~**). Ensure your terminal defaults to the **WSL Ubuntu profile**.

### 3.1 Initialize the MCP Bridge
Create `~/.config/pi/pi.config.ts`:
```typescript
import { setupMCP } from "pi-mcp-adapter";
import { interceptTool } from "pi-core/hooks";

export default async function configurePi(pi) {
  // 1. Mount MCPs using the environment variables we sourced in Section 1
  await setupMCP(pi, {
    agentmemory: { command: "npx", args: ["-y", "@agentmemory/mcp"] },
    crawl4ai: { 
      command: "npx", 
      args: ["-y", "@apify/actors-mcp-server", "--actors", "janbuchar/crawl4ai"],
      env: { APIFY_TOKEN: process.env.APIFY_TOKEN }
    }
  });

  // 2. OpenCode Search Graph
  // Uses the OPENCODE_GO_API_KEY for authorized local indexing
  pi.registerTool("search_graph", async (query) => {
    const res = await fetch(`http://localhost:9749/search?q=${encodeURIComponent(query)}`, {
        headers: { "Authorization": `Bearer ${process.env.OPENCODE_GO_API_KEY}` }
    });
    return await res.json();
  });
```

---

## 4. Execution Security (Hardcoded Hooks)
**CRITICAL:** This force-routes Pi's code execution into the OCI sandbox to prevent "hallucinated" commands from damaging your host. 

Append this to `~/.config/pi/pi.config.ts`:
```typescript
  // 3. The Daytona Sandbox Interceptor
  interceptTool("bash", async (context, originalCommand) => {
    const safePrefixes = ["git ", "gh ", "cat ", "ls ", "npx impeccable "];
    const isSafe = safePrefixes.some(prefix => originalCommand.trim().startsWith(prefix));
    
    if (isSafe) return { modifiedCommand: originalCommand };

    // Initialize sandbox if not exists, then execute
    const daytonaWrapped = `daytona exec pi-sandbox -- "${originalCommand}"`;
    return { modifiedCommand: daytonaWrapped };
  });
}
```

---

## 5. The "Brain" Protocol
Create `~/.config/pi/templates/caveman.md`. This forces the agent to use the tools you just configured.

```markdown
### 1. Communication
Terse. No fluff. Pattern: [action] [reason]. [next step].

### 2. Tool Routing
* Web Search: Use `crawl4ai` for documentation.
* Code Search: Use `search_graph` for cross-file logic.
* Sandbox: All complex logic/tests run via `bash` (Daytona).
```

---

## 6. Workflows & Maintenance

| Action | Command |
|---|---|
| **Start Session** | `pi --template caveman` |
| **Verify Keys** | `echo $APIFY_TOKEN` |
| **Reset Sandbox** | `daytona delete pi-sandbox && daytona create --name pi-sandbox` |
| **Update Agent** | `sudo npm install -g @mariozechner/pi-coding-agent@latest` |

> [!IMPORTANT]
> If `search_graph` fails, ensure your OpenCode local server is running on port **9749**. If you aren't using a local indexer, you can remove that tool from the config.
