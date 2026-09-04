---
title: Devin
summary: Devin CLI local adapter setup and configuration
---

The `devin_local` adapter runs the Devin CLI in print mode (`devin -p`). It is a
thin wrapper that spawns one `devin` process per turn, captures the final
markdown response from stdout, and parses the ATIF transcript produced by
`--export` for session ids and token counts.

## Prerequisites

- Devin CLI installed (`devin` command available)
- `devin setup` completed so `~/.config/devin` exists
- `AGENTS.md` placed in the adapter's `cwd` for project-specific instructions

## Configuration Fields

| Field                   | Type     | Required | Description                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`               | string   | No       | Path to the `devin` CLI. Defaults to `devin`.                                                                                                                                                                                                                                               |
| `cwd`                   | string   | No       | Absolute working directory. Devin loads `AGENTS.md` from here. Defaults to `$HOME`.                                                                                                                                                                                                         |
| `model`                 | string   | No       | Devin model family or exact `model_uid`. Empty lets Devin pick its own default.                                                                                                                                                                                                             |
| `permissionMode`        | string   | No       | `auto`, `normal`, `accept-edits`, `smart`, `dangerous`, or `autonomous`. Forwarded unchanged to the CLI, which validates it (rollout-gated modes like `smart` degrade to `normal` with a warning). Defaults to `auto`, the CLI's own default; choose `dangerous` for fully unattended runs. |
| `respectWorkspaceTrust` | boolean  | No       | Defaults to `false`. Passes `--respect-workspace-trust false` so Devin can run in a fresh directory without an interactive trust prompt.                                                                                                                                                    |
| `sandbox`               | boolean  | No       | Defaults to `false`. When enabled, `--sandbox` is always passed; the CLI then runs with the `autonomous` permission mode regardless of `permissionMode`, and the adapter logs that coercion.                                                                                                |
| `contextSize`           | string   | No       | `default` or `1m`. Only shown when discovered models offer extended context.                                                                                                                                                                                                                |
| `fastMode`              | boolean  | No       | Use the faster, higher-cost lane when the model offers one.                                                                                                                                                                                                                                 |
| `priority`              | boolean  | No       | Use priority processing when the model offers a priority lane.                                                                                                                                                                                                                              |
| `timeoutSec`            | number   | No       | Run timeout in seconds. Defaults to `1800`.                                                                                                                                                                                                                                                 |
| `graceSec`              | number   | No       | SIGTERM grace period. Defaults to `15`.                                                                                                                                                                                                                                                     |
| `exportPath`            | string   | No       | Optional absolute path for the ATIF transcript. Defaults to a temp file.                                                                                                                                                                                                                    |
| `extraArgs`             | string[] | No       | Additional `devin` CLI arguments appended after the managed args.                                                                                                                                                                                                                           |
| `env`                   | object   | No       | Environment variable overrides (supports secret refs).                                                                                                                                                                                                                                      |

`model`, `thinkingEffort`, and `timeoutSec` are rendered by the board's native
"Permissions & Configuration" section for local adapters, so they do not appear
in the per-adapter config form.

Thinking effort tiers are per model family. The adapter reports each base
model's supported tiers on the models route (`efforts` on each entry), and the
board's Thinking effort dropdown offers only those tiers plus Auto. An explicit
`thinkingEffort` the selected family does not offer is rejected at run time
with an error naming the legal tiers; `auto` (the default) is always accepted.

## Invocation

For each turn the adapter runs a command shaped like:

```sh
devin \
  --respect-workspace-trust false \
  --model <model_uid> \
  --permission-mode <mode> \
  --export <atif-path> \
  --prompt-file <prompt-path> \
  -p
```

`--permission-mode` is omitted when `permissionMode` is unset (the CLI default
`auto` applies), and `--sandbox` is added after `--model` when `sandbox` is
enabled. For resume, the `-r <sessionId>` flag is inserted before `-p`:

```sh
devin \
  --respect-workspace-trust false \
  --model <model_uid> \
  --permission-mode <mode> \
  --export <atif-path> \
  -r <sessionId> \
  --prompt-file <prompt-path> \
  -p
```

## Session Persistence

Sessions are persisted through the adapter's `sessionCodec`. It stores the Devin
`sessionId` and the `cwd` it was created in. Resume is only attempted when the
stored `cwd` matches the current run's `cwd`, preventing cross-project session
contamination. If the stored session is unknown or stale, the adapter starts a
fresh session and clears the stored params.

## Instructions

Devin loads `AGENTS.md` from the `cwd` automatically; when the effective
instructions entry file resolves to `<cwd>/AGENTS.md`, the adapter leaves that
auto-load untouched. For any other path — the common case for Paperclip-managed
instruction bundles, whose files live in a per-agent instructions directory —
the adapter delivers the bundle in the prompt: the entry file's content is
prepended, and a directive names its directory as authoritative for sibling
files such as `HEARTBEAT.md`, `SOUL.md`, and `TOOLS.md`. Devin reads those
siblings with its normal file tools; no extra CLI flag exists or is needed. If
a configured entry file cannot be read, the run fails fast with a clear error
before the Devin CLI starts — the agent never runs without its managed
instructions.

## Skills

Desired Paperclip skills are symlinked into `<cwd>/.devin/skills/` before each
run, the directory the Devin CLI scans for project skills. The shared
`~/.config/devin/skills` home is never written, so skills installed by the
operator or other agents are left intact and nothing leaks across agents or
companies. When no skills are configured, nothing is written and Devin's
default skill discovery is unchanged.

## Usage and Cost Reporting

Usage is read from the ATIF file written by `--export`. Cost is computed per
step at each step's own model rates (the ATIF's per-step `generation_model`),
then summed; cached tokens are never billed at the full input rate. When step
coverage is partial, the run reports `costUsd: null` with a `devinCoverageGap`
marker rather than a partial sum. Free-lane models report `costUsd: 0` with
`billingType: subscription_included`. A per-model breakdown lands in
`resultJson.devinModelBreakdown`.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- `devin` binary is installed and runnable
- `cwd` is absolute (warns if it does not exist yet)
- `~/.config/devin` is present
- `AGENTS.md` exists in `cwd` (warns if missing)
- `devin models list` works and the catalog can be parsed
- the CLI advertises `--print` and `--export`

## Credential Topology

`devin_local` uses host-owned configuration. The Devin CLI reads credentials and
settings from `~/.config/devin`. Paperclip wake context is injected through
`PAPERCLIP_*` environment variables, and the agent can use plain `curl` with those
variables to drive its own issue.

The `PAPERCLIP_API_KEY` seen by the agent is not a long-lived bearer credential.
It is a local agent JWT that the server mints per run: bound to the agent id,
the company id, and the run id, with a TTL (default 48 hours, configurable via
`PAPERCLIP_AGENT_JWT_TTL_SECONDS`). The prompt text names the variable only —
the token value never appears in prompts or transcripts.

## Model Discovery

The model catalog is refreshed live from `devin models list --format json`. If
the CLI is unavailable or unauthenticated, discovery degrades to an empty list
(never a stale hardcoded one), and the board offers a Refresh button that calls
the adapter's `refreshModels` hook to bypass the cache.
