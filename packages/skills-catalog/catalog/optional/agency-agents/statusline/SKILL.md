---
name: "statusline"
description: "Configure a custom status line in the CLI. Use when the user mentions status line, statusline, statusLine, CLI status bar, prompt footer customization, or wants to add session context above the prompt."
key: "paperclipai/optional/agency-agents/statusline"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "statusline"
defaultInstall: false
---
# CLI Status Line

The CLI supports a user-configurable status line rendered above the prompt. A command is spawned on each conversation update, receives a JSON payload on stdin describing the session, and its stdout is displayed as the status line. The spec is aligned with [Claude Code's status line](https://code.claude.com/docs/en/statusline).

## Configuration

Add a `statusLine` entry to `~/.cursor/cli-config.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.cursor/statusline.sh",
    "padding": 2
  }
}
```

The `command` field supports full paths, `~` expansion, and shell-style argument splitting. You can point it at a script file or use an inline command like `jq -r '...'`.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | yes | — | Must be `"command"` |
| `command` | yes | — | Path to an executable or inline command. `~` is expanded. |
| `padding` | no | `0` | Horizontal inset (in characters) for the status line container. |
| `updateIntervalMs` | no | `300` | Minimum interval between invocations. Clamped to >= 300ms. |
| `timeoutMs` | no | `2000` | Maximum time the command may run before it is killed. |

## Stdin payload

The command receives a JSON object on stdin. The TypeScript interface is `StatusLinePayload` in `packages/agent-cli/src/hooks/use-status-line.ts`.

### Full JSON schema

```json
{
  "session_id": "abc123",
  "session_name": "my session",
  "transcript_path": "/path/to/transcript.jsonl",
  "render_width_chars": 120,
  "cwd": "/Users/me/project",
  "autorun": false,
  "model": {
    "id": "claude-4-opus",
    "display_name": "Claude 4 Opus",
    "param_summary": "(Thinking)",
    "max_mode": true
  },
  "workspace": {
    "current_dir": "/Users/me/project",
    "project_dir": "/Users/me/project/.cursor/transcripts",
    "added_dirs": []
  },
  "version": "1.2.3",
  "output_style": {
    "name": "default"
  },
  "context_window": {
    "total_input_tokens": 15234,
    "total_output_tokens": null,
    "context_window_size": 200000,
    "used_percentage": 34.5,
    "remaining_percentage": 65.5,
    "current_usage": null
  },
  "vim": {
    "mode": "NORMAL"
  },
  "worktree": {
    "name": "my-feature",
    "path": "/Users/me/.cursor/worktrees/repo/my-feature"
  }
}
```

### Available fields

| Field | Description |
|-------|-------------|
| `session_id` | Unique session identifier |
| `session_name` | Custom session name. Absent if no name has been set |
| `transcript_path` | Path to conversation transcript file |
| `render_width_chars` | Usable terminal columns minus built-in padding |
| `cwd`, `workspace.current_dir` | Current working directory (both contain the same value) |
| `autorun` | `true` when auto-run is enabled for the current session |
| `workspace.project_dir` | Directory where transcripts are stored |
| `workspace.added_dirs` | Additional directories (empty array for now) |
| `model.id`, `model.display_name` | Current model identifier and display name |
| `model.param_summary` | Formatted parameter summary (e.g. "(Thinking)", "High"). Absent when empty |
| `model.max_mode` | `true` when max mode is enabled. Absent otherwise |
| `version` | CLI version string |
| `output_style.name` | `"default"` or `"compact"` |
| `context_window.total_input_tokens` | Estimated input tokens (derived from used_percentage) |
| `context_window.total_output_tokens` | Cumulative output tokens (null when not tracked) |
| `context_window.context_window_size` | Maximum context window size in tokens |
| `context_window.used_percentage` | Percentage of context window used |
| `context_window.remaining_percentage` | Percentage of context window remaining |
| `context_window.current_usage` | Token counts from the last API call (null before first call) |
| `vim.mode` | `"NORMAL"` or `"INSERT"` when vim mode is enabled |
| `worktree.name` | Worktree name when running inside a worktree |
| `worktree.path` | Absolute path to the worktree directory |

### Fields that may be absent

- `session_name` — only present when a custom name has been set
- `model.param_summary` — only present when model has non-default parameters
- `model.max_mode` — only present when max mode is enabled
- `vim` — only present when vim mode is enabled
- `worktree` — only present when running in a worktree

### Fields that may be null

- `context_window.current_usage` — null before the first API call
- `context_window.used_percentage`, `context_window.remaining_percentage` — may be null early in the session

## Stdout / rendering

- **Multiple lines** are supported: each line of stdout renders as a separate row in the status area.
- **ANSI color codes** are supported (use chalk, tput, `\033[32m`, etc.).
- If the command exits non-zero with empty stdout, the status line is not updated (previous text is kept).
- If the command times out or a new update arrives while the script is running, the in-flight process is killed.
- The status line runs locally and does not consume API tokens.

## Examples

### Basic: model + context usage

```bash
#!/usr/bin/env bash
payload=$(cat)
model=$(echo "$payload" | jq -r '.model.display_name')
pct=$(echo "$payload" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
printf "\033[90m%s  ctx %s%%\033[0m" "$model" "$pct"
```

### Context progress bar

```bash
#!/usr/bin/env bash
input=$(cat)
MODEL=$(echo "$input" | jq -r '.model.display_name')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)

BAR_WIDTH=10
FILLED=$((PCT * BAR_WIDTH / 100))
EMPTY=$((BAR_WIDTH - FILLED))
BAR=""
[ "$FILLED" -gt 0 ] && printf -v FILL "%${FILLED}s" && BAR="${FILL// /▓}"
[ "$EMPTY" -gt 0 ] && printf -v PAD "%${EMPTY}s" && BAR="${BAR}${PAD// /░}"

echo "[$MODEL] $BAR $PCT%"
```

### Multi-line with git info

```bash
#!/usr/bin/env bash
input=$(cat)
MODEL=$(echo "$input" | jq -r '.model.display_name')
DIR=$(echo "$input" | jq -r '.workspace.current_dir')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)

BRANCH=""
git rev-parse --git-dir > /dev/null 2>&1 && BRANCH=" | 🌿 $(git branch --show-current 2>/dev/null)"

echo -e "\033[36m[$MODEL]\033[0m 📁 ${DIR##*/}$BRANCH"
echo -e "ctx $PCT%"
```

### Inline jq command (no script file)

```json
{
  "statusLine": {
    "type": "command",
    "command": "jq -r '\"[\\(.model.display_name)] \\(.context_window.used_percentage // 0)% context\"'"
  }
}
```

## Testing

Test a script with mock input:

```bash
echo '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":25}}' | ./statusline.sh
```

The command is spawned with `child_process.spawn` (no shell on Unix, `shell: true` on Windows for .cmd/.bat compatibility). Updates are debounced at the configured interval. If a new update triggers while a script is running, the in-flight process is killed via `AbortController` and the new invocation starts immediately.
