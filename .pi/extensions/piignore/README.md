# @agentcastle/piignore

**Stop the AI from touching your sensitive files.** Define `.piignore` patterns (gitignore format) in your project root — piignore intercepts `read`, `write`, `edit`, `bash`, and other tools and blocks any operation targeting matching paths.

## Features

- **Tool interception** — Blocks `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` when a path matches `.piignore` patterns
- **`.piignore` file format** — Same syntax as `.gitignore` (supports `*`, `**`, `?`, `!` negation, directory-only `/` suffix)
- **Hierarchical loading** — Walks up from project root to filesystem root, merging all `.piignore` files
- **Bash path detection** — Tokenizes bash commands and checks file-like arguments against ignore patterns (skips URLs, package names, echo/printf strings)
- **Pattern reload** — Re-reads `.piignore` on `/reload` via `resources_discover` event
- **TUI notifications** — Shows a warning toast when a path is blocked
- **Zero dependencies** — Pure Node.js built-ins, no npm deps

## How it works

1. Place a `.piignore` file in your project root with gitignore-style patterns
2. On session start and reload, piignore loads all `.piignore` files walking up the directory tree
3. Before every `read`, `write`, `edit`, `grep`, `find`, `ls`, or `bash` tool call executes, piignore checks the target path(s) against loaded patterns
4. If a path matches, the tool call is blocked with a `block: true` response and a reason message
5. The user sees a warning notification in the TUI

## Install

```bash
pi install npm:@agentcastle/piignore
```

Then run `/reload` or restart pi.

## Usage

### Create `.piignore` in project root

```gitignore
# Standard patterns (gitignore format)
.env
.env.*
secrets/
**/*.pem
config/credentials.*

# Negation: allow specific file even if parent is ignored
!config/credentials.example.json

# Directory-only: ignore all files inside node_modules/
node_modules/
```

### What happens

```
read(.env)           → Blocked: Path ".env" matches .piignore patterns
write(secrets/key)   → Blocked: Path "secrets/key" matches .piignore patterns
bash(cat .env)       → Blocked: Path ".env" matches .piignore patterns
bash(npm install)    → Allowed (npm packages are not file paths)
bash(echo "hello")   → Allowed (echo args treated as literals)
```

### Safe operations

- URLs (`https://...`, `s3://...`) are never treated as paths
- npm scoped packages (`@scope/package`) are excluded
- Shell operators (`|`, `;`, `&&`) are not checked
- Echo/printf arguments are treated as string literals

## Requirements

- Pi Coding Agent
- No external dependencies — pure Node.js built-ins
- Optional: a `.piignore` file in your project root

## License

MIT
