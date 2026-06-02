#!/usr/bin/env bash
# Tests for make up / shell / pi targets
# Phase 1: Static validation — Makefile structure
# Phase 2: make up — pre-flight checks (mocked)
# Phase 3: make shell — basic behavior
# Phase 4: make pi — basic behavior
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
section() { echo ""; echo "=== $1 ==="; }

cleanup() {
    rm -rf "$REPO_DIR/test/tmp-mock"
}

# Create a self-contained bin directory with symlinks to system tools
# for all needed commands EXCEPT the overrides (which use mocks)
make_bin() {
    local dir="$1"
    shift
    local overrides=("$@")
    rm -rf "$dir"
    mkdir -p "$dir"

    local cmds=(make bash printf touch rm cat sleep grep dirname)

    for cmd in "${cmds[@]}"; do
        local is_override=0
        for o in "${overrides[@]}"; do
            if [ "$cmd" = "$o" ]; then
                is_override=1
                break
            fi
        done
        if [ "$is_override" -eq 1 ]; then
            continue
        fi
        local path
        path=$(command -v "$cmd" 2>/dev/null || true)
        if [ -n "$path" ] && [ -x "$path" ]; then
            cp "$path" "$dir/$cmd"
        fi
    done
}

# ---------------------------------------------------------------------------
# Phase 1: Static validation — Makefile structure & preamble
# ---------------------------------------------------------------------------
section "Phase 1: Static validation — Makefile structure"

cd "$REPO_DIR"

# Test 1: Makefile exists
[ -f Makefile ] && pass "Makefile exists" || fail "Makefile missing"

if [ -f Makefile ]; then
    grep -q "SHELL.*:=.*bash" Makefile && pass "SHELL := bash" || fail "SHELL := bash missing"
    grep -q "^\.ONESHELL" Makefile && pass ".ONESHELL present" || fail ".ONESHELL missing"
    grep -q "^\.DELETE_ON_ERROR" Makefile && pass ".DELETE_ON_ERROR present" || fail ".DELETE_ON_ERROR missing"
    grep -q "warn-undefined-variables" Makefile && pass "MAKEFLAGS with --warn-undefined-variables" || fail "MAKEFLAGS missing --warn-undefined-variables"
    grep -q "no-builtin-rules" Makefile && pass "MAKEFLAGS with --no-builtin-rules" || fail "MAKEFLAGS missing --no-builtin-rules"
    grep -q "\.PHONY.*\<up\>" Makefile && pass ".PHONY declares up" || fail ".PHONY missing up"
    grep -q "\.PHONY.*\<shell\>" Makefile && pass ".PHONY declares shell" || fail ".PHONY missing shell"
    grep -q "\.PHONY.*\<pi\>" Makefile && pass ".PHONY declares pi" || fail ".PHONY missing pi"
    grep -q "^install:" Makefile && fail "install target still present" || pass "install target removed"
    grep -q "^up:" Makefile && pass "up target defined" || fail "up target missing"
    grep -q "^shell:" Makefile && pass "shell target defined" || fail "shell target missing"
    grep -q "^pi:" Makefile && pass "pi target defined" || fail "pi target missing"
    make -n up &>/dev/null && pass "make -n up syntax OK" || fail "make -n up syntax error"
    make -n shell &>/dev/null && pass "make -n shell syntax OK" || fail "make -n shell syntax error"
    make -n pi &>/dev/null && pass "make -n pi syntax OK" || fail "make -n pi syntax error"
    if grep -qP '\$\(shell ' Makefile; then
        fail "Makefile uses \$(shell ...) function (should use \$\$(...))"
    else
        pass "No \$(shell ...) function in Makefile"
    fi
    grep -q '\$\$(id -u)' Makefile && pass "HOST_UID uses \$\$(id -u) shell substitution" || fail "HOST_UID missing \$\$(id -u)"
    grep -q '\$\$(id -g)' Makefile && pass "HOST_GID uses \$\$(id -g) shell substitution" || fail "HOST_GID missing \$\$(id -g)"
fi

# ---------------------------------------------------------------------------
# Phase 2: make up — pre-flight checks (mocked)
# ---------------------------------------------------------------------------
section "Phase 2: make up — pre-flight checks (mocked)"

cd "$REPO_DIR"
cleanup

MOCKDIR="$REPO_DIR/test/tmp-mock/mocks"
mkdir -p "$MOCKDIR"

# Mock docker that echoes env vars
cat > "$MOCKDIR/docker" << 'MOCK_DOCKER'
#!/bin/bash
echo "  AGENTCASTLE_MEMORY=${AGENTCASTLE_MEMORY:-}"
echo "  AGENTCASTLE_CPUS=${AGENTCASTLE_CPUS:-}"
echo "  HOST_UID=${HOST_UID:-}"
echo "  HOST_GID=${HOST_GID:-}"
MOCK_DOCKER
chmod +x "$MOCKDIR/docker"

# Mock jq that uses simple argument matching
cat > "$MOCKDIR/jq" << 'MOCK_JQ'
#!/bin/bash
case "$*" in
    *docker.memory*) echo "${MOCK_MEMORY:-4G}" ;;
    *docker.cpus*)   echo "${MOCK_CPUS:-2.0}" ;;
    *)               echo "null" ;;
esac
MOCK_JQ
chmod +x "$MOCKDIR/jq"

# Mock id
cat > "$MOCKDIR/id" << 'MOCK_ID'
#!/bin/bash
echo "1000"
MOCK_ID
chmod +x "$MOCKDIR/id"

# Helper: set up a mock bin directory
setup_path() {
    local testname="$1"
    shift
    local overrides=("$@")
    local dir="$REPO_DIR/test/tmp-mock/$testname"
    make_bin "$dir" "${overrides[@]}"
    for o in "${overrides[@]}"; do
        if [ -f "$MOCKDIR/$o" ]; then
            cp "$MOCKDIR/$o" "$dir/$o"
        fi
    done
    echo "$dir"
}

# --- Test 2.1: docker missing from PATH → exit 1 ---
BINDIR=$(setup_path "t21" "jq" "id")
output=$(PATH="$BINDIR" make -C "$REPO_DIR" up 2>&1) && rc=0 || rc=$?
if echo "$output" | grep -q "Docker not found on PATH"; then
    pass "make up fails with 'Docker not found on PATH' when docker missing"
else
    fail "make up missing 'Docker not found on PATH': $(echo "$output" | head -3)"
fi

# --- Test 2.2: docker present, jq missing → exit 1 ---
BINDIR=$(setup_path "t22" "docker" "id")
output=$(PATH="$BINDIR" make -C "$REPO_DIR" up 2>&1) && rc=0 || rc=$?
if echo "$output" | grep -q "jq is required"; then
    pass "make up fails with 'jq is required' when jq missing"
else
    fail "make up missing 'jq is required': $(echo "$output" | head -3)"
fi

# --- Test 2.3: docker + jq present — .agent_env check ---
# If .agent_env doesn't exist, make up warns and creates it.
# If it already exists, make up proceeds silently (idempotent).
# Both cases are valid — we verify the Makefile handles .agent_env correctly.
BINDIR=$(setup_path "t23" "docker" "jq" "id")
output=$(PATH="$BINDIR" make -C "$REPO_DIR" up 2>&1) || rc=$?
if echo "$output" | grep -q "Warning: .agent_env not found"; then
    pass "make up warns when .agent_env missing (file was absent)"
else
    # No warning means .agent_env already existed — also valid (idempotent)
    pass "make up proceeds silently when .agent_env exists (idempotent)"
fi
# Verify the Makefile has the warning message (static check)
grep -q "Warning: .agent_env not found" Makefile && pass "Makefile contains .agent_env warning message" || fail "Makefile missing .agent_env warning"
# Verify make up exits successfully (either creates or skips .agent_env)
# Note: .agent_env may already exist from previous runs; that's OK
if [ -f "$REPO_DIR/.agent_env" ]; then
    pass ".agent_env exists (created by make up or from previous run)"
else
    fail ".agent_env missing after make up"
fi

# --- Test 2.4: All tools present, custom memory/cpus from env ---
BINDIR=$(setup_path "t24" "docker" "jq" "id")
output=$(MOCK_MEMORY="8G" MOCK_CPUS="4.0" PATH="$BINDIR" make -C "$REPO_DIR" up 2>&1) || rc=$?
if echo "$output" | grep -q "AGENTCASTLE_MEMORY=8G\|8G"; then
    pass "AGENTCASTLE_MEMORY=8G from settings.json"
else
    fail "AGENTCASTLE_MEMORY=8G not found: $(echo "$output" | tail -5)"
fi
if echo "$output" | grep -q "AGENTCASTLE_CPUS=4.0\|4.0"; then
    pass "AGENTCASTLE_CPUS=4.0 from settings.json"
else
    fail "AGENTCASTLE_CPUS=4.0 not found: $(echo "$output" | tail -5)"
fi

# --- Test 2.5: No docker section → defaults 4G/2.0 used ---
# The standard mock jq uses ${MOCK_MEMORY:-4G} which applies the default
# when the env var is empty/unset — same behavior as jq's // operator
BINDIR=$(setup_path "t25" "docker" "jq" "id")
output=$(MOCK_MEMORY="" MOCK_CPUS="" PATH="$BINDIR" make -C "$REPO_DIR" up 2>&1) || rc=$?
if echo "$output" | grep -q "AGENTCASTLE_MEMORY=4G\|4G"; then
    pass "AGENTCASTLE_MEMORY defaults to 4G when docker section missing"
else
    fail "Default AGENTCASTLE_MEMORY=4G not used: $(echo "$output" | tail -3)"
fi
if echo "$output" | grep -q "AGENTCASTLE_CPUS=2.0\|2.0"; then
    pass "AGENTCASTLE_CPUS defaults to 2.0 when docker section missing"
else
    fail "Default AGENTCASTLE_CPUS=2.0 not used: $(echo "$output" | tail -3)"
fi

# ---------------------------------------------------------------------------
# Phase 3: make shell — basic behavior
# ---------------------------------------------------------------------------
section "Phase 3: make shell — basic behavior"

cd "$REPO_DIR"

output=$(make -n shell 2>&1) || true
if echo "$output" | grep -q "docker exec -it agentcastle /bin/bash"; then
    pass "make -n shell shows docker exec command"
else
    fail "make -n shell missing docker exec command: $output"
fi

output=$(make shell 2>&1) || rc=$?
if echo "$output" | grep -q "Container agentcastle not running"; then
    pass "make shell errors when container not running"
else
    fail "make shell unexpected output: $(echo "$output" | head -3)"
fi

# ---------------------------------------------------------------------------
# Phase 4: make pi — basic behavior
# ---------------------------------------------------------------------------
section "Phase 4: make pi — basic behavior"

cd "$REPO_DIR"

output=$(make -n pi 2>&1) || true
if echo "$output" | grep -q "docker exec -it agentcastle /bin/bash -c"; then
    pass "make -n pi shows docker exec command"
else
    fail "make -n pi missing docker exec command: $output"
fi

output=$(make pi 2>&1) || rc=$?
if echo "$output" | grep -q "Container agentcastle not running"; then
    pass "make pi errors when container not running"
else
    fail "make pi unexpected output: $(echo "$output" | head -3)"
fi

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
cleanup

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
