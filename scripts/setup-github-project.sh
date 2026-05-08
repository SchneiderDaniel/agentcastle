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
    mutation($input: CreateProjectV2Input!) {
        createProjectV2(input: $input) {
            projectV2 {
                id
                number
                url
            }
        }
    }
' -f input="{\"ownerId\":\"$OWNER_ID\",\"title\":\"$PROJECT_NAME\"}")

PROJECT_ID=$(echo "$RESPONSE"    | jq -r '.data.createProjectV2.projectV2.id')
PROJECT_NUMBER=$(echo "$RESPONSE" | jq -r '.data.createProjectV2.projectV2.number')
PROJECT_URL=$(echo "$RESPONSE"   | jq -r '.data.createProjectV2.projectV2.url')

[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] \
    || die "Failed to create project. Response: $RESPONSE"

ok "Project #$PROJECT_NUMBER created — $PROJECT_URL"

# --- build Status field with custom options --------------------------------
info "Adding Status field with custom options..."

# Build the singleSelectOptions JSON array
# Start with Backlog (gray), then each statusMapping key (cycling colors), end with Done (green)
COLORS=("BLUE" "GREEN" "YELLOW" "ORANGE" "RED" "PINK" "PURPLE")

OPTIONS_JSON='[{"name":"Backlog","color":"GRAY"}'
COLOR_IDX=0
for key in "${STATUS_KEYS_ARR[@]}"; do
    OPTIONS_JSON+=",{\"name\":\"$key\",\"color\":\"${COLORS[$COLOR_IDX]}\"}"
    COLOR_IDX=$(( (COLOR_IDX + 1) % ${#COLORS[@]} ))
done
OPTIONS_JSON+=',{"name":"Done","color":"GREEN"}]'

# Create the field via GraphQL
FIELD_RESPONSE=$(gh api graphql --raw-field query='
    mutation($input: CreateProjectV2FieldInput!) {
        createProjectV2Field(input: $input) {
            projectV2Field {
                ... on ProjectV2SingleSelectField {
                    id
                    name
                    options { id name }
                }
            }
        }
    }
' -f input="{\"projectId\":\"$PROJECT_ID\",\"name\":\"Status\",\"dataType\":\"SINGLE_SELECT\",\"singleSelectOptions\":$OPTIONS_JSON}")

STATUS_FIELD_ID=$(echo "$FIELD_RESPONSE" | jq -r '.data.createProjectV2Field.projectV2Field.id')
[ -n "$STATUS_FIELD_ID" ] && [ "$STATUS_FIELD_ID" != "null" ] \
    || die "Failed to create Status field. Response: $FIELD_RESPONSE"

ok "Status field ready — columns: Backlog, ${STATUS_KEYS_ARR[*]}, Done"

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
echo "  Status field:  Backlog  →  ${STATUS_KEYS_ARR[*]}  →  Done"
echo ""
echo "  Next step — open the project in your browser and switch to"
echo "  the 'Board' layout (group by 'Status') for a Kanban view."
