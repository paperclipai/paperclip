---
title: Kimchi CLI
summary: Kimchi CLI local adapter setup and configuration
---

The `kimchi_local` adapter runs the Kimchi CLI (`kimchi`) locally through the Agent Client Protocol. Paperclip launches `kimchi --mode acp` and streams the session transcript live, in the same shared ACP engine used by `claude_local` and `kimi_local`. The adapter is ACP-only in v1: when the ACP prerequisites are not met, the run fails with a setup error instead of falling back to a CLI lane.

## Prerequisites

- Kimchi CLI installed (`kimchi` command available; binary releases from `getkimchi/kimchi`)
- Kimchi v0.0.7 or newer (first release that accepts `--mode acp`)
- Authentication configured via one of:
  - The `KIMCHI_API_KEY` environment variable (Kimchi Inference)
  - A browser or subscription login completed inside the CLI (`kimchi`, then `/login`, or the `kimchi setup` wizard)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Kimchi Inference model id. Defaults to `kimi-k2.7`. Multi-model mode is selected in-session through the ACP model selector, not via CLI flag. |
| `command` | string | No | CLI command override. Defaults to `kimchi`. |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the run prompt |
| `extraArgs` | string[] | No | Additional CLI arguments appended to every run |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |

## Execution

The adapter always launches `kimchi --mode acp` through the shared acpx engine. The engine resolves availability up front: a missing binary, an old version, or an unavailable bidirectional process target returns `adapter_engine_unavailable` as a run result, so setup problems surface as setup errors instead of hang or silent fallback. A failed ACP invocation propagates as a run error; there is no CLI-lane JSON streaming fallback in v1 because Kimchi's headless `-p` JSON-streaming mode is unverified.

The adapter sets a headless-safe environment (`CI=1`, `NO_COLOR=1`) so unattended heartbeats never wait on interactive prompts and terminal styling never breaks parsing. User-configured env values always win.

## Models

Kimchi Inference offers these model ids through the CLI:

- `kimi-k2.7` (Kimi K2.7)
- `kimi-k3` (Kimi K3)
- `minimax-m3` (MiniMax M3)
- `nemotron-3-ultra-fp4` (Nemotron 3 Ultra FP4)
- `deepseek-v4-flash` (DeepSeek V4 Flash)
- `glm-5.3` (GLM 5.3)
- `glm-5.3-flash` (GLM 5.3 Flash)

Kimchi is multi-model capable: the orchestrator/builder/reviewer/explorer roles are selected in-session through the ACP model selector, so the adapter does not pass a model flag for them.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Kimchi CLI is installed and accessible (`kimchi --version`)
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication availability (`KIMCHI_API_KEY` in the adapter env, or a completed CLI login)
- Node >= 20 is available for the ACP engine prerequisites

## Notes

- Kimchi v0.0.7 has no session persistence: every run starts a fresh session. There is no cross-heartbeat resume in v1.
- Kimchi has no skills directory contract Paperclip can manage. Desired Paperclip skills are tracked but not delivered in v1; configure Kimchi's own skills through its config under `~/.config/kimchi/`.
- The first run may install Kimchi's RTK harness into `~/.config/kimchi/harness/rtk`; expect first-run side effects.
- Telemetry is on by default; set `KIMCHI_TELEMETRY_ENABLED=0` in env to opt out.
- MCP servers must be configured in Kimchi's config file before start (Kimchi v0.0.7 has no per-session runtime MCP registration).
