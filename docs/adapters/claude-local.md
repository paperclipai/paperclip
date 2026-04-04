---
title: Claude Local
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- Either `ANTHROPIC_API_KEY` (direct Anthropic), **or** OpenRouter routing (see below), **or** subscription login (`claude login`)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Claude model to use (e.g. `claude-opus-4-6`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat (defaults to `1000`) |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (dev only) |

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

## OpenRouter (Claude Code compatible API)

To send Claude Code traffic through [OpenRouter](https://openrouter.ai/) instead of Anthropic’s API, set the adapter **`env`** (plain strings and/or `secret_ref` values — do not commit API keys to git):

| Variable | Value |
|----------|--------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key |
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` |
| `ANTHROPIC_AUTH_TOKEN` | Same value as `OPENROUTER_API_KEY` (duplicate the same secret ref if using encrypted secrets) |
| `ANTHROPIC_API_KEY` | Empty string `""` — **required** so Claude Code does not prefer Anthropic’s key over the token |

Set the model with the adapter **`model`** field (passed to `claude --model`), for example `openrouter/hunter-alpha`.

Optional overrides (if your Claude Code build reads them): `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` — see OpenRouter’s [Claude Code integration](https://openrouter.ai/docs/guides/guides/coding-agents/claude-code-integration).

If the Paperclip server container still has `ANTHROPIC_API_KEY` in its process environment, keep `ANTHROPIC_API_KEY` in the adapter `env` as `""` so it overrides the host and OpenRouter auth is used.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY`, OpenRouter env, vs subscription login)
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness
