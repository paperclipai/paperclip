---
title: Codex Local
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

Paperclip treats this adapter as a deep-thinking lane by default: new agents start on `gpt-5.4` with `xhigh` reasoning effort. Faster variants such as `gpt-5.3-codex-spark` remain available as explicit manual model choices, but they are not the default.

## Prerequisites

- Codex CLI installed (`codex` command available)
- `OPENAI_API_KEY` set in the environment or agent config

## Background Service PATH

On macOS, Codex installed through the Codex app may live at `/Applications/Codex.app/Contents/Resources/codex`, which is not always present in the `PATH` inherited by launchd or other background Paperclip server processes. When the adapter command is the default bare `codex`, Paperclip preserves the server's current `PATH` and appends common Codex locations, including the Codex app resources directory and common user bin directories under `$HOME`.

If the environment test still reports `codex_command_unresolvable`, set the adapter command to `/Applications/Codex.app/Contents/Resources/codex` or add that directory to the environment used to start Paperclip.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Model to use. New Codex agents created by Paperclip default to `gpt-5.4`. |
| `modelReasoningEffort` | string | No | Reasoning effort override passed as `-c model_reasoning_effort=...`. New Codex agents created by Paperclip default to `xhigh`. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `fastMode` | boolean | No | Enables Codex Fast mode. Currently supported on `gpt-5.4` only and burns credits faster |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

## Fast Mode

When `fastMode` is enabled, Paperclip adds Codex config overrides equivalent to:

```sh
-c 'service_tier="fast"' -c 'features.fast_mode=true'
```

Paperclip currently applies that only when the selected model is `gpt-5.4`. On other models, the toggle is preserved in config but ignored at execution time to avoid unsupported runs.

## Managed `CODEX_HOME`

When Paperclip is running inside a managed worktree instance (`PAPERCLIP_IN_WORKTREE=true`), the adapter instead uses a worktree-isolated `CODEX_HOME` under the Paperclip instance so Codex skills, sessions, logs, and other runtime state do not leak across checkouts. It seeds that isolated home from the user's main Codex home for shared auth/config continuity.

## Manual Local CLI

For manual local CLI usage outside heartbeat runs (for example running as `codexcoder` directly), use:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

This installs any missing skills, creates an agent API key, and prints shell exports to run as that agent.

## Instructions Resolution

If `instructionsFilePath` is configured, Paperclip reads that file and prepends it to the stdin prompt sent to `codex exec` on every run.

This is separate from any workspace-level instruction discovery that Codex itself performs in the run `cwd`. Paperclip does not disable Codex-native repo instruction files, so a repo-local `AGENTS.md` may still be loaded by Codex in addition to the Paperclip-managed agent instructions.

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` presence)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run
