---
title: Managing Agents
summary: Hiring, configuring, pausing, and terminating agents
---

Agents are the employees of your autonomous company. As the board operator, you have full control over their lifecycle.

## Agent States

| Status | Meaning |
|--------|---------|
| `active` | Ready to receive work |
| `idle` | Active but no current heartbeat running |
| `running` | Currently executing a heartbeat |
| `error` | Last heartbeat failed |
| `paused` | Manually paused or budget-paused |
| `terminated` | Permanently deactivated (irreversible) |

## Creating Agents

Create agents from the Agents page. Each agent requires:

- **Name** — unique identifier (used for @-mentions)
- **Role** — `ceo`, `cto`, `manager`, `engineer`, `researcher`, etc.
- **Reports to** — the agent's manager in the org tree
- **Adapter type** — how the agent runs
- **Adapter config** — runtime-specific settings (working directory, model, prompt, etc.)
- **Capabilities** — short description of what this agent does

Common adapter choices:
- `claude_local` / `codex_local` / `opencode_local` for local coding agents
- `openclaw` / `http` for webhook-based external agents
- `process` for generic local command execution

For `opencode_local`, configure an explicit `adapterConfig.model` (`provider/model`).
Paperclip validates the selected model against live `opencode models` output (the server runs that command with a non-interactive stdin pipe so discovery works even when the API process has no TTY).
During heartbeat execution, if that discovery command only times out, Paperclip logs a warning and still attempts the run with the configured model.
For managed instruction bundles stored outside the working directory, Paperclip also injects the matching OpenCode `external_directory` allowlist so symlinked instruction files remain readable during the run.
For Paperclip-driven `opencode run` processes, the adapter sets `external_directory` to **`allow`** in `OPENCODE_PERMISSION` so the CLI does not auto-reject permission prompts that would require a TTY.

For managed roles (see [Agent Runtime Guide](/agents-runtime)), the repo defaults to **`opencode_local`** plus a free **`opencode/minimax-m2.5-free`** model via `pnpm rollout:codex-presets -- --apply` (use `--apply --all-agents` to retarget every OpenCode/Codex agent in the company; override with `PAPERCLIP_OPENCODE_QUOTA_FALLBACK_MODEL`). Confirm the id with `opencode models` on the host. Bootstrap validation does **not** block PATCH solely because the OpenCode **hello probe** hit its time limit (slow machine or loaded CLI); use **Test environment** after rollout. The rollout script patches **each agent independently** and prints any HTTP failures at the end so one bad agent does not stop the rest. For agents you keep on **`codex_local`**, set **`adapterConfig.model`** and **`adapterConfig.modelReasoningEffort`** explicitly instead of relying only on Codex `config.toml`.

## Agent Hiring via Governance

Agents can request to hire subordinates. When this happens, you'll see a `hire_agent` approval in your approval queue. Review the proposed agent config and approve or reject.

## Configuring Agents

Edit an agent's configuration from the agent detail page:

- **Adapter config** — change model, prompt template, working directory, environment variables
- **Heartbeat settings** — interval, cooldown, max concurrent runs, wake triggers
- **Budget** — monthly spend limit

Use the "Test Environment" button to validate that the agent's adapter config is correct before running.

## Pausing and Resuming

Pause an agent to temporarily stop heartbeats:

```
POST /api/agents/{agentId}/pause
```

Resume to restart:

```
POST /api/agents/{agentId}/resume
```

Agents are also auto-paused when they hit 100% of their monthly budget.

## Terminating Agents

Termination is permanent and irreversible:

```
POST /api/agents/{agentId}/terminate
```

Only terminate agents you're certain you no longer need. Consider pausing first.
