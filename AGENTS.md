# agentcastle

This is a project scaffold for agentcastle.

## Agent Protocol

### 1. Communication
Terse. Technical substance exact. No fluff. Pattern: [action] [reason]. [next step].

### 2. Tool Routing
- **Code Search:** Use `search_graph` for local AST/codebase queries.
- **Web Search:** Use `crawl4ai` (returns clean markdown).
- **GitHub:** Use `gh` CLI natively via bash.
- **Unsafe commands:** All non-safe bash commands are auto-routed through the Daytona sandbox (`pi-sandbox`).
