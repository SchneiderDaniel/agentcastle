# @agentcastle/ask-user

**Ask the user instead of guessing.** When the LLM needs a decision, preference, or clarification, it calls `ask_user` — and you respond through a structured dialog. No more hallucinated defaults.

## Features

- **`ask_user` tool** — Two dialog modes:
  - `choice` — Pick from predefined options (with recommendation marker)
  - `freetext` — Open-ended input
- **Mode-aware dispatch** — Questions adapt to the current `ctx.mode`:
  - `tui` — Scrollable dialog with option highlighting (uses `ctx.ui.custom`)
  - `rpc` — Flat option list via `ctx.ui.select` (compatible with RPC clients)
  - `json` / `print` — Cancel non-essential questions gracefully (no interactive UI)
- **Trust-gated persistence** — Q&A history is only written when `ctx.isProjectTrusted()` is true. In untrusted contexts, answers are returned in tool content but never persisted to disk.
- **`ask_user_read` tool** — LLM retrieves past Q&A entries (by id, list, or text search). Returns empty with `untrusted: true` flag when project trust is not granted.
- **`/qna` command** — Browse logged Q&A history. Gated behind project trust.
- **Structured response format** — All tool responses include `format: "qna-result-v1"` in `details` for typed downstream consumption. Untrusted responses include `untrusted: true`.
- **Persistent log** — All interactions saved to `.pi/context/qna.jsonl` (legacy `.csv` auto-migrated at session start if project trust is granted).

## How it works

1. The LLM needs to make a decision (e.g. "which framework?" or "confirm destructive action")
2. It calls `ask_user` with typed options or open prompt
3. The question UI adapts to the current mode (TUI dialog, RPC select, or graceful cancel)
4. Your answer is returned in tool content; persistence depends on project trust
5. Future turns can retrieve past answers via `ask_user_read` or `/qna`

## Install

```bash
pi install npm:@agentcastle/ask-user
```

Then run `/reload` or restart pi.

## Usage

The LLM uses `ask_user` automatically when it needs input. You can also browse history:

```
/qna               List recent Q&A entries
/qna list 5        List last 5 entries
/qna get 3         Show entry #3 in detail
/qna query search  Find entries matching text
```

## Requirements

- Pi Coding Agent ≥ v0.79.1
- No external dependencies — all peer deps are pi-provided.

## License

MIT
