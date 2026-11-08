---
title: Grok Local
summary: Grok Build CLI adapter setup, configuration, and remote execution
---

The `grok_local` adapter runs the native Grok Build CLI through Paperclip. It supports resumable sessions, Paperclip-managed instructions and skills, and structured streaming output.

## Prerequisites

- Grok CLI installed and available as `grok` on the execution machine.
- Grok CLI authenticated with `grok login`, or an `XAI_API_KEY` configured in the adapter environment.
- A working directory that the execution target can access.

For remote execution, install and authenticate the Grok CLI in the remote execution environment. Remote runs do not fall back to the Paperclip host's Grok login.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process. |
| `model` | string | No | Grok model ID. Defaults to the Grok CLI's default model (`grok-build` sentinel). |
| `promptTemplate` | string | No | Prompt template used for runs. |
| `instructionsFilePath` | string | No | Absolute path to a Markdown instructions file. Paperclip stages it as `Agents.md` when safe, or uses Grok's `--rules @file` fallback. |
| `permissionMode` | string | No | Grok permission mode passed through `--permission-mode`. Unset by default. |
| `reasoningEffort` | string | No | Reasoning effort: `low`, `medium`, or `high`. `grok-4.6` and `grok-4.7` also support `xhigh`. |
| `maxTurns` | number | No | Maximum number of agent turns. |
| `command` | string | No | CLI command. Defaults to `grok`. |
| `extraArgs` | string[] | No | Additional CLI arguments. |
| `env` | object | No | Environment variables. Supports secret references. |
| `timeoutSec` | number | No | Run timeout in seconds. |
| `graceSec` | number | No | Grace period before the process is stopped. |

## Authentication

Grok Local can use the Grok CLI login on the execution machine or an `XAI_API_KEY` environment variable.

The adapter can preserve an inherited or configured `GROK_HOME`. Managed AI connections use their selected Grok home. Remote and sandbox runs do not use the host's interactive Grok login as a fallback.

## Remote Execution

Grok Local supports remote execution targets. For a remote target, Paperclip starts its API bridge before it starts the Grok process.

The bridge makes the Paperclip API available to the remote execution environment. Paperclip passes the bridge environment to the child process and connects remote run-log and run-settlement handling to the bridge.

The bridge is stopped during run cleanup before Paperclip restores the remote workspace. Local execution does not start this remote bridge.

The bridge provides API connectivity. It does not install the Grok CLI or authenticate the Grok account on the remote machine.

## Sessions, Instructions, and Skills

Runs use `grok --single` with `--output-format streaming-json`.

Paperclip resumes saved Grok sessions with `--resume` when the saved session working directory matches the current working directory.

Paperclip stages managed instructions into the execution workspace as `Agents.md` when safe. It stages managed skills under `.claude/skills`, which Grok discovers as project skills.

## Environment Test

Use the adapter's Test Environment action to check CLI availability, authentication, model availability, and a live hello probe.

Run `grok models` on the execution machine to inspect authentication and available models.
