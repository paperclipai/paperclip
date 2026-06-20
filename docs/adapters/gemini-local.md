---
title: Gemini Local
summary: Gemini CLI local adapter setup and configuration
---

The `gemini_local` adapter runs Google's Gemini CLI locally. It supports session persistence with `--resume`, skills injection, and structured `stream-json` output parsing.

## Prerequisites

- Gemini CLI installed (`gemini` command available)
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` set, or local Gemini CLI auth configured

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Gemini model to use. Defaults to `auto`. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the prompt |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `yolo` | boolean | No | Pass `--approval-mode yolo` for unattended operation |

## Session Persistence

The adapter persists Gemini session IDs between heartbeats. On the next wake, it resumes the existing conversation with `--resume` so the agent retains context.

Session resume is cwd-aware: if the working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Skills Injection

The adapter symlinks Paperclip skills into the Gemini global skills directory (`~/.gemini/skills`). Existing user skills are not overwritten.

## Headless Runtime & Auth Behavior

When running in headless or non-interactive environments (such as in automated heartbeats or background runs), the adapter configures the Gemini process environment to prevent blocking or interactive prompts:
- Enforces `NO_BROWSER=1` to prevent Gemini from opening a browser for interactive OAuth logins. If authentication fails, the CLI will fail fast instead of stalling.
- Removes `NO_COLOR` and normalizes `TERM` and `COLORTERM` to standard terminal presets to keep output formatting consistent in logs.
- Developers and operators troubleshooting auth failures should ensure valid `GEMINI_API_KEY` or `GOOGLE_API_KEY` credentials are bound to the agent or environment.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Gemini CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth hints (`GEMINI_API_KEY` or `GOOGLE_API_KEY`)
- A live hello probe (`gemini --output-format json "Respond with hello."`) to verify CLI readiness
