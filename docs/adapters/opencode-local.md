---
title: OpenCode Local
summary: OpenCode local adapter setup and configuration
---

The `opencode_local` adapter runs [OpenCode](https://opencode.ai) locally. OpenCode supports multiple providers and models through a single `provider/model` string, making it useful when agents need to switch between Anthropic, OpenAI, Gemini, or custom proxy endpoints.

## Prerequisites

- OpenCode CLI installed (`opencode` command available; `opencode upgrade` to update)
- Provider credentials configured in `~/.config/opencode/opencode.json` or via environment variables

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model in `provider/model` format (e.g. `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`) |
| `cwd` | string | No | Working directory for the agent process (absolute path; created automatically if missing) |
| `variant` | string | No | Provider reasoning variant passed as `--variant` (e.g. `low`, `medium`, `high`, `max`) |
| `instructionsFilePath` | string | No | Path to a markdown file prepended to the run prompt on every heartbeat |
| `promptTemplate` | string | No | Run prompt template (default: `"You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work."`) |
| `env` | object | No | Environment variables injected into the process (supports secret refs) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill after timeout (default: 20s) |
| `dangerouslySkipPermissions` | boolean | No | Allow all external directory access without prompts (default: `true`); required for unattended headless runs |
| `command` | string | No | Override the `opencode` binary path (default: `"opencode"`) |
| `extraArgs` | string[] | No | Additional CLI arguments appended to every invocation |

## Model Format

Models are specified as `provider/model` — the provider prefix must match a key in your OpenCode config:

```
anthropic/claude-sonnet-4-5
openai/gpt-4o
llm-proxy/claude-opus-4-6
```

## Session Persistence

The adapter persists OpenCode session IDs between heartbeats and passes `--session <id>` on resume, so the agent retains full conversation context across runs. Sessions are cwd-aware: if the working directory changed since the last run, a fresh session starts automatically.

## Permissions (headless mode)

OpenCode's permission system blocks access to directories outside the project root by default. When `dangerouslySkipPermissions` is `true` (the default), Paperclip injects a temporary runtime config that sets `permission.external_directory = {"/*": "allow"}`, granting access to all external directories without interactive prompts.

This temporary config is isolated from the user's real `~/.config/opencode/opencode.json` and is cleaned up after each run.

> **Note:** The string form `"allow"` for `external_directory` is not supported in OpenCode 1.x — only the object form `{ "<path-glob>": "allow" }` (e.g. `{ "/*": "allow" }`) is recognized. Paperclip handles this automatically.

## Skills Injection

Paperclip installs selected skills as symlinks under `~/.claude/skills/`. Skills are synced before each run — stale entries are removed and new ones are linked. Existing user-created skills are not overwritten.

## Instructions File

When `instructionsFilePath` is configured, Paperclip reads that file and prepends its contents to the stdin prompt on every run. This is resolved relative to the effective `cwd`.

## Environment Test

The "Test Environment" button in the UI validates:

- The configured `cwd` is a real absolute path
- The `opencode` binary is on `PATH` and executable
- At least one model is available (`opencode models`)
- The configured model exists in the discovered model list
- A live hello probe (`opencode run --format json` with stdin `Respond with hello.`) succeeds

## Manual Local CLI

For manual usage outside heartbeat runs:

```sh
pnpm paperclipai agent local-cli <agent-name> --company-id <company-id>
```

This injects Paperclip skills, creates an agent API key, and prints shell exports to run as that agent.
