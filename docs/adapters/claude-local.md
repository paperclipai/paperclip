---
title: Claude Local
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- One of:
  - Claude Code logged in via OAuth (`claude login`) for subscription-based auth (recommended), **or**
  - `ANTHROPIC_API_KEY` set in the environment or agent config for API-key auth

> **Note:** If `ANTHROPIC_API_KEY` is present in the server environment, Claude Code will use API-key auth even if OAuth credentials exist. To use subscription auth, ensure the key is not set in the process environment. A common gotcha is process managers like PM2 — they capture environment variables at daemon startup and pass them to child processes indefinitely. If you remove the key from your shell but the PM2 daemon was started while it was set, restart the daemon (`pm2 kill && pm2 start ...`) to clear the stale variable.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Claude model to use (e.g. `claude-opus-4-6`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat (defaults to `300`) |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (default: `true`); required for headless runs where interactive approval is impossible |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists Claude Code session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context.

Session resume is cwd-aware: if the agent's working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Skills Injection

The adapter creates a temporary directory with symlinks to Paperclip skills and passes it via `--add-dir`. This makes skills discoverable without polluting the agent's working directory.

For manual local CLI usage outside heartbeat runs (for example running as `claudecoder` directly), use:

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

This installs Paperclip skills in `~/.claude/skills`, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY` vs subscription login)
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness
