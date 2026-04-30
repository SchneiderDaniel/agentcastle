# agentcastle

This README is designed to document your high-performance development environment. It covers the transition from Windows-based coding to a native **WSL (Ubuntu)** workflow using **Zed** and **Git Worktrees**.

---

# 🚀 WSL + Zed + Git Worktree Setup

This repository uses a "Pro" Git configuration. Instead of a standard clone, we use a **Bare Repository** combined with **Worktrees**. This allows for multiple branches to be open in separate folders simultaneously without file system conflicts or constant branch switching.

## 1. The Environment: WSL (Ubuntu)
We use Ubuntu as the primary development environment to ensure native Linux performance and compatibility with modern dev tools.

*   **Distro:** Ubuntu 24.04 LTS (Recommended)
*   **The Golden Rule:** All code lives in the Linux filesystem (`~/home/user/..`) and **never** on the Windows mount (`/mnt/c/`). This avoids permission errors (`chmod`) and provides 10x faster file indexing.

---

## 2. Authentication: SSH Keys
To interact with GitHub without entering passwords, we use SSH keys.

### Setup Steps:
1.  **Generate Key:**
    `ssh-keygen -t ed25519 -C "your-email@example.com"`
2.  **Copy Public Key:**
    `cat ~/.ssh/id_ed25519.pub`
3.  **Add to GitHub:** 
    Paste the output into [GitHub SSH Settings](https://github.com/settings/keys).
4.  **Test Connection:**
    `ssh -T git@github.com`

---

## 3. The "Bare" Worktree Workflow
Instead of `git clone <url>`, we use a layout that separates the Git metadata from the working files.

### Initial Setup (The "One-Time" Dance)
```bash
# 1. Create project root
mkdir my-project && cd my-project

# 2. Clone as a bare repo (metadata only)
git clone --bare git@github.com:Username/repo.git .bare

# 3. Create a pointer to the metadata
echo "gitdir: ./.bare" > .git

# 4. Add your first worktree (the main branch)
git worktree add main
```

### Daily Usage: Adding New Branches
To work on a new feature without disturbing your `main` folder:
```bash
git worktree add -b feature/login feature-login
```
This creates a new folder `feature-login/` instantly.

---

## 4. Editor Integration: Zed
**Zed** runs on Windows but communicates with a headless server inside WSL.

*   **Opening a Project:** From the Ubuntu terminal, navigate to the specific worktree and type:
    `zed .`
*   **Why specific folders?** Always open the specific worktree folder (e.g., `main/`) so Zed’s Language Server (LSP) can correctly map the project root for autocomplete and "Go to Definition."

---

## 5. Cheat Sheet

| Action | Command |
| :--- | :--- |
| **List all worktrees** | `git worktree list` |
| **Remove a worktree** | `rm -rf <folder>` then `git worktree prune` |
| **Check WSL status** | `wsl --list --verbose` |
| **Open Linux files in Windows** | `explorer.exe .` (from WSL) |
| **Git push** | git push --set-upstream origin main |

---

> **Note:** If you encounter `Operation not permitted` errors, ensure you are not inside `/mnt/c/`. The Linux `~` (home) directory is your safe haven.
