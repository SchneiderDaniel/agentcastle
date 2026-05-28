#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# setup-github-project.sh — Create a GitHub Project (v2) with custom statuses
# from .pi/settings.json supervisor.statusMapping.
#
# Usage:
#   ./scripts/setup-github-project.sh
#
# Prerequisites:
#   - gh (GitHub CLI) authenticated:  gh auth login
#   - jq
#   - Run from the repository root (where .pi/settings.json lives)
# ---------------------------------------------------------------------------
set -euo pipefail

# --- helpers ---------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${YELLOW}→${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
die()   { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# --- prerequisites ---------------------------------------------------------
command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) not found. Install: https://cli.github.com"
command -v jq >/dev/null 2>&1 || die "jq not found. Install: sudo apt-get install jq"

gh auth status >/dev/null 2>&1 || die "Not logged into GitHub. Run: gh auth login"

# Resolve project root (parent of the script's directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

SETTINGS="$PROJECT_ROOT/.pi/settings.json"
[ -f "$SETTINGS" ] || die "$SETTINGS not found. Is this an agentcastle project?"

# --- read settings ---------------------------------------------------------
REPO=$(jq -r '.supervisor.repo' "$SETTINGS")
OWNER="${REPO%/*}"

OLD_PROJECT_NUMBER=$(jq -r '.supervisor.projectNumber // "none"' "$SETTINGS")

# Gather status mapping keys (the status *names*, not the agent aliases)
STATUS_KEYS_ARR=()
while IFS= read -r key; do
    STATUS_KEYS_ARR+=("$key")
done < <(jq -r '.supervisor.statusMapping | keys_unsorted[]' "$SETTINGS")

[ ${#STATUS_KEYS_ARR[@]} -gt 0 ] || die "No statusMapping entries in $SETTINGS."

# --- user prompt -----------------------------------------------------------
echo ""
echo -e "${BOLD}GitHub Project Setup${NC}"
echo "  Owner          : $OWNER"
echo "  Current project: #$OLD_PROJECT_NUMBER"
echo "  Statuses       : Backlog → ${STATUS_KEYS_ARR[*]} → Done"
echo ""

read -r -p "Project name: " PROJECT_NAME
[ -n "$PROJECT_NAME" ] || die "Project name cannot be empty."

# --- get owner GraphQL node ID ---------------------------------------------
info "Looking up owner node ID for '$OWNER'..."

OWNER_TYPE=$(gh api "users/$OWNER" --jq '.type' 2>/dev/null || echo "User")
if [ "$OWNER_TYPE" = "Organization" ]; then
    OWNER_ID=$(gh api graphql -f query='
        query($login: String!) {
            organization(login: $login) { id }
        }
    ' -f login="$OWNER" -q '.data.organization.id')
else
    OWNER_ID=$(gh api graphql -f query='
        query($login: String!) {
            user(login: $login) { id }
        }
    ' -f login="$OWNER" -q '.data.user.id')
fi

[ -n "$OWNER_ID" ] || die "Could not resolve owner '$OWNER'."

# --- create the project ----------------------------------------------------
info "Creating project '$PROJECT_NAME'..."

RESPONSE=$(gh api graphql -f query='
    mutation($ownerId: ID!, $title: String!) {
        createProjectV2(input: {ownerId: $ownerId, title: $title}) {
            projectV2 {
                id
                number
                url
            }
        }
    }
' -f ownerId="$OWNER_ID" -f title="$PROJECT_NAME")

PROJECT_ID=$(echo "$RESPONSE"    | jq -r '.data.createProjectV2.projectV2.id')
PROJECT_NUMBER=$(echo "$RESPONSE" | jq -r '.data.createProjectV2.projectV2.number')
PROJECT_URL=$(echo "$RESPONSE"   | jq -r '.data.createProjectV2.projectV2.url')

[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] \
    || die "Failed to create project. Response: $RESPONSE"

ok "Project #$PROJECT_NUMBER created — $PROJECT_URL"

# --- build custom Workflow field ---------------------------------------------
# GitHub creates a system "Status" field (Todo/InProgress/Done) that cannot
# be deleted or renamed. We create a custom "Workflow" field with the user's
# statuses. The user sets their Board view to group by "Workflow" instead.
info "Adding custom Workflow field..."

# Build the singleSelectOptions GraphQL literal (inline in query, not as variable)
# Format: [{name: "X", color: COLOR}, ...]  — GraphQL enum colors, no quotes on colors
COLORS=("BLUE" "GREEN" "YELLOW" "ORANGE" "RED" "PINK" "PURPLE")

OPTIONS_GQL='[{name: "Backlog", color: GRAY, description: ""}'
COLOR_IDX=0
for key in "${STATUS_KEYS_ARR[@]}"; do
    OPTIONS_GQL+=", {name: \"$key\", color: ${COLORS[$COLOR_IDX]}, description: \"\"}"
    COLOR_IDX=$(( (COLOR_IDX + 1) % ${#COLORS[@]} ))
done
OPTIONS_GQL+=', {name: "Done", color: GREEN, description: ""}]'

# Create the field — options inlined directly in query to avoid complex variable types
FIELD_RESPONSE=$(gh api graphql -f query="
    mutation(\$projectId: ID!) {
        createProjectV2Field(input: {
            projectId: \$projectId,
            name: \"Workflow\",
            dataType: SINGLE_SELECT,
            singleSelectOptions: $OPTIONS_GQL
        }) {
            projectV2Field {
                ... on ProjectV2SingleSelectField {
                    id
                    name
                    options { id name }
                }
            }
        }
    }
" -f projectId="$PROJECT_ID")

STATUS_FIELD_ID=$(echo "$FIELD_RESPONSE" | jq -r '.data.createProjectV2Field.projectV2Field.id')
[ -n "$STATUS_FIELD_ID" ] && [ "$STATUS_FIELD_ID" != "null" ] \
    || die "Failed to create Workflow field. Response: $FIELD_RESPONSE"

ok "Workflow field ready — columns: Backlog, ${STATUS_KEYS_ARR[*]}, Done"

# --- update settings.json with new project number --------------------------
info "Updating .pi/settings.json → projectNumber: $PROJECT_NUMBER"

TMP=$(mktemp)
jq --argjson num "$PROJECT_NUMBER" '.supervisor.projectNumber = $num' "$SETTINGS" > "$TMP"
mv "$TMP" "$SETTINGS"

ok "Updated supervisor.projectNumber: $OLD_PROJECT_NUMBER → $PROJECT_NUMBER"

# --- done ------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}Done.${NC}  Project: ${BOLD}$PROJECT_URL${NC}"
echo ""
echo "  Workflow field:  Backlog  →  ${STATUS_KEYS_ARR[*]}  →  Done"
echo ""
echo "  Next steps — open the project in your browser:"
echo "  1. Switch to 'Board' layout"
echo "  2. Change 'Group by' from Status to Workflow"
echo "  3. Hide the default Status field if desired"
