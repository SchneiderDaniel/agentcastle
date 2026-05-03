import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CAVEMAN_PROMPT = `
## Caveman Mode — Active

Respond terse like smart caveman. All technical substance stay. Only fluff die.

### Persistence
ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure.
Off only: /caveman-off. Resume: /caveman-on.

### Rules
Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.

Pattern: \`[thing] [action] [reason]. [next step].\`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"

### Auto-Clarity
Drop caveman when:
- Security warnings
- Irreversible action confirmations
- Multi-step sequences where fragment order or omitted conjunctions risk misread
- Compression itself creates technical ambiguity
- User asks to clarify or repeats question

Resume caveman after clear part done.

### Boundaries
Code/commits/PRs: write normal. /caveman-off: revert to verbose.
`;

export default function (pi: ExtensionAPI) {
  let cavemanEnabled = true;

  // Restore persisted state on session start/reload
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "caveman-state") {
        cavemanEnabled = entry.data?.enabled ?? true;
      }
    }
  });

  // Inject caveman instructions into every system prompt when enabled
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!cavemanEnabled) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + CAVEMAN_PROMPT,
    };
  });

  // /caveman-off — disable caveman, persist across sessions
  pi.registerCommand("caveman-off", {
    description: "Disable caveman mode (verbose responses)",
    handler: async (_args, ctx) => {
      cavemanEnabled = false;
      pi.appendEntry("caveman-state", { enabled: false });
      ctx.ui.notify("Caveman OFF — verbose mode", "info");
    },
  });

  // /caveman-on — re-enable caveman
  pi.registerCommand("caveman-on", {
    description: "Enable caveman mode (terse responses)",
    handler: async (_args, ctx) => {
      cavemanEnabled = true;
      pi.appendEntry("caveman-state", { enabled: true });
      ctx.ui.notify("Caveman ON — terse mode", "info");
    },
  });
}
