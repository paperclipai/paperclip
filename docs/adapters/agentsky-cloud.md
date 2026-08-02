---
title: AgentSky
summary: Drive AgentSky cloud-hosted persistent agents from Paperclip
---

The `agentsky_cloud` adapter connects Paperclip to [AgentSky](https://agentsky.dev) — a platform
that hosts long-lived agents (Claude Code, Codex, OpenClaw, Hermes) as always-on cloud pods with
their own persistent filesystem, memory, and context. Paperclip wakes the remote agent on each
heartbeat over AgentSky's public API and records the agent's final message as the run report.

## How it works

- On the first heartbeat the adapter **auto-creates** an AgentSky agent (with the configured
  harness and model) plus a chat session, and persists both in Paperclip's session state. Later
  heartbeats reuse the same durable session, so the remote agent accrues context across wakes.
- Each heartbeat sends one wake message and then follows the session's event ledger
  (`GET /api/v1/sessions/{id}/events`) until the turn completes.
- Changing `harness`, `model`, or `agentSlug` provisions a fresh AgentSky agent/session on the
  next heartbeat; the old one is abandoned, never deleted.
- Alternatively, set `agentSlug` to **attach** to an agent you already created on agentsky.dev;
  the adapter then only creates sessions and ignores the harness/model fields (the existing agent
  already has both).

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `harness` | No (default `claude_code`) | AgentSky agent type: `claude_code`, `codex`, `openclaw`, `hermes` |
| `model` | No | Model id; must be compatible with the harness (table below). Empty = harness default |
| `agentSlug` | No | Attach to an existing AgentSky agent instead of auto-creating one |
| `apiBaseUrl` | No (default `https://agentsky.dev`) | Override for staging/self-hosted AgentSky |
| `instructionsFilePath` | No | Agent instructions file prepended to the prompt |
| `promptTemplate` / `bootstrapPromptTemplate` | No | Standard Paperclip prompt templates |
| `timeoutSec` | No (default 3600) | Max seconds to wait for the remote turn |
| `env.AGENTSKY_API_TOKEN` | **Yes** | AgentSky API token (`ast_…`), created at agentsky.dev → Settings → API tokens |

### Harness / model compatibility

| Harness | Models (first is the default) |
|---------|-------------------------------|
| `claude_code` | `claude-opus-5`, `claude-fable-5`, `claude-sonnet-4-6`, `kimi-k3` |
| `codex` | `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra` |
| `openclaw` | `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`, `deepseek-v4-pro`, `deepseek-v4-flash`, `gemini-3.5-flash`, `glm-5.2`, `kimi-k3` |
| `hermes` | `deepseek-v4-pro`, `deepseek-v4-flash`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gemini-3.5-flash`, `glm-5.2`, `kimi-k3` |

## No repository plumbing

Unlike `cursor_cloud`, there is **no `repoUrl` field**. AgentSky pods own a persistent filesystem;
if the agent should work on a repository, name it (and how to access it) directly in the prompt,
goal, or instructions file. The pod clones it once and keeps it across heartbeats.

## Runtime values and callbacks

The AgentSky message plane has no environment-variable injection, so PAPERCLIP_* runtime values
(`PAPERCLIP_AGENT_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, task/wake ids) are delivered as a
"Paperclip runtime note" text section inside the wake prompt. No Paperclip API key is sent, and a
Paperclip server bound to localhost is unreachable from the cloud agent (the environment test
warns about this) — **the agent's final message each turn is the feedback channel**.

## Billing

Runs bill the AgentSky account's credit wallet (`biller: agentsky`, `billingType: api`). An
exhausted balance surfaces as a failed run with error code `insufficient_credits`.
