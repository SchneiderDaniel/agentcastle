# Agentcastle: The Pi Stack (Updated for Daytona v0.17x)

High-performance, secure, and local-first development environment using WSL (Ubuntu) + Zed + Git Worktrees + Pi AI. Updated to support the latest Daytona binary-only installation and new CLI syntax.

## 0. Prerequisites
Before starting, ensure your WSL (Ubuntu 24.04 LTS) environment has the necessary runtimes:

```bash
# 1. Base Runtimes
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip python3-venv jq unzip

# 2. Docker & Daytona (Required for container sandboxing)
# Install Docker Engine natively in WSL
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER # Logout/Login required after this

# 2.1. Manual Daytona Binary Install (Fixes 404/Silent Install issues)
sudo curl -L "https://github.com/daytonaio/daytona/releases/latest/download/daytona-linux-amd64" -o /usr/local/bin/daytona
sudo chmod +x /usr/local/bin/daytona

# 2.2. Initialize Daytona
daytona login
daytona create --name pi-sandbox # Create the persistent sandbox for the agent

# 3. Pi Agent & MCP Adapter
sudo npm install -g @mariozechner/pi-coding-agent @mariozechner/pi-mcp-adapter

# 4. GitHub CLI 
sudo apt-get install gh
```

---

## 1. Foundation: Environment & Git
### 1.1 WSL (Ubuntu) & SSH
Ubuntu is the primary development environment. 
* **The Golden Rule:** All code lives in the Linux filesystem (`~/...`). **Never** use the Windows mount (`/mnt/c/`) to ensure Docker socket performance and rapid indexing.

---

## 5. Execution Security (Hardcoded Hooks)
**CRITICAL:** We use the modern Daytona `exec` syntax for v0.171.0+. This routes untrusted code into the `pi-sandbox` OCI container.

Update your `~/.config/pi/pi.config.ts`:

```typescript
  // 3. The Daytona Sandbox Interceptor (Updated for v0.17x)
  // Intercepts native Bash executions and routes untrusted code into the OCI sandbox
  interceptTool("bash", async (context, originalCommand) => {
    // Whitelist safe CLI tools to run natively on the host for speed
    const safePrefixes = ["git ", "gh ", "cat ", "ls ", "npx impeccable "];
    const isSafe = safePrefixes.some(prefix => originalCommand.trim().startsWith(prefix));
    
    if (isSafe) {
      return { modifiedCommand: originalCommand };
    }

    // Wrap execution (node, python, npm, pytest) safely in the pre-created sandbox
    // Uses 'exec' instead of 'run' for modern Daytona compatibility
    const daytonaWrapped = `daytona exec pi-sandbox -- "${originalCommand}"`;
    return { modifiedCommand: daytonaWrapped };
  });
}
```

---

## 7. Workflows & Best Practices
| Action | Command |
|---|---|
| **Check Sandbox Status** | `daytona list` |
| **Restart Sandbox** | `daytona start pi-sandbox` |
| **List all worktrees** | `git worktree list` |
| **Open Linux files in Windows** | `explorer.exe .` |

### Pro-Tip: The Auto-Start
Add this to your `~/.bashrc` to ensure your Docker service and background memory agents are ready for Pi:

```bash
# Start Docker if not running (Native WSL)
if ! pgrep -x "dockerd" > /dev/null; then
    sudo service docker start
fi

# Load global secrets
if [ -f "$HOME/.agent_env" ]; then
    set -a
    source "$HOME/.agent_env"
    set +a
fi

# Start Codebase-Memory graph in background if not running
pgrep -f "agentmemory" > /dev/null || (npx -y @agentmemory/agentmemory > /dev/null 2>&1 &)
```
