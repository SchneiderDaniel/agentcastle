# @agentcastle/ask-user

**Ask the user instead of guessing.** When the LLM needs a decision, preference, or clarification, it calls `ask_user` — and you respond through a structured dialog. No more hallucinated defaults.

## Features

- **`ask_user` tool** — Three dialog modes:
  - `choice` — Pick from predefined options (with recommendation marker)
  - `freetext` — Open-ended input
  - `multi-select` — Pick zero or more from a list
- **`ask_user_read` tool** — LLM retrieves past Q&A entries (by id, list, or text search)
- **`/qna` command** — Browse logged Q&A history in the TUI
- **Persistent log** — All interactions saved to `.pi/context/qna.jsonl` (auto-migrates from legacy `.csv`)

## How it works

1. The LLM needs to make a decision (e.g. "which framework?" or "confirm destructive action")
2. It calls `ask_user` with typed options or open prompt
3. You see a scrollable dialog with the question and select/confirm/input UI
4. Your answer is logged to `.pi/context/qna.jsonl` with timestamp
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

- Pi Coding Agent
- No external dependencies — all peer deps are pi-provided.

## License

MIT
