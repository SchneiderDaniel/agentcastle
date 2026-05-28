#!/usr/bin/env bash
#
# dev-workflow.sh — Git worktree lifecycle management for developer agent
#
# Usage:
#   bash .pi/scripts/dev-workflow.sh derive-branch <N> "<title>"
#   bash .pi/scripts/dev-workflow.sh setup-worktree <N> "<title>"
#   bash .pi/scripts/dev-workflow.sh branch-submodules <branch-name>
#   bash .pi/scripts/dev-workflow.sh commit-push <N> "<title>"
#   bash .pi/scripts/dev-workflow.sh cleanup <original-repo-path>
#
# Each subcommand is an independent function. Exit codes:
#   0 = success
#   non-zero = failure (error message on stderr)
#
set -euo pipefail

# ─── Constants ─────────────────────────────────────────────────────

WORKTREE_PREFIX="worktree-git-issue"

# ─── Helpers ───────────────────────────────────────────────────────

usage() {
	cat <<'EOF'
Usage: dev-workflow.sh <subcommand> [args...]

Subcommands:
  derive-branch <N> "<title>"           Generate branch name from issue number + title
  setup-worktree <N> "<title>"          Create/reuse git worktree from default branch
  branch-submodules <branch-name>       Create matching branches in submodules
  commit-push <N> "<title>"             Commit and push changes (submodules first)
  cleanup <original-repo-path>          Remove worktree and local branch
EOF
	exit 1
}

die() {
	echo "Error: $*" >&2
	exit 1
}

# Slugify a string: lowercase, strip non-alphanum (except hyphens),
# collapse hyphens, trim leading/trailing hyphens, truncate to 50 chars.
slugify() {
	local s
	s="$1"
	# lowercase
	s="${s,,}"
	# replace non-alphanumeric (except hyphens) with hyphens
	s="${s//[^a-z0-9-]/-}"
	# collapse multiple hyphens
	while [[ "$s" == *--* ]]; do
		s="${s//--/-}"
	done
	# strip leading/trailing hyphens
	s="${s#-}"
	s="${s%-}"
	# truncate to 50 chars
	echo "${s:0:50}"
}

# Get default branch name by checking origin HEAD, then local HEAD
get_default_branch() {
	local branch
	branch=$(git remote show origin 2>/dev/null | grep "HEAD branch" | sed 's/.*: //')
	if [[ -z "$branch" ]]; then
		# Fallback: try common names
		for b in main master; do
			if git show-ref --verify "refs/heads/$b" &>/dev/null; then
				branch="$b"
				break
			fi
		done
	fi
	if [[ -z "$branch" ]]; then
		die "Could not determine default branch (no remote or local main/master found)"
	fi
	echo "$branch"
}

# ─── Subcommand: derive-branch ─────────────────────────────────────

cmd_derive_branch() {
	if [[ $# -lt 2 ]]; then
		die "Usage: dev-workflow.sh derive-branch <N> \"<title>\""
	fi
	local n title slug
	n="$1"
	shift
	title="$*"
	slug=$(slugify "$title")
	echo "${WORKTREE_PREFIX}-${n}-${slug}"
}

# ─── Subcommand: setup-worktree ────────────────────────────────────

cmd_setup_worktree() {
	if [[ $# -lt 2 ]]; then
		die "Usage: dev-workflow.sh setup-worktree <N> \"<title>\""
	fi
	local n title branch worktree_path default_branch
	n="$1"
	shift
	title="$*"
	branch=$("$0" derive-branch "$n" "$title")
	worktree_path="../${branch}"

	# Check that we're in a git repo with commits
	if ! git rev-parse --git-dir &>/dev/null; then
		die "Not in a git repository"
	fi
	if ! git rev-parse --verify HEAD &>/dev/null 2>&1; then
		die "No commits in repository — cannot create worktree"
	fi

	default_branch=$(get_default_branch)

	# Check if worktree already exists at path
	if [[ -d "$worktree_path" ]]; then
		# Verify it's a valid git worktree for our branch
		if git worktree list 2>/dev/null | grep -q "${worktree_path}"; then
			# Already exists — idempotent, just output
			echo "WORKTREE_PATH=${worktree_path}"
			echo "BRANCH_NAME=${branch}"
			return 0
		fi
		# Path exists but is not a worktree for this branch — error
		die "Path ${worktree_path} already exists but is not a git worktree for branch ${branch}"
	fi

	# Create worktree from default branch
	if ! git worktree add -b "$branch" "$worktree_path" "$default_branch" 2>/dev/null; then
		# If branch already exists, try adding worktree with existing branch
		if git show-ref --verify "refs/heads/${branch}" &>/dev/null; then
			git worktree add "$worktree_path" "$branch" 2>/dev/null || \
				die "Failed to create worktree at ${worktree_path} with existing branch ${branch}"
		else
			die "Failed to create worktree at ${worktree_path} from ${default_branch}"
		fi
	fi

	# Idempotent check: only one worktree per branch
	# If somehow we created a duplicate, prune it
	git worktree prune 2>/dev/null || true

	echo "WORKTREE_PATH=${worktree_path}"
	echo "BRANCH_NAME=${branch}"
}

# ─── Subcommand: branch-submodules ─────────────────────────────────

cmd_branch_submodules() {
	if [[ $# -lt 1 ]]; then
		die "Usage: dev-workflow.sh branch-submodules <branch-name>"
	fi
	local branch
	branch="$1"

	# Check if .gitmodules exists
	if [[ ! -f ".gitmodules" ]]; then
		# No submodules — no-op
		return 0
	fi

	# Parse .gitmodules to get submodule paths and URLs
	# Format: [submodule "name"] path = <path> url = <url>
	local current_name="" current_path="" current_url=""
	local submodules=()

	while IFS= read -r line; do
		# Trim whitespace
		line="${line#"${line%%[![:space:]]*}"}"
		line="${line%"${line##*[![:space:]]}"}"

		if [[ "$line" =~ ^\[submodule\ \"(.+)\"\]$ ]]; then
			# Save previous submodule if we have one
			if [[ -n "$current_name" && -n "$current_path" ]]; then
				submodules+=("$current_path")
			fi
			current_name="${BASH_REMATCH[1]}"
			current_path=""
			current_url=""
		elif [[ "$line" =~ ^path\ =\ (.+)$ ]]; then
			current_path="${BASH_REMATCH[1]}"
		elif [[ "$line" =~ ^url\ =\ (.+)$ ]]; then
			current_url="${BASH_REMATCH[1]}"
		fi
	done < ".gitmodules"

	# Save last submodule
	if [[ -n "$current_name" && -n "$current_path" ]]; then
		submodules+=("$current_path")
	fi

	if [[ ${#submodules[@]} -eq 0 ]]; then
		return 0
	fi

	# For each submodule, try to create and push matching branch
	for sm_path in "${submodules[@]}"; do
		if [[ ! -d "$sm_path" || ! -d "$sm_path/.git" ]]; then
			echo "Warning: submodule ${sm_path} not initialized, skipping" >&2
			continue
		fi

		(
			cd "$sm_path" || die "Failed to cd into submodule ${sm_path}"

			# Check if branch already exists locally
			if git show-ref --verify "refs/heads/${branch}" &>/dev/null; then
				# Branch exists locally — just push
				git push origin "$branch" 2>/dev/null || \
					die "Failed to push branch ${branch} in submodule ${sm_path}"
			else
				# Create branch from current HEAD
				if ! git checkout -b "$branch" 2>/dev/null; then
					# Try checking out existing remote branch
					if git fetch origin "$branch" 2>/dev/null; then
						git checkout "$branch" 2>/dev/null || \
							die "Failed to checkout branch ${branch} in submodule ${sm_path}"
					else
						die "Branch ${branch} does not exist locally or remotely in submodule ${sm_path}"
					fi
				fi
				git push origin "$branch" 2>/dev/null || \
					die "Failed to push branch ${branch} in submodule ${sm_path}"
			fi
		) || exit $?
	done
}

# ─── Subcommand: commit-push ───────────────────────────────────────

cmd_commit_push() {
	if [[ $# -lt 2 ]]; then
		die "Usage: dev-workflow.sh commit-push <N> \"<title>\""
	fi
	local n title commit_msg
	n="$1"
	shift
	title="$*"
	commit_msg="feat(#${n}): ${title}"

	# 1. Commit and push submodule changes first
	if [[ -f ".gitmodules" ]]; then
		local current_name="" current_path=""
		while IFS= read -r line; do
			line="${line#"${line%%[![:space:]]*}"}"
			line="${line%"${line##*[![:space:]]}"}"
			if [[ "$line" =~ ^\[submodule\ \"(.+)\"\]$ ]]; then
				if [[ -n "$current_name" && -n "$current_path" ]]; then
					(
						cd "$current_path" || die "Failed to cd into submodule ${current_path}"
						if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
							git add -A 2>/dev/null || die "Failed to git add in submodule ${current_path}"
							git commit -m "$commit_msg" 2>/dev/null || echo "  (no changes to commit in submodule ${current_path})" >&2
							git push origin HEAD 2>/dev/null || die "Failed to push submodule ${current_path}"
						else
							echo "  (no changes in submodule ${current_path})" >&2
						fi
					) || exit $?
				fi
				current_name="${BASH_REMATCH[1]}"
				current_path=""
			elif [[ "$line" =~ ^path\ =\ (.+)$ ]]; then
				current_path="${BASH_REMATCH[1]}"
			fi
		done < ".gitmodules"
		# Save last submodule
		if [[ -n "$current_name" && -n "$current_path" ]]; then
			(
				cd "$current_path" || die "Failed to cd into submodule ${current_path}"
				if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
					git add -A 2>/dev/null || die "Failed to git add in submodule ${current_path}"
					git commit -m "$commit_msg" 2>/dev/null || echo "  (no changes to commit in submodule ${current_path})" >&2
					git push origin HEAD 2>/dev/null || die "Failed to push submodule ${current_path}"
				else
					echo "  (no changes in submodule ${current_path})" >&2
				fi
			) || exit $?
		fi
	fi

	# 2. Commit and push main repo (includes submodule pointer updates)
	if git diff --quiet HEAD 2>/dev/null && git diff --cached --quiet HEAD 2>/dev/null; then
		echo "  (no changes to commit in main repo)" >&2
	else
		git add -A 2>/dev/null || die "Failed to git add in main repo"
		git commit -m "$commit_msg" 2>/dev/null || {
			echo "  (nothing to commit in main repo)" >&2
			# If nothing to commit, still try push in case there are unpushed commits
		}
		git push origin HEAD 2>/dev/null || die "Failed to push main repo"
	fi
}

# ─── Subcommand: cleanup ───────────────────────────────────────────

cmd_cleanup() {
	if [[ $# -lt 1 ]]; then
		die "Usage: dev-workflow.sh cleanup <original-repo-path>"
	fi
	local original_repo branch
	original_repo="$1"

	# Get current branch name if we're in a worktree
	branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

	# Check if we're inside a worktree-git-issue-* directory
	local current_dir
	current_dir=$(pwd)
	local dir_basename
	dir_basename=$(basename "$current_dir")

	if [[ "$dir_basename" != ${WORKTREE_PREFIX}-* ]]; then
		# Not inside a worktree — no-op
		return 0
	fi

	# cd back to original repo
	if [[ -n "$original_repo" ]]; then
		cd "$original_repo" 2>/dev/null || die "Cannot cd to original repo: ${original_repo}"
	fi

	local worktree_path="../${dir_basename}"

	# Remove worktree
	if git worktree list 2>/dev/null | grep -q "${worktree_path}"; then
		git worktree remove "$worktree_path" 2>/dev/null || {
			# Force remove if dirty
			git worktree remove --force "$worktree_path" 2>/dev/null || \
				die "Failed to remove worktree at ${worktree_path}"
		}
	fi

	# Prune stale worktree references
	git worktree prune 2>/dev/null || true

	# Delete local branch if it exists and is not the current branch
	if [[ -n "$branch" && "$branch" != "main" && "$branch" != "master" ]]; then
		if git show-ref --verify "refs/heads/${branch}" &>/dev/null; then
			# Don't delete if it's the current branch
			local current_branch
			current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
			if [[ "$current_branch" != "$branch" ]]; then
				git branch -D "$branch" 2>/dev/null || true
			fi
		fi
	fi
}

# ─── Main dispatch ─────────────────────────────────────────────────

main() {
	if [[ $# -lt 1 ]]; then
		usage
	fi

	local subcommand="$1"
	shift

	case "$subcommand" in
		derive-branch)
			cmd_derive_branch "$@"
			;;
		setup-worktree)
			cmd_setup_worktree "$@"
			;;
		branch-submodules)
			cmd_branch_submodules "$@"
			;;
		commit-push)
			cmd_commit_push "$@"
			;;
		cleanup)
			cmd_cleanup "$@"
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
