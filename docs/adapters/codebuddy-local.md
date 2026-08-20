---
title: CodeBuddy
summary: CodeBuddy CLI local adapter setup and configuration
---

The `codebuddy_local` adapter runs Tencent CodeBuddy CLI locally. It supports resumable sessions, skills injection into CodeBuddy project paths, and Claude-compatible `stream-json` output.

## Prerequisites

- CodeBuddy CLI installed (`codebuddy` command available)
- Host authentication: run `codebuddy login` on the Paperclip machine before you wake the agent

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process |
| `model` | string | No | Model id. Defaults to `default-model` |
| `effort` | string | No | Reasoning effort: `low`, `medium`, `high`, or `xhigh` |
| `supportsEffort` | boolean | No | Pass `--effort` only when the installed CLI supports it |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Instructions staged as `CODEBUDDY.md` when that file is not already present |
| `maxTurns` | number | No | Maximum agent turns |
| `command` | string | No | CLI binary. Defaults to `codebuddy` |
| `mcpConfigPath` | string | No | Passed as `--mcp-config`. Strict MCP mode is never enabled |
| `env` | object | No | Environment variables (supports secret refs) |
| `extraArgs` | string[] | No | Additional CLI arguments |

## Session Persistence

The adapter persists CodeBuddy session IDs between heartbeats. The next wake resumes the conversation so the agent keeps context.

If resume fails with an unknown session error, the adapter retries with a fresh session.

## Skills Injection

Desired Paperclip skills are staged into `.codebuddy/skills` and `.claude/skills` in the execution workspace.

## Environment Test

Use the **Test Environment** button in the UI to validate the adapter config. It checks:

- CodeBuddy CLI is installed and resolvable
- Working directory is available
- A version probe succeeds
- A login probe reports whether `codebuddy login` is required
