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
