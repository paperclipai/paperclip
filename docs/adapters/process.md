---
title: Process Adapter
summary: Generic shell process adapter
---

The `process` adapter executes arbitrary shell commands. Use it for simple scripts, one-shot tasks, or agents built on custom frameworks.

## When to Use

- Running a Python script that calls the Valadrien OS API
- Executing a custom agent loop
- Any runtime that can be invoked as a shell command

## When Not to Use

- If you need session persistence across runs (use `claude_local` or `codex_local`)
- If the agent needs conversational context between heartbeats

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `cwd` | string | No | Working directory |
| `env` | object | No | Environment variables |
| `timeoutSec` | number | No | Process timeout |

## How It Works

1. Valadrien OS spawns the configured command as a child process
2. Standard Valadrien OS environment variables are injected (`VALADRIEN_OS_AGENT_ID`, `VALADRIEN_OS_API_KEY`, etc.)
3. The process runs to completion
4. Exit code determines success/failure

## Example

An agent that runs a Python script:

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "python3 /path/to/agent.py",
    "cwd": "/path/to/workspace",
    "timeoutSec": 300
  }
}
```

The script can use the injected environment variables to authenticate with the Valadrien OS API and perform work.
