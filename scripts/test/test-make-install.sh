#!/usr/bin/env bash
# Phase 1: Static validation for Makefile + install.sh
# Tests that Makefile and install.sh have correct structure.
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

cd "$REPO_DIR"

echo "=== Phase 1: Makefile static validation ==="

# Test 1: Makefile exists
[ -f Makefile ] && pass "Makefile exists" || fail "Makefile missing"

if [ -f Makefile ]; then
    # Test 2: .PHONY declares install
    grep -q ".PHONY.*install" Makefile && pass ".PHONY declares install" || fail ".PHONY missing install"
    
    # Test 3: SHELL := bash
    grep -q "SHELL.*:=.*bash" Makefile && pass "SHELL := bash" || fail "SHELL := bash missing"
    
    # Test 4: .ONESHELL
    grep -q ".ONESHELL" Makefile && pass ".ONESHELL present" || fail ".ONESHELL missing"
    
    # Test 5: .DELETE_ON_ERROR
    grep -q ".DELETE_ON_ERROR" Makefile && pass ".DELETE_ON_ERROR present" || fail ".DELETE_ON_ERROR missing"
    
    # Test 6: install target calls scripts/install.sh
    grep -q "scripts/install.sh" Makefile && pass "install target delegates to scripts/install.sh" || fail "install target missing scripts/install.sh call"
fi

echo ""
echo "=== Phase 1: install.sh static validation ==="

# Test 7: install.sh exists
[ -f "$REPO_DIR/scripts/install.sh" ] && pass "scripts/install.sh exists" || fail "scripts/install.sh missing"

if [ -f "$REPO_DIR/scripts/install.sh" ]; then
    # Test 8: syntax check
    bash -n "$REPO_DIR/scripts/install.sh" && pass "install.sh syntax OK" || fail "install.sh syntax error"
    
    # Test 9: set -euo pipefail
    grep -q "set -euo pipefail" "$REPO_DIR/scripts/install.sh" && pass "install.sh has set -euo pipefail" || fail "install.sh missing set -euo pipefail"
    
    # Test 10: platform check
    grep -q "debian" "$REPO_DIR/scripts/install.sh" && pass "install.sh checks for Debian" || fail "install.sh missing Debian check"
    
    # Test 11: apt-get update
    grep -q "apt-get update" "$REPO_DIR/scripts/install.sh" && pass "install.sh runs apt-get update" || fail "install.sh missing apt-get update"
    
    # Test 12: skip-if-present checks (which or command -v)
    (grep -q "which " "$REPO_DIR/scripts/install.sh" || grep -q "command -v" "$REPO_DIR/scripts/install.sh") && pass "install.sh has skip-if-present checks" || fail "install.sh missing skip checks"
    
    # Test 13: npm global install
    grep -q "npm.*install.*-g" "$REPO_DIR/scripts/install.sh" && pass "install.sh installs npm globals" || fail "install.sh missing npm global install"
    
    # Test 14: EACCES recovery
    grep -q "EACCES\|npm-global\|npm config set prefix" "$REPO_DIR/scripts/install.sh" && pass "install.sh handles EACCES" || fail "install.sh missing EACCES recovery"
    
    # Test 15: version verification
    grep -q "node.*version\|--version\|>=22\|>=0.42\|>=0.74" "$REPO_DIR/scripts/install.sh" && pass "install.sh verifies versions" || fail "install.sh missing version verification"
fi

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
