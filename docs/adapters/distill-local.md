---
title: Distill
summary: Distill coding agent local adapter setup and configuration
---

The `distill_local` adapter runs the Distill coding agent CLI (`distill`) on the machine that runs Paperclip. Distill can use every model it knows about (Claude, ChatGPT, OpenRouter, Z.AI, custom models) and can pick a saved account and model for each run with its auto routing. The adapter supports resumable sessions, instructions and skills delivery, model discovery, and an environment test.

## Prerequisites

- Distill installed and the `distill` command available on the Paperclip host
- At least one logged-in account or provider API key in the Distill home of the user that runs Paperclip (default `~/.distill`)
- Run `distill accounts list` and `distill models` on the host to check accounts and models

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Fallback working directory for the agent process (absolute path; created when missing) |
| `model` | string | No | Distill model id. Defaults to `auto`, which routes across the saved accounts. Any id from `distill models` works. |
| `reasoningEffort` | string | No | Passed as `--reasoning-effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Support depends on the model. |
| `mode` | string | No | Passed as `--mode` (`auto`, `normal`, `ultrafast`, `ultracode`, `ultrasave`) |
| `maxTurns` | number | No | Maximum agent turns for one run (`--max-turns`) |
| `permissionMode` | string | No | Passed as `--permission-mode`. Unset by default. |
| `alwaysApprove` | boolean | No | Adds `--always-approve` so unattended runs never wait for approval. Default `true`. |
| `disableWebSearch` | boolean | No | Adds `--disable-web-search`. Default `false`. |
| `trustWorkspace` | boolean | No | Sets `GROK_FOLDER_TRUST=0` so Distill loads `Agents.md` and `.claude/skills` from the workspace without a trust prompt. Default `true`. |
| `instructionsFilePath` | string | No | Absolute path to a markdown instructions file |
| `promptTemplate` | string | No | Prompt used for all runs |
| `command` | string | No | CLI command override. Defaults to `distill`. |
| `extraArgs` | string[] | No | Additional CLI arguments appended to every run |
| `env` | object | No | Environment variables, for example `DISTILL_HOME` or provider API keys (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill. Default 20. |

## Headless Execution

Each run executes `distill --cwd <dir> --output-format streaming-json --model <model> --single <prompt>`. When a session exists for the same working directory, the adapter adds `--resume <sessionId>`. If Distill reports that the session no longer exists, the adapter starts a fresh session and clears the saved one.

The adapter reads the `streaming-json` event stream. Token usage comes from the final `end` event. Distill reports Anthropic-style usage, so cache reads are kept separate from input tokens. With `model: auto`, the run reports the model that used the most tokens, not the routing classifier.

## Instructions and Skills

If the workspace has no `Agents.md`, Paperclip stages the file from `instructionsFilePath` there for the run and removes it after the run. If the workspace already has an `Agents.md`, the managed instructions go into the prompt instead, and the workspace file stays unchanged.

Desired Paperclip skills are copied into `.claude/skills` in the workspace for the run. Distill reads them as project skills. Paperclip removes only the files it created.

## Environment Test

The environment test checks the working directory, resolves the `distill` command, runs `distill models`, and runs a one-turn hello probe with the configured model. A missing login shows as a warning with a hint to run `distill accounts list`.

## Limits

The adapter runs on the Paperclip host only. Remote execution targets (SSH and sandboxes) are not supported and return a clear error.
