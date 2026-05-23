#!/usr/bin/env bash
#
# session-advice.sh — Post-hoc session analysis
#
# Delegates to scripts/session-advice.ts (the real runner).
#
# Usage:
#   ./scripts/session-advice.sh                  # all sessions
#   ./scripts/session-advice.sh <prefix>         # matching prefix
#   ./scripts/session-advice.sh --latest          # latest only
#   ./scripts/session-advice.sh --help            # this help
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/session-advice.ts"

[[ -f "$RUNNER" ]] || { echo "Error: $RUNNER not found" >&2; exit 1; }

TSX="./node_modules/.bin/tsx"
[[ -x "$TSX" ]] || TSX="$(command -v tsx)" || TSX="npx tsx"

case "${1:-}" in
	--help|-h)
		echo "Usage: $(basename "$0") [--latest | <prefix>]"
		echo ""
		echo "  (no args)   Analyze all sessions"
		echo "  --latest    Latest session only"
		echo "  <prefix>    Sessions matching prefix (e.g. 2026-05-23)"
		exit 0
		;;
esac

cd "$SCRIPT_DIR/.."
exec $TSX "$RUNNER" "$@"
