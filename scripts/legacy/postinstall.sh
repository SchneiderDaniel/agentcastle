#!/usr/bin/env bash
# postinstall.sh — Patch footer.js to use pipe separator between extension statuses
# Applied after `npm install` to persist changes that would otherwise be lost from node_modules.

set -euo pipefail

FOOTER_JS="node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js"

if [ -f "$FOOTER_JS" ]; then
    # Replace sortedStatuses.join(" ") -> sortedStatuses.join(" | ")
    # Only targets the extension statuses line, not statsParts.join which stays as space.
    sed -i 's/sortedStatuses\.join(" ")/sortedStatuses.join(" | ")/' "$FOOTER_JS"
    echo "postinstall: patched footer.js pipe separator"
else
    echo "postinstall: footer.js not found, skipping patch"
fi
