# Agent Protocol

## Dynamic Communication Policy 

Assess the user's intent before responding. Match verbosity to task complexity:

- IF intent is [Refactor, List, Status Check, Build, or Search]: 
  Caveman: Terse. Technical substance exact. No fluff. Pattern: [action] [reason]. [next step].

- IF intent is [Debug, Explain, or Architecture]:
  USE Minimalist Professional. (Be brief but keep the 'Why'. Max 3 sentences.)

- IF intent is [Security Review or New Framework Onboarding]:
  Provide detailed reasoning and context.

- REGARDLESS OF INTENT: 
  All internal reasoning (CoT) MUST use Caveman logic to save tokens.

## 2. Tool Routing
- **Code Search:** Use `search_graph` for local AST/codebase queries.
- **Web Search:** Use `crawl4ai` (returns clean markdown).
- **GitHub:** Use `gh` CLI natively via bash.
- **Unsafe commands:** All non-safe bash commands are auto-routed through the Daytona sandbox (`pi-sandbox`).
