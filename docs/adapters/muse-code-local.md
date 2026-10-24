---
title: Muse
summary: Muse local adapter setup and configuration
---

The `muse_code_local` adapter runs Muse (the `muse` CLI) locally through its headless `muse exec` mode. It supports session persistence across heartbeats, reasoning-effort control, Paperclip skill injection, and structured parsing of the `muse exec --json` event stream.

This adapter is for the Muse terminal coding agent. It is unrelated to the personal Muse agent at muse.ai, which joins through the external-agent invite flow.

## Prerequisites

- Muse installed (`muse` command available on the host that runs Paperclip)
- Authentication configured via one of:
  - `muse login` (Meta account browser approval on the host)
  - The `META_API_KEY` environment variable, set in the adapter env or server shell. It takes priority over the account login.
- Local environments only. SSH and sandbox environments are not supported.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Default working directory fallback for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Muse model id, forwarded as `--model`. When empty, Muse uses the model from the host Muse settings. |
| `effort` | string | No | Reasoning effort forwarded as `--reasoning-effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the prompt |
| `dangerouslySkipPermissions` | boolean | No | When not `false` (the create-form default), passes `--disable-approval` so headless runs never wait on tool approval prompts |
| `dangerouslyBypassSandbox` | boolean | No | When `true`, passes `--disable-sandbox` to disable Muse shell sandboxing |
| `command` | string | No | CLI command override. Defaults to `muse`. |
| `extraArgs` | string[] | No | Additional `muse exec` arguments appended to every run |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |

## Headless Execution

Runs execute as `muse exec --json --prompt-file <tmp> --workspace <cwd> --session-id <id>`. The rendered Paperclip prompt is written to a temporary file (deleted after the run), never interpolated into a shell command or left in the process argument list. Every run also passes `--trust-workspace`, `--disable-request-user-input`, and `--disable-reminders` so heartbeats stay unattended. Stdout JSONL session-stream records are parsed for the session id, model, final text, and token usage; Muse does not report a USD cost, so runs are accounted as unpriced usage under provider `meta`.

## Session Persistence

The adapter generates a session id for the first run and persists it (with the execution cwd) between heartbeats. On the next wake it passes the same `--session-id`, so Muse resumes the existing conversation with full context. Resume is cwd-aware: a session saved for a different working directory is not resumed. When a resumed session turns out to be missing or workspace-mismatched, the adapter retries once with a fresh session.

## Skills

Paperclip skills are symlinked into Muse's user skills home, `~/.agents/skills/`, before each run (existing user skills are never overwritten). The agent discovers the `paperclip` skill there exactly as an interactive Muse session would, without anything being written into the project checkout.
