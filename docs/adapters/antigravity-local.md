---
title: Antigravity CLI
summary: Antigravity CLI (`agy`) local adapter setup and configuration
---

The `antigravity_local` adapter runs the Antigravity CLI (`agy`) locally. It provides first-class support for native Antigravity execution semantics, structured NDJSON streaming, session persistence with `--conversation`, and permission auto-approval for unattended operation.

## Prerequisites

- Antigravity CLI installed (`agy` command available in PATH)
- Antigravity authentication configured (`agy login` or `agy auth login`)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | No | Path or name of the Antigravity CLI binary. Defaults to `agy`. |
| `cwd` | string | Yes | Working directory for the agent process (absolute path). |
| `model` | string | No | Model for the CLI session. Defaults to `gemini-3.8-flash-high`. |
| `effort` | string | No | Reasoning effort level (`low`, `medium`, `high`) passed via `--effort`. |
| `agent` | string | No | Optional subagent or personality name passed via `--agent`. |
| `dangerouslySkipPermissions` | boolean | No | Auto-approve all tool permission requests with `--dangerously-skip-permissions` for unattended autonomous execution. Defaults to `true`. |
| `sandbox` | boolean | No | Pass `--sandbox` to run in a restricted terminal sandbox. Defaults to `false`. |
| `printTimeout` | string | No | Timeout duration for headless print mode passed via `--print-timeout` (e.g. `30m`). |
| `instructionsFilePath` | string | No | Absolute path to markdown instructions file (e.g. `AGENTS.md`) prepended to the prompt at runtime. |
| `extraArgs` | array/string | No | Extra CLI flags or arguments appended to the `agy` invocation. |
| `env` | object | No | Environment variables (supports secret references). |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout). |
| `graceSec` | number | No | Grace period in seconds before force-killing the process. |

## Execution Semantics

The adapter invokes `agy` in headless streaming mode:

```sh
agy --print "<prompt>" --output-format stream-json --dangerously-skip-permissions
```

Key differences from other adapters:
- **No Gemini flags**: Antigravity is an independent native agent CLI. The adapter does not inject `--approval-mode yolo`, `--sandbox=none`, or Gemini-specific options.
- **Headless streaming**: Outputs real-time NDJSON events (`init`, `step_update`, `result`, `error`) parsed directly into Paperclip's transcript format.
- **Permission bypass**: Uses `--dangerously-skip-permissions` to allow unattended execution in automated control planes.

## Session Persistence

The adapter tracks the Antigravity session ID (`conversation_id` emitted by `agy`). On subsequent runs in the same workspace, Paperclip supplies:

```sh
--conversation <conversation-id>
```

If a previous conversation cannot be resumed (e.g. deleted or invalid session), the adapter detects the warning, marks the session as unrecoverable, and automatically falls back to starting a fresh conversation.

## Environment Diagnostics

Use the "Test Environment" button in the UI to validate the adapter setup. It checks:

1. `agy` command is installed and executable
2. Target working directory is valid
3. A live test prompt execution succeeds:
   ```sh
   agy --print "Respond with hello." --output-format stream-json --dangerously-skip-permissions
   ```
