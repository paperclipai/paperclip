---
title: Claude Local
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- `ANTHROPIC_API_KEY` set in the environment or agent config

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

## OpenRouter

[OpenRouter](https://openrouter.ai) is an OpenAI-compatible hub for many models. Paperclip applies shared `OPENROUTER_*` → `OPENAI_*` env mapping for **OpenAI-compatible** CLIs (see [Codex Local](/adapters/codex-local#using-openrouter), [Cursor Local](/adapters/cursor-local#using-openrouter), [OpenCode Local](/adapters/opencode-local#using-openrouter), and [Pi Local](/adapters/pi-local#using-openrouter)).

**Claude Code does not use that mapping.** It talks to Anthropic (API key, subscription login, or AWS Bedrock), not via Paperclip’s OpenRouter OpenAI bridge. If `OPENROUTER_API_KEY` is present in the server or adapter `env`, it is **ignored for Claude inference** — leave it unset for `claude_local` unless you also run another adapter on the same host that needs it.

To route traffic through OpenRouter with Paperclip, pick an OpenAI-compatible adapter (for example `codex_local` or `opencode_local`) and follow the guides linked above.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY` vs subscription login)
- When `OPENROUTER_API_KEY` is set: informational note that Claude Code does not use Paperclip’s OpenRouter→OpenAI mapping (see [OpenRouter](#openrouter))
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness
