#!/usr/bin/env bash
# Developer workflow — deterministic git operations for the developer agent.
# Replaces LLM-interpreted markdown code blocks with explicit commands.
#
# Usage:
#   dev-workflow.sh derive-branch <issue-number> <issue-title>
#   dev-workflow.sh setup-worktree <issue-number> <issue-title>
#   dev-workflow.sh branch-submodules <branch-name>
#   dev-workflow.sh commit-push <issue-number> <issue-title>
#   dev-workflow.sh cleanup <original-dir>
#
# The LLM calls these commands instead of reading and interpreting shell code
# from the system prompt. Each command is deterministic and self-validating.

set -euo pipefail

# --- Helpers ----------------------------------------------------------------

die() { echo "ERROR: $*" >&2; exit 1; }

derive_branch_name() {
    local issue_number="$1"
    local issue_title="$2"

    # Lowercase, replace non-alphanumeric with hyphens, collapse hyphens, trim
    local slug
    slug=$(echo "$issue_title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g; s/--+/-/g')

    echo "worktree-git-issue-${issue_number}-${slug}"
}

# --- Commands ---------------------------------------------------------------

cmd_derive_branch() {
    local issue_number="$1"
    local issue_title="$2"
    derive_branch_name "$issue_number" "$issue_title"
}

cmd_setup_worktree() {
    local issue_number="$1"
    local issue_title="$2"
    local branch
    branch=$(derive_branch_name "$issue_number" "$issue_title")
    local worktree_path="../${branch}"

    if [ -d "$worktree_path" ]; then
        echo "Worktree already exists, reusing: $worktree_path"
        cd "$worktree_path"
        git checkout main
        git pull
        git submodule update --init --recursive
    else
        echo "Creating new worktree: $worktree_path"
        git worktree add "$worktree_path" main
        cd "$worktree_path"
        git submodule update --init --recursive
    fi

    echo "WORKTREE_PATH=$(pwd)"
    echo "BRANCH_NAME=${branch}"
}

cmd_branch_submodules() {
    local branch_name="$1"

    # Check if submodules exist
    local submodules
    submodules=$(git submodule status 2>/dev/null | awk '{print $2}') || true

    if [ -z "$submodules" ]; then
        echo "No submodules found, skipping."
        return 0
    fi

    echo "$submodules" | while read -r submodule; do
        [ -z "$submodule" ] && continue
        echo "Branching submodule: $submodule"
        (
            cd "$submodule"
            git checkout -b "$branch_name" 2>/dev/null || git checkout "$branch_name"
            git push -u origin "$branch_name"
        )
    done
}

cmd_commit_push() {
    local issue_number="$1"
    local issue_title="$2"
    local branch
    branch=$(derive_branch_name "$issue_number" "$issue_title")
    local commit_msg="feat(#${issue_number}): ${issue_title}"

    # Push submodule changes first
    local submodules
    submodules=$(git submodule status 2>/dev/null | awk '{print $2}') || true

    if [ -n "$submodules" ]; then
        echo "$submodules" | while read -r submodule; do
            [ -z "$submodule" ] && continue
            (
                cd "$submodule"
                if ! git diff --quiet || ! git diff --cached --quiet; then
                    echo "Committing submodule: $submodule"
                    git add -A
                    git commit -m "$commit_msg"
                    git push origin "$branch_name"
                fi
            )
        done
    fi

    # Push main repo (always)
    echo "Committing main repo..."
    git add -A
    git commit -m "$commit_msg"
    git push origin "$branch_name"
}

cmd_cleanup() {
    local original_dir="$1"
    cd "$original_dir"
    echo "Returned to: $(pwd)"
}

# --- Main -------------------------------------------------------------------

case "${1:-}" in
    derive-branch)
        [ $# -eq 3 ] || die "Usage: dev-workflow.sh derive-branch <N> <title>"
        cmd_derive_branch "$2" "$3"
        ;;
    setup-worktree)
        [ $# -eq 3 ] || die "Usage: dev-workflow.sh setup-worktree <N> <title>"
        cmd_setup_worktree "$2" "$3"
        ;;
    branch-submodules)
        [ $# -eq 2 ] || die "Usage: dev-workflow.sh branch-submodules <branch-name>"
        cmd_branch_submodules "$2"
        ;;
    commit-push)
        [ $# -eq 3 ] || die "Usage: dev-workflow.sh commit-push <N> <title>"
        cmd_commit_push "$2" "$3"
        ;;
    cleanup)
        [ $# -eq 2 ] || die "Usage: dev-workflow.sh cleanup <original-dir>"
        cmd_cleanup "$2"
        ;;
    *)
        die "Unknown command: ${1:-none}. Valid: derive-branch, setup-worktree, branch-submodules, commit-push, cleanup"
        ;;
esac
