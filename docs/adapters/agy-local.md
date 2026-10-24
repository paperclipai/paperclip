---
title: Antigravity CLI
summary: Antigravity (agy) CLI local adapter setup, configuration, and advanced features
---

The `agy_local` adapter runs Google's Antigravity (`agy`) CLI locally. It supports multi-turn session persistence with `--conversation`, multi-workspace directory context via `--add-dir`, reasoning effort, subagent personas, structured JSON schema enforcement, deterministic execution modes, and automatic brain artifact discovery.

## Prerequisites

- Antigravity CLI installed (`agy` command available on PATH)
- Antigravity authenticated (`agy` auth configured or `GEMINI_API_KEY` available)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; defaults to workspace directory) |
| `model` | string | No | Model ID to use (e.g. `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, `gemini-3.7-flash-high`, `claude-sonnet-4-6`). Defaults to `gemini-3.8-flash-high`. |
| `effort` | string | No | Reasoning effort passed via `--effort` (`low`, `medium`, `high`) |
| `mode` | string | No | Execution mode: `accept-edits` (full autonomous edit capability) or `plan` (non-mutating planning and research) |
| `project` | string | No | Antigravity project name or ID for conversation and memory grouping (`--project`) |
| `printTimeout` | string | No | CLI print mode wait timeout (e.g. `15m`, `30m`, `1h`). Defaults to aligned Paperclip `timeoutSec` or `24h` |
| `disableSlashCommands` | boolean | No | Disable slash command and skill expansion in print mode (`--disable-slash-commands`) |
| `agent` | string | No | Antigravity subagent persona name passed via `--agent <name>` |
| `jsonSchema` | string | No | JSON schema string or path to a schema file to enforce structured output (`--json-schema`) |
| `sandbox` | boolean | No | Run in sandbox mode with terminal restrictions enabled (`--sandbox`) |
| `dangerouslySkipPermissions` | boolean | No | Auto-approve tool calls without prompting (`--dangerously-skip-permissions`). Defaults to `false` |
| `workspaceStrategy` | object | No | Workspace strategy configuration, e.g. `{ type: "git_worktree", baseRef, branchTemplate, worktreeParentDir }` |
| `instructionsFilePath` | string | No | Absolute path to markdown instructions file (e.g. `AGENTS.md`) prepended to prompt |
| `promptTemplate` | string | No | Custom prompt template for agent runs |
| `addDirs` | string[] | No | Additional workspace directories injected via `--add-dir` |
| `command` | string | No | Executable command name or path (defaults to `agy`) |
| `extraArgs` | string[] | No | Additional CLI args passed to `agy` |
| `env` | object | No | Environment variables (supports plain and secret bindings) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | SIGTERM grace period before force-kill (defaults to 15) |

## Session Persistence & Continuity

The adapter persists Antigravity conversation IDs across heartbeats using `--conversation <id>`.
- **Target identity preservation**: Remote execution targets maintain session identity across host migrations.
- **Self-healing recovery**: If a session was deleted or pruned, the adapter automatically detects the missing session error and re-executes cleanly with a fresh session.

## Multi-Workspace Context

Paperclip automatically passes all relevant workspace directories using repeatable `--add-dir` flags:
1. The primary workspace directory (`cwd`)
2. Any secondary workspaces in multi-project companies (`paperclipWorkspaces`)
3. Any custom directories specified in `addDirs`

## Brain Artifacts Auto-Discovery

Antigravity writes deliverable artifacts (such as `implementation_plan.md`, `walkthrough.md`, diagrams, and scratch deliverables) to the session's brain directory (`~/.gemini/antigravity/brain/<sessionId>`). At the end of each run, the adapter discovers these artifacts, logs them to the Paperclip run log, and includes them in `resultJson.artifacts`.

## Environment Test

Use the "Test Environment" button in the agent configuration UI to validate:
- Antigravity CLI binary exists and is executable
- Working directory is resolvable and accessible
- Authentication and credentials are valid
- Live probe execution succeeds (`agy --print "Respond with hello." --mode plan --output-format json`)
