---
title: Kimi Code CLI
summary: Kimi Code CLI local adapter setup and configuration
---

The `kimi_local` adapter runs the Kimi Code CLI (`kimi`) locally. It has two execution engines: the default **ACP engine** (`kimi acp`, streaming transcript with live tool status, matching `claude_local`/`gemini_local`) and a **CLI lane** (`kimi -p --output-format stream-json`) used as an automatic fallback. It supports session persistence, per-run skill delivery via `--skills-dir`, thinking-effort control, and structured output parsing.

## Prerequisites

- Kimi Code CLI installed (`kimi` command available; npm package `@moonshot-ai/kimi-code`)
- Authentication configured via one of:
  - `kimi login` (OAuth device flow; credentials stored under `$KIMI_CODE_HOME`, default `~/.kimi-code/`)
  - A provider configured in Kimi's `config.toml` (`[providers.<name>]`)
  - The `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` environment pair (optionally `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_PROVIDER_TYPE`), set in the adapter env or server shell

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `engine` | string | No | Execution engine: `acp` (default; streaming ACP lane via `kimi acp`), `cli` (headless `kimi -p` lane), or unset/`auto` (ACP with automatic CLI fallback when ACP prerequisites fail). |
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Kimi model alias (`provider/model`). Defaults to `kimi-code/kimi-for-coding`. When empty, Kimi uses `default_model` from its own `config.toml`. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the prompt. Sibling files in the same directory (`HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`) are made readable via `--add-dir` on local runs. |
| `effort` | string | No | Thinking effort (`low` \| `medium` \| `high` \| `max`). Forwarded as `KIMI_MODEL_THINKING_EFFORT` for effort-capable models (currently `kimi-code/k3`); `medium` maps to `high` since Kimi has no medium tier. Ignored for models without `support_efforts`. |
| `command` | string | No | CLI command override. Defaults to `kimi`. |
| `extraArgs` | string[] | No | Additional CLI arguments appended to every run |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |

## Execution Engine

By default the adapter runs Kimi through the **ACP engine** (`kimi acp`, an Agent Client Protocol server over stdio), the same shared engine used by `claude_local`, `codex_local`, and `gemini_local`. ACP streams the transcript live: assistant text arrives as deltas and tool calls report a `pending`/`completed` status, so the issue thread updates continuously instead of in bursts.

Engine selection (`engine` config field):

- unset or `auto`: use ACP when its prerequisites pass (Node >= 20, resolvable `kimi acp` command, a bidirectional process target), otherwise fall back to the CLI lane with a diagnostic note.
- `acp`: require ACP; startup failures surface as run errors rather than falling back.
- `cli`: pin the headless CLI lane described below.

The ACP lane reuses the shared acpx session codec, transcript parser, and CLI event formatter, so sessions, transcripts, and logs render identically to the other ACP adapters.

## Headless Execution (CLI lane)

Runs execute as `kimi -p <prompt> --output-format stream-json` (plus `-m <model>` when configured and `-r <sessionId>` when resuming). On local runs the adapter also passes `--add-dir <instructions-dir>` so the agent can read sibling instruction files, and `--skills-dir <dir>` when skills are desired (see below). The prompt is passed as an argument, not stdin. The adapter sets a headless-safe environment (`CI=1`, `NO_COLOR=1`, `KIMI_CODE_NO_AUTO_UPDATE=1`, and `TERM=dumb` when unset) so unattended heartbeats never block on interactive prompts, theme detection, or update preflight; user-configured env values always win.

## Instructions Bundle

When `instructionsFilePath` points at a managed instruction bundle, the entry file (e.g. `AGENTS.md`) is prepended to the prompt along with a directive that names its sibling files (`HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`). On local runs the containing directory is exposed to Kimi via `--add-dir`, so the agent can actually open those companion files instead of only seeing the entry file.

## Thinking Effort

The `effort` field is forwarded as the `KIMI_MODEL_THINKING_EFFORT` operational override, which applies to Kimi providers including managed OAuth models. Kimi has no per-invocation effort flag and no `medium` tier, so `medium` is mapped to `high`; `low`, `high`, and `max` pass through. Effort is only sent for models that advertise `support_efforts` (currently `kimi-code/k3`) to avoid provider rejections; extend `EFFORT_CAPABLE_MODELS` in the adapter as more models gain support.

## Session Persistence

The adapter captures the Kimi session id from the trailing `session.resume_hint` meta event and persists it between heartbeats. On the next wake, it resumes the existing conversation with `-r <session_id>` so the agent retains context.

Session resume is cwd-aware: if the working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown/unrecoverable session error, the adapter automatically retries with a fresh session.

## Skills Delivery

Desired Paperclip skills are delivered from a dedicated per-run directory passed via `--skills-dir`, so skills load reliably and in isolation without writing into the shared `~/.kimi-code/skills` home. On remote runs the skills snapshot is synced to the target and `--skills-dir` points at that isolated copy — Paperclip never overwrites `$KIMI_CODE_HOME/skills`, so skills installed by the operator or other agents are left intact. `--skills-dir` is only passed when at least one skill is desired, so unconfigured agents keep Kimi's default skill discovery.

### Control-plane skill

`paperclipai agent local-cli <agentRef> -C <companyId>` installs the Paperclip control-plane skills into `~/.kimi-code/skills` (honoring `KIMI_CODE_HOME`), alongside the existing `~/.codex/skills` and `~/.claude/skills` targets. Kimi auto-discovers this home on every run, so the agent has the control-plane API reference (issue/comment/interaction routes) from turn one rather than rediscovering endpoints by trial and error. Pass `--no-install-skills` to skip. This is independent of the per-run `--skills-dir` delivery above, which only applies when an agent has explicitly configured skills.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Kimi CLI is installed and accessible (`kimi --version`)
- Working directory is absolute and available (auto-created if missing and permitted)
- Auth availability (OAuth credential/config files under `$KIMI_CODE_HOME`, or the `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` env pair)
- A live hello probe (`kimi -p "Respond with hello." --output-format stream-json`) to verify CLI readiness

## Notes

- Both execution engines are supported: the ACP engine (`kimi acp`, default) and the headless CLI lane (fallback / `engine=cli`).
- Available model aliases on a standard install: `kimi-code/kimi-for-coding` (K2.7 Coding), `kimi-code/kimi-for-coding-highspeed` (K2.7 Coding Highspeed), `kimi-code/k3` (K3).
