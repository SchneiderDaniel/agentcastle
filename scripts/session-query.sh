#!/usr/bin/env bash
#
# session-query.sh — Query JSONL session logs with jq
#
# Usage:
#   ./scripts/session-query.sh 'select(.error != null)'
#   ./scripts/session-query.sh -f .pi/sessions/abc123.jsonl 'select(.tool == "bash")'
#   cat .pi/sessions/latest.jsonl | ./scripts/session-query.sh 'select(.error != null)'
#   ./scripts/session-query.sh --help
#
# Default target: .pi/sessions/latest.jsonl
#
set -euo pipefail

DEFAULT_FILE=".pi/sessions/latest.jsonl"
TARGET=""
JQ_FILTER=""
HELP=false
EXPLICIT_FILE=false

usage() {
	cat <<EOF
Usage: $(basename "$0") [OPTIONS] '<jq-filter>'

Query JSONL session logs using jq.

Options:
  -f FILE    Path to JSONL file (default: $DEFAULT_FILE)
  --help     Show this help message

Examples:
  $(basename "$0") 'select(.error != null)'
  $(basename "$0") -f .pi/sessions/abc.jsonl 'select(.tool == "bash")'
  cat .pi/sessions/latest.jsonl | $(basename "$0") '.tool'
  $(basename "$0") 'select(.token_usage.total > 10000)'
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
	case "$1" in
		-f)
			TARGET="$2"
			EXPLICIT_FILE=true
			shift 2
			;;
		--help|-h)
			HELP=true
			shift
			;;
		*)
			# Remaining arg is the jq filter
			JQ_FILTER="$1"
			shift
			;;
	esac
done

if [[ "$HELP" == true ]]; then
	usage
	exit 0
fi

# Determine target file
if [[ -z "$TARGET" ]]; then
	TARGET="$DEFAULT_FILE"
fi

# If stdin is not a terminal AND no explicit -f flag, use pipe mode
if [[ ! -t 0 && "$EXPLICIT_FILE" != "true" ]]; then
	# Data coming from pipe — use stdin as input
	if [[ -n "$JQ_FILTER" ]]; then
		jq -c "$JQ_FILTER"
	else
		jq -c .
	fi
else
	# Read from file
	if [[ ! -f "$TARGET" ]]; then
		echo "Error: File not found: $TARGET" >&2
		exit 1
	fi

	if [[ -z "$JQ_FILTER" ]]; then
		jq -c . "$TARGET"
	else
		jq -c "$JQ_FILTER" "$TARGET"
	fi
fi
