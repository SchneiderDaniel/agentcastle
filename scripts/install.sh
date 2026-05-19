#!/usr/bin/env bash
# install.sh — Automated first-time setup for AgentCastle
#
# Installs all system dependencies, GitHub CLI, and npm global tools
# required to run AgentCastle on Ubuntu/Debian.
#
# Usage:
#   bash scripts/install.sh
#
# Designed for idempotency — safe to run multiple times.
# ---------------------------------------------------------------------------
set -euo pipefail

# --- ANSI helpers ----------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
step()  { echo -e "\n${BOLD}[STEP]${NC} $*"; }
ok()    { echo -e "  ${GREEN}[OK]${NC} $*"; }
skip()  { echo -e "  ${YELLOW}[SKIP]${NC} $*"; }
fail()  { echo -e "  ${RED}[FAIL]${NC} $*" >&2; exit 1; }
info()  { echo -e "  ${YELLOW}[INFO]${NC} $*"; }

# --- Platform check --------------------------------------------------------
step "Platform check"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    case "${ID:-}" in
        ubuntu|debian)
            ok "Detected ${ID} ${VERSION_ID:-}"
            ;;
        *)
            fail "Unsupported OS — Ubuntu/Debian required (detected: ${ID:-unknown})"
            ;;
    esac
else
    fail "Cannot detect OS — /etc/os-release not found. Ubuntu/Debian required."
fi

# --- sudo check (lazy — first sudo call will prompt) -----------------------
step "sudo access"
if ! sudo -v; then
    fail "sudo access required for apt package installation"
fi

# --- apt update ------------------------------------------------------------
step "apt-get update"
sudo apt-get update
ok "Package lists updated"

# --- APT packages ----------------------------------------------------------
# Install an apt package.
# Usage: install_apt <package-name> <binary-name>
# Skips if binary already on PATH. Verifies binary exists after install.
install_apt() {
    local pkg="$1"
    local binary="$2"

    if command -v "$binary" &>/dev/null; then
        skip "$pkg already installed ($(command -v "$binary"))"
        return 0
    fi

    step "apt: $pkg"
    sudo apt-get install -y "$pkg"
    if command -v "$binary" &>/dev/null; then
        ok "$pkg installed ($(command -v "$binary"))"
    else
        fail "$pkg — install succeeded but binary not found"
    fi
}

# python3-venv has no standalone binary; check via dpkg instead of binary check
# Using dpkg -l with 'ii' status = package is installed and configured
install_apt_venv() {
    local pkg="python3-venv"

    if dpkg -l "$pkg" 2>/dev/null | grep -q '^ii'; then
        skip "$pkg already installed (dpkg)"
        return 0
    fi

    step "apt: $pkg"
    sudo apt-get install -y "$pkg"
    if dpkg -l "$pkg" 2>/dev/null | grep -q '^ii'; then
        ok "$pkg installed"
    else
        fail "$pkg — install succeeded but package not found"
    fi
}

install_apt "python3"         "python3"
install_apt "python3-pip"     "pip3"
install_apt_venv
install_apt "jq"              "jq"
install_apt "unzip"           "unzip"
install_apt "universal-ctags" "ctags"
install_apt "ripgrep"         "rg"
install_apt "wget"            "wget"

# --- Node.js via NodeSource 22.x -------------------------------------------
step "Node.js 22.x"
if command -v node &>/dev/null || command -v nodejs &>/dev/null; then
    NODE_BIN=$(command -v node || command -v nodejs)
    skip "Node.js already installed ($("${NODE_BIN}" --version 2>/dev/null || echo "$NODE_BIN"))"
else
    step "NodeSource setup 22.x"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    step "apt: nodejs (via NodeSource)"
    sudo apt-get install -y nodejs
    if command -v node &>/dev/null; then
        ok "Node.js installed ($(node --version))"
    else
        fail "nodejs — binary not found after install"
    fi
fi

# --- GitHub CLI ------------------------------------------------------------
step "GitHub CLI (gh)"
if command -v gh &>/dev/null; then
    skip "gh already installed ($(gh --version 2>&1 | head -1))"
else
    step "GitHub CLI repository setup"
    (type -p wget >/dev/null || sudo apt-get install wget -y) >/dev/null 2>&1
    sudo mkdir -p -m 755 /etc/apt/keyrings
    wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update
    step "apt: gh"
    sudo apt-get install -y gh
    if command -v gh &>/dev/null; then
        ok "GitHub CLI installed ($(gh --version 2>&1 | head -1))"
    else
        fail "gh — binary not found after install"
    fi
fi

# --- npm global tools ------------------------------------------------------
NPM_GLOBAL_DIR="$HOME/.npm-global"
EACCES_RECOVERED=false

install_npm_global() {
    local pkg="$1"
    local binary="$2"

    if command -v "$binary" &>/dev/null; then
        skip "$pkg already installed ($(command -v "$binary"))"
        return 0
    fi

    step "npm: $pkg"

    local npm_err
    npm_err=$(mktemp)

    # Try with sudo first; fall back to user prefix on EACCES
    if sudo npm install -g "$pkg" 2>"$npm_err"; then
        rm -f "$npm_err"
        if command -v "$binary" &>/dev/null; then
            ok "$pkg installed ($(command -v "$binary"))"
            return 0
        fi
    fi

    # Check if failure was EACCES — if not, print the error and fail
    local err_content
    err_content=$(cat "$npm_err")
    rm -f "$npm_err"

    if echo "$err_content" | grep -qi "eacces\|permission denied\|EACCES"; then
        # EACCES fallback — configure user-owned prefix
        info "EACCES detected — configuring user-level npm prefix ..."
        mkdir -p "$NPM_GLOBAL_DIR"
        npm config set prefix "$NPM_GLOBAL_DIR"
        # Ensure ~/.npm-global/bin is on PATH for the rest of this script
        export PATH="$NPM_GLOBAL_DIR/bin:$PATH"
        EACCES_RECOVERED=true

        local npm_err2
        npm_err2=$(mktemp)
        if npm install -g "$pkg" 2>"$npm_err2"; then
            rm -f "$npm_err2"
            if command -v "$binary" &>/dev/null; then
                ok "$pkg installed (user prefix, $(command -v "$binary"))"
                return 0
            fi
        fi
        local err2_content
        err2_content=$(cat "$npm_err2")
        rm -f "$npm_err2"
        fail "$pkg — install failed (user prefix). npm output: $err2_content"
    else
        fail "$pkg — install failed. npm output: $err_content"
    fi
}

install_npm_global "@earendil-works/pi-coding-agent" "pi"
install_npm_global "@ast-grep/cli"                   "ast-grep"
install_npm_global "typescript"                       "tsc"

# --- EACCES recovery: persist PATH to ~/.profile ---------------------------
if [ "$EACCES_RECOVERED" = true ]; then
    step "Persisting npm global PATH"
    local path_line='export PATH="$HOME/.npm-global/bin:$PATH"'
    local profile_file="$HOME/.profile"

    if grep -q "npm-global/bin" "$profile_file" 2>/dev/null; then
        skip "PATH already configured in $profile_file"
    else
        echo "$path_line" >> "$profile_file"
        ok "Added npm-global/bin to PATH in $profile_file"
        info "Run 'source $profile_file' or open new terminal for changes to take effect"
    fi
fi

# --- Version verification --------------------------------------------------
step "Version verification"

# node >=22
NODE_VER="$(node --version 2>/dev/null || nodejs --version 2>/dev/null || echo "none")"
if [ "$NODE_VER" = "none" ]; then
    fail "node not found"
fi
NODE_MAJOR="$(echo "$NODE_VER" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
    fail "node >=22 required, found $NODE_VER"
fi
ok "node $NODE_VER (>=22)"

# ast-grep >=0.42
AST_GREP_VER="$(ast-grep --version 2>/dev/null || echo "none")"
if [ "$AST_GREP_VER" = "none" ]; then
    fail "ast-grep not found"
fi
AST_GREP_NUM="$(echo "$AST_GREP_VER" | grep -oP '\d+\.\d+' | head -1)"
if [ -z "$AST_GREP_NUM" ]; then
    fail "cannot parse ast-grep version: $AST_GREP_VER"
fi
AST_GREP_MAJOR="$(echo "$AST_GREP_NUM" | cut -d. -f1)"
AST_GREP_MINOR="$(echo "$AST_GREP_NUM" | cut -d. -f2)"
if [ "$AST_GREP_MAJOR" -lt 0 ] || { [ "$AST_GREP_MAJOR" -eq 0 ] && [ "$AST_GREP_MINOR" -lt 42 ]; } 2>/dev/null; then
    fail "ast-grep >=0.42 required, found $AST_GREP_VER"
fi
ok "ast-grep $AST_GREP_VER (>=0.42)"

# pi >=0.74
PI_VER="$(pi --version 2>/dev/null || echo "none")"
if [ "$PI_VER" = "none" ]; then
    fail "pi not found"
fi
PI_NUM="$(echo "$PI_VER" | grep -oP '\d+\.\d+' | head -1)"
if [ -z "$PI_NUM" ]; then
    fail "cannot parse pi version: $PI_VER"
fi
PI_MAJOR="$(echo "$PI_NUM" | cut -d. -f1)"
PI_MINOR="$(echo "$PI_NUM" | cut -d. -f2)"
if [ "$PI_MAJOR" -lt 0 ] || { [ "$PI_MAJOR" -eq 0 ] && [ "$PI_MINOR" -lt 74 ]; } 2>/dev/null; then
    fail "pi >=0.74 required, found $PI_VER"
fi
ok "pi $PI_VER (>=0.74)"

# --- Done ------------------------------------------------------------------
echo ""
echo -e "${GREEN}All dependencies installed and verified.${NC}"
echo "Run 'gh auth login' to authenticate GitHub CLI (manual step)."
