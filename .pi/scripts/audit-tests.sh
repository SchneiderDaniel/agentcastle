#!/usr/bin/env bash
#
# audit-tests.sh — Execute test plan commands from markdown in a worktree
#
# Usage:
#   bash .pi/scripts/audit-tests.sh run <branch-name> <test-plan-file> [--worktree-path <path>]
#
# Reads a markdown test plan, extracts fenced bash code blocks, executes
# each in the worktree directory with a 60s timeout, captures results,
# and outputs structured JSON.
#
set -euo pipefail

# ─── Constants ─────────────────────────────────────────────────────

TIMEOUT_SECONDS=60
OUTPUT_LINE_LIMIT=20

# ─── Helpers ───────────────────────────────────────────────────────

usage() {
	cat <<'EOF'
Usage: audit-tests.sh run <branch-name> <test-plan-file> [--worktree-path <path>]

Executes fenced bash code blocks from a test plan markdown file.

Arguments:
  branch-name       Branch name (worktree detected via git worktree list)
  test-plan-file    Path to markdown file containing fenced bash code blocks
  --worktree-path   Explicit worktree path (bypasses git worktree list detection)

Output JSON schema:
{
  "status": "passed" | "failed" | "no_commands" | "timeout",
  "message": "(optional rejection text)",
  "results": [
    {
      "block_index": 0,
      "command": "npm test",
      "exit_code": 0,
      "timed_out": false,
      "stdout": "(truncated)",
      "stderr": "(truncated)",
      "failed_tests": ["test name 1"],
      "passed": true
    }
  ]
}
EOF
	exit 1
}

die() {
	echo "Error: $*" >&2
	exit 1
}

# Escape a string for use in a JSON string value.
# Handles double quotes, backslashes, newlines, tabs, and control chars.
json_escape() {
	local s="$1"
	# Escape backslashes first
	s="${s//\\/\\\\}"
	# Escape double quotes
	s="${s//\"/\\\"}"
	# Escape newlines
	s="${s//$'\n'/\\n}"
	# Escape tabs
	s="${s//$'\t'/\\t}"
	# Escape carriage returns
	s="${s//$'\r'/\\r}"
	# Remove other control characters
	s=$(echo -n "$s" | tr -d '[\000-\010\016-\037\177]' 2>/dev/null || echo -n "$s")
	echo "$s"
}

# Check if jq is available
has_jq() {
	command -v jq &>/dev/null
}

# Build JSON output. Uses jq when available, falls back to printf-based JSON.
build_json() {
	local status="$1"
	local message="$2"
	shift 2
	# Remaining args: alternating block_index command exit_code timed_out stdout stderr failed_tests passed
	# Passed as a flat list

	if has_jq; then
		build_json_jq "$status" "$message" "$@"
	else
		build_json_printf "$status" "$message" "$@"
	fi
}

build_json_jq() {
	local status="$1"
	local message="$2"
	shift 2

	local results_json="[]"
	local first=true

	while [[ $# -gt 0 ]]; do
		local block_index="$1"
		local command="$2"
		local exit_code="$3"
		local timed_out="$4"
		local stdout="$5"
		local stderr="$6"
		local failed_tests_json="$7"
		local passed="$8"
		shift 8

		local result
		result=$(jq -n \
			--argjson bi "$block_index" \
			--arg cmd "$command" \
			--argjson ec "$exit_code" \
			--argjson to "$timed_out" \
			--arg so "$stdout" \
			--arg se "$stderr" \
			--argjson ft "$failed_tests_json" \
			--argjson p "$passed" \
			'{
				block_index: $bi,
				command: $cmd,
				exit_code: $ec,
				timed_out: $to,
				stdout: $so,
				stderr: $se,
				failed_tests: $ft,
				passed: $p
			}')

		if $first; then
			results_json="[$result]"
			first=false
		else
			results_json=$(echo "$results_json" | jq ". + [$result]")
		fi
	done

	jq -n \
		--arg s "$status" \
		--arg m "$message" \
		--argjson r "$results_json" \
		'{status: $s, message: $m, results: $r}'
}

build_json_printf() {
	local status="$1"
	local message="$2"
	shift 2

	local json='{'
	json+='"status":"'"$(json_escape "$status")"'",'
	json+='"message":"'"$(json_escape "$message")"'",'
	json+='"results":['

	local first=true
	while [[ $# -gt 0 ]]; do
		local block_index="$1"
		local command="$2"
		local exit_code="$3"
		local timed_out="$4"
		local stdout="$5"
		local stderr="$6"
		local failed_tests_json="$7"
		local passed="$8"
		shift 8

		if $first; then
			first=false
		else
			json+=','
		fi

		json+='{'
		json+='"block_index":'"$block_index"','
		json+='"command":"'"$(json_escape "$command")"'",'
		json+='"exit_code":'"$exit_code"','
		json+='"timed_out":'"$timed_out"','
		json+='"stdout":"'"$(json_escape "$stdout")"'",'
		json+='"stderr":"'"$(json_escape "$stderr")"'",'
		json+='"failed_tests":'"$failed_tests_json"','
		json+='"passed":'"$passed"
		json+='}'
	done

	json+=']}'
	echo "$json"
}

# Parse failure patterns from output
parse_failed_tests() {
	local output="$1"
	local -a failures=()

	# Pattern: ✗ some test name
	while IFS= read -r line; do
		if [[ "$line" =~ ^✗[[:space:]]+(.+) ]]; then
			failures+=("${BASH_REMATCH[1]}")
		elif [[ "$line" =~ ^FAIL[[:space:]:]*(.+) ]]; then
			failures+=("${BASH_REMATCH[1]}")
		elif [[ "$line" =~ ^not[[:space:]]+ok[[:space:]]+(.+) ]]; then
			failures+=("${BASH_REMATCH[1]}")
		fi
	done < <(echo "$output")

	# Build JSON array
	if [[ ${#failures[@]} -eq 0 ]]; then
		echo "[]"
	else
		local first=true
		local json="["
		for f in "${failures[@]}"; do
			if $first; then
				first=false
			else
				json+=","
			fi
			json+="\"$(json_escape "$f")\""
		done
		json+="]"
		echo "$json"
	fi
}

# Truncate output to line limit
truncate_output() {
	local output="$1"
	local limit="${2:-$OUTPUT_LINE_LIMIT}"
	local line_count
	line_count=$(echo "$output" | wc -l)
	if [[ "$line_count" -le "$limit" ]]; then
		echo "$output"
	else
		head -n "$limit" <<< "$output"
		echo "... (truncated ${line_count} lines to ${limit})"
	fi
}

# ─── Subcommand: run ───────────────────────────────────────────────

# Resolve worktree directory from branch name.
# Uses --worktree-path if provided, otherwise detects via git worktree list.
resolve_worktree_dir() {
	local branch_name="$1"
	local explicit_path="$2"

	if [[ -n "$explicit_path" ]]; then
		echo "$explicit_path"
		return 0
	fi

	# Detect worktree path from git worktree list --porcelain
	# Format:
	#   worktree /path/to/worktree
	#   branch refs/heads/branch-name
	#   ...
	local detected
	detected=$(git worktree list --porcelain 2>/dev/null | awk -v branch="$branch_name" '
		/^worktree / { wt = $2 }
		/^branch refs\/heads\// { b = $2; sub("^refs/heads/", "", b) }
		b == branch { print wt; exit }
	' || true)

	if [[ -z "$detected" ]]; then
		die "No worktree found for branch ${branch_name}. Use --worktree-path <path> to specify manually."
	fi

	echo "$detected"
}

cmd_run() {
	local explicit_worktree_path=""
	# Parse args: extract --worktree-path before positional
	local args=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--worktree-path)
				if [[ -z "${2:-}" ]]; then
					die "--worktree-path requires a path argument"
				fi
				explicit_worktree_path="$2"
				shift 2
				;;
			--worktree-path=*)
				explicit_worktree_path="${1#*=}"
				shift
				;;
			*)
				args+=("$1")
				shift
				;;
		esac
	done

	# Restore positional args: branch-name test-plan-file
	set -- "${args[@]}"

	if [[ $# -lt 2 ]]; then
		die "Usage: audit-tests.sh run <branch-name> <test-plan-file> [--worktree-path <path>]"
	fi

	local branch_name test_plan_file
	branch_name="$1"
	test_plan_file="$2"

	# Validate branch name
	if [[ -z "$branch_name" ]]; then
		die "Branch name cannot be empty"
	fi

	# Resolve worktree directory (explicit path or git worktree list detection)
	local worktree_dir
	worktree_dir=$(resolve_worktree_dir "$branch_name" "$explicit_worktree_path")

	# Check worktree directory exists
	if [[ ! -d "$worktree_dir" ]]; then
		die "Worktree directory ${worktree_dir} does not exist"
	fi

	# Check test plan file exists
	if [[ ! -f "$test_plan_file" ]]; then
		die "Test plan file ${test_plan_file} not found"
	fi

	# Read test plan file
	local test_plan
	test_plan=$(cat "$test_plan_file")

	# Extract fenced bash code blocks
	# Pattern: ```bash ... ``` (multiline, non-greedy)
	local -a code_blocks=()
	local in_block=false
	local current_block=""
	local block_started=false

	while IFS= read -r line; do
		if $in_block; then
			if [[ "$line" == '```' ]]; then
				# End of block
				if [[ -n "$current_block" ]]; then
					code_blocks+=("$current_block")
				fi
				current_block=""
				in_block=false
				block_started=false
			else
				if $block_started; then
					current_block+="${line}"$'\n'
				fi
			fi
		elif [[ "$line" =~ ^'```bash'[[:space:]]*$ ]] || [[ "$line" == '```bash' ]]; then
			in_block=true
			current_block=""
			block_started=true
		fi
	done <<< "$test_plan"

	# If no code blocks found, return no_commands
	if [[ ${#code_blocks[@]} -eq 0 ]]; then
		build_json "no_commands" "No runnable test commands found in test plan"
		return 0
	fi

	local -a result_args=()
	local any_failed=false
	local any_timeout=false

	for i in "${!code_blocks[@]}"; do
		local block="${code_blocks[$i]}"
		local tmpfile
		tmpfile=$(mktemp /tmp/audit-block-XXXXXX.sh)
		echo "$block" > "$tmpfile"
		chmod +x "$tmpfile"

		# Get first line of command for display
		local cmd_display
		cmd_display=$(head -1 <<< "$block" | head -c 200)

		# Execute in worktree directory with timeout
		local exit_code=0
		local timed_out=false
		local combined_output=""
		local stdout_out=""
		local stderr_out=""

		set +e
		# Use timeout command; capture both stdout and stderr separately
		local stdout_file
		stdout_file=$(mktemp /tmp/audit-stdout-XXXXXX)
		local stderr_file
		stderr_file=$(mktemp /tmp/audit-stderr-XXXXXX)

		(
			cd "$worktree_dir" 2>/dev/null || die "Cannot cd to worktree ${worktree_dir}"
			timeout "$TIMEOUT_SECONDS" bash "$tmpfile" >"$stdout_file" 2>"$stderr_file"
		)
		exit_code=$?

		# Check if timeout occurred
		if [[ $exit_code -eq 124 ]]; then
			timed_out=true
			any_timeout=true
		fi

		# Read captured output
		stdout_out=$(cat "$stdout_file" 2>/dev/null || echo "")
		stderr_out=$(cat "$stderr_file" 2>/dev/null || echo "")

		rm -f "$tmpfile" "$stdout_file" "$stderr_file"
		set -e

		# Truncate output
		stdout_out=$(truncate_output "$stdout_out" $OUTPUT_LINE_LIMIT)
		stderr_out=$(truncate_output "$stderr_out" $OUTPUT_LINE_LIMIT)

		# Combine for failure parsing
		combined_output="${stdout_out}"$'\n'"${stderr_out}"

		# Parse failed tests from combined output
		local failed_json
		failed_json=$(parse_failed_tests "$combined_output")

		# Determine pass/fail for this block
		local passed=false
		if [[ $exit_code -eq 0 ]] && ! $timed_out; then
			# Check if any test failures were detected
			if [[ "$failed_json" == "[]" ]]; then
				passed=true
			fi
		fi

		if ! $passed; then
			any_failed=true
		fi

		# Collect result args
		result_args+=("$i")
		result_args+=("$cmd_display")
		result_args+=("$exit_code")
		result_args+=("$timed_out")
		result_args+=("$stdout_out")
		result_args+=("$stderr_out")
		result_args+=("$failed_json")
		if $passed; then
			result_args+=("true")
		else
			result_args+=("false")
		fi
	done

	# Determine overall status
	local overall_status overall_message
	if $any_timeout; then
		overall_status="timeout"
		overall_message="One or more test commands timed out after ${TIMEOUT_SECONDS}s"
	elif $any_failed; then
		overall_status="failed"
		overall_message="One or more test commands failed"
	else
		overall_status="passed"
		overall_message="All tests passed"
	fi

	build_json "$overall_status" "$overall_message" "${result_args[@]}"
}

# ─── Main dispatch ─────────────────────────────────────────────────

main() {
	if [[ $# -lt 1 ]]; then
		usage
	fi

	local subcommand="$1"
	shift

	case "$subcommand" in
		run)
			cmd_run "$@"
			;;
		help|--help|-h)
			usage
			;;
		*)
			die "Unknown subcommand: ${subcommand}. Use 'help' for usage."
			;;
	esac
}

main "$@"
