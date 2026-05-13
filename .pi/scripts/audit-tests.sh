#!/usr/bin/env bash
# Audit test execution — deterministic test runner for the auditor agent.
# Replaces LLM-interpreted test execution logic with explicit commands.
#
# Usage:
#   audit-tests.sh run <branch-name> <test-plan-file>
#
# Reads test plan, extracts bash code blocks, executes each in the worktree
# with 60s timeout, outputs JSON result. LLM reads JSON and decides approve/reject.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKTREE_BASE=".."
TIMEOUT_SEC=60
MAX_LINES=20

# --- Helpers ----------------------------------------------------------------

die() { echo "ERROR: $*" >&2; exit 1; }

# Extract fenced bash code blocks from a markdown file.
# Outputs one command per non-empty, non-comment line.
# Lines ending with \ are joined with the next line.
extract_commands() {
    local file="$1"
    local in_block=0
    local cmd_buffer=""

    while IFS= read -r line; do
        # Match ```bash or ``` (no language tag)
        if [[ "$line" =~ ^\`\`\`(bash)?$ ]]; then
            if [ "$in_block" -eq 0 ]; then
                in_block=1
                cmd_buffer=""
            else
                in_block=0
                # Flush remaining buffer
                if [ -n "$cmd_buffer" ]; then
                    cmd_buffer=$(echo "$cmd_buffer" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
                    if [ -n "$cmd_buffer" ] && ! [[ "$cmd_buffer" =~ ^[[:space:]]*# ]]; then
                        echo "$cmd_buffer"
                    fi
                fi
            fi
            continue
        fi
        if [ "$in_block" -eq 1 ]; then
            # Skip empty lines and comment-only lines
            local trimmed
            trimmed=$(echo "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
            [ -z "$trimmed" ] && continue
            [[ "$trimmed" =~ ^# ]] && continue

            # Check for line continuation (ends with \)
            if [[ "$line" =~ \\$ ]]; then
                # Remove trailing \ and append to buffer
                cmd_buffer+="${line%\\}"
            elif [ -n "$cmd_buffer" ]; then
                # Previous line was continuation, this is last line
                cmd_buffer+="$line"
                cmd_buffer=$(echo "$cmd_buffer" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
                echo "$cmd_buffer"
                cmd_buffer=""
            else
                # Standalone line
                echo "$trimmed"
            fi
        fi
    done < "$file"
}

# Execute a test command with timeout. Returns JSON fragment.
run_one_test() {
    local worktree_dir="$1"
    local cmd="$2"
    local start_time end_time duration exit_code
    local stdout_file stderr_file

    stdout_file=$(mktemp)
    stderr_file=$(mktemp)

    start_time=$(date +%s.%N)

    # Run with timeout
    if timeout "$TIMEOUT_SEC" bash -c "cd '$worktree_dir' && $cmd" \
        >"$stdout_file" 2>"$stderr_file"; then
        exit_code=0
    else
        exit_code=$?
    fi

    end_time=$(date +%s.%N)
    duration=$(echo "scale=3; ($end_time - $start_time)/1" | bc 2>/dev/null || echo "0.000")
    # Ensure leading zero for values < 1 (bc outputs .123 not 0.123)
    if [[ "$duration" == .* ]]; then
        duration="0$duration"
    fi

    local timed_out=0
    if [ "$exit_code" -eq 124 ]; then
        timed_out=1
    fi

    # Read output
    local stdout_text stderr_text
    stdout_text=$(cat "$stdout_file" 2>/dev/null || echo "")
    stderr_text=$(cat "$stderr_file" 2>/dev/null || echo "")

    # Truncate
    local stdout_trunc=0 stderr_trunc=0
    local stdout_lines stderr_lines
    stdout_lines=$(echo "$stdout_text" | wc -l)
    stderr_lines=$(echo "$stderr_text" | wc -l)

    if [ "$stdout_lines" -gt "$MAX_LINES" ]; then
        stdout_text=$(echo "$stdout_text" | head -"$MAX_LINES")
        stdout_trunc=1
    fi
    if [ "$stderr_lines" -gt "$MAX_LINES" ]; then
        stderr_text=$(echo "$stderr_text" | head -"$MAX_LINES")
        stderr_trunc=1
    fi

    # Parse failed test names
    local failed_tests
    failed_tests=$(parse_failed_tests "$stdout_text" "$stderr_text")

    # Escape for JSON
    local cmd_escaped stdout_escaped stderr_escaped
    cmd_escaped=$(echo "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')
    stdout_escaped=$(echo "$stdout_text" | sed 's/\\/\\\\/g; s/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')
    stderr_escaped=$(echo "$stderr_text" | sed 's/\\/\\\\/g; s/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')

    # Build failed_tests JSON array
    local ft_json="["
    local first=1
    while IFS= read -r test_name; do
        [ -z "$test_name" ] && continue
        local tn_escaped
        tn_escaped=$(echo "$test_name" | sed 's/\\/\\\\/g; s/"/\\"/g')
        if [ "$first" -eq 1 ]; then
            ft_json+="\"$tn_escaped\""
            first=0
        else
            ft_json+=", \"$tn_escaped\""
        fi
    done <<< "$failed_tests"
    ft_json+="]"

    cat <<EOF
{
  "command": "$cmd_escaped",
  "exit_code": $exit_code,
  "stdout": "$stdout_escaped",
  "stderr": "$stderr_escaped",
  "stdout_truncated": $stdout_trunc,
  "stderr_truncated": $stderr_trunc,
  "timed_out": $timed_out,
  "duration_sec": $duration,
  "failed_tests": $ft_json
}
EOF

    rm -f "$stdout_file" "$stderr_file"
}

# Parse failed test names from test output.
# Looks for common test framework failure patterns: ✗, FAIL, not ok, assertion errors.
parse_failed_tests() {
    local stdout="$1"
    local stderr="$2"
    local combined="${stdout}
${stderr}"

    echo "$combined" | grep -oE '(✗[^(
]{5,}|FAIL[^(
]{5,}|not ok[^(
]{5,})' 2>/dev/null | \
        head -20 | \
        sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true
}

# --- Commands ---------------------------------------------------------------

cmd_run() {
    local branch_name="$1"
    local test_plan_file="$2"

    [ -f "$test_plan_file" ] || die "Test plan file not found: $test_plan_file"

    local worktree_dir="${WORKTREE_BASE}/${branch_name}"
    [ -d "$worktree_dir" ] || die "Worktree not found: $worktree_dir"

    # Extract commands
    local commands
    commands=$(extract_commands "$test_plan_file")

    if [ -z "$commands" ]; then
        cat <<EOF
{
  "status": "no_commands",
  "error": "No runnable test command found in test plan",
  "message": "No fenced bash code block found in test plan. Auditor should reject with: ## Audit Rejected\\n\\nNo runnable test command found in test plan.\\n\\nPlease fix and resubmit.",
  "results": []
}
EOF
        return 0
    fi

    # Run each command
    local results=""
    local first=1
    local overall_status="passed"
    local overall_message=""

    while IFS= read -r cmd; do
        [ -z "$cmd" ] && continue
        echo "Running: $cmd" >&2

        local result_json
        result_json=$(run_one_test "$worktree_dir" "$cmd")

        local exit_code
        exit_code=$(echo "$result_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['exit_code'])" 2>/dev/null || echo "1")

        if [ "$first" -eq 0 ]; then
            results+=","
        fi
        results+="$result_json"
        first=0

        if [ "$exit_code" -ne 0 ] && [ "$overall_status" = "passed" ]; then
            overall_status="failed"
        fi
    done <<< "$commands"

    # Determine final status
    if [ "$overall_status" = "passed" ]; then
        overall_message="All test commands passed. Auditor should proceed to evaluation step."
    else
        overall_message="One or more test commands failed. Auditor should reject with failure details from results."
    fi

    cat <<EOF
{
  "status": "$overall_status",
  "commands_found": $(echo "$commands" | wc -l),
  "message": "$overall_message",
  "results": [$results]
}
EOF
}

# --- Main -------------------------------------------------------------------

case "${1:-}" in
    run)
        [ $# -eq 3 ] || die "Usage: audit-tests.sh run <branch-name> <test-plan-file>"
        cmd_run "$2" "$3"
        ;;
    *)
        die "Usage: audit-tests.sh run <branch-name> <test-plan-file>"
        ;;
esac
