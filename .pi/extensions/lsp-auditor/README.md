# @agentcastle/lsp-auditor

**Catch code quality issues before they reach review.** Runs Language Server Protocol (LSP) diagnostics on files changed since your default branch — errors, warnings, and hints — as an automated pre-commit audit step.

## Features

- **`/lsp-auditor` command** — Manually trigger LSP diagnostics on modified files
- **Supervisor integration** — Called automatically by the supervisor extension during the Audit stage
- **Multi-language support** — TypeScript, JavaScript, TSX, JSX, Python, Rust, Go, and more via configurable server mappings
- **Per-server severity thresholds** — Filter diagnostics by severity per language server (e.g., errors only for strict checks)
- **Retry logic** — Up to 3 retry attempts per audit, backed by session-stored retry counters
- **File grouping** — Groups files by matching LSP server (e.g., all `.ts` files go to `typescript-language-server`)
- **Structured diagnostics output** — Returns `file`, `line`, `column`, `severity`, and `message` for every finding
- **Git-aware** — Only audits files modified since the default branch

## How it works

1. The audit is triggered — either manually via `/lsp-auditor` or automatically by the supervisor extension
2. The extension runs `git diff <defaultBranch> --name-only` to find changed files
3. Files are grouped by matching LSP server mapping (file extension → LSP command)
4. For each group, the extension spawns the LSP server, opens every file via `didOpen`, and collects `publishDiagnostics` notifications
5. Diagnostics are filtered by per-server severity threshold and merged into a single report
6. Results include all errors/warnings with file paths, line numbers, and messages
7. If diagnostics exceed severity thresholds, the audit can block progression to the next stage

## Install

```bash
pi install npm:@agentcastle/lsp-auditor
```

Then run `/reload` or restart pi.

## Usage

### Manual trigger

```
/lsp-auditor
```

### Supervisor integration

The supervisor extension calls `runPreAudit()` automatically during the Audit stage. No additional configuration needed.

### Configuration (optional)

In `.pi/settings.json`:

```json
{
  "lspAuditor": {
    "servers": [
      {
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "severityThreshold": "warning"
      }
    ]
  }
}
```

Default server mappings:
| Extension | LSP Command |
|-----------|-------------|
| `.ts`, `.tsx`, `.js`, `.jsx` | `typescript-language-server --stdio` |
| `.py` | `pylsp` |
| `.rs` | `rust-analyzer` |
| `.go` | `gopls` |

Override `severityThreshold` per server: `"error"`, `"warning"`, or `"info"` (default: `"info"`).

## Requirements

- Pi Coding Agent
- LSP servers installed on PATH for the languages you audit (e.g., `typescript-language-server`, `pylsp`, `rust-analyzer`, `gopls`)
- `vscode-jsonrpc` (npm dependency, installed automatically)
- Git repository with a default branch

## License

MIT
