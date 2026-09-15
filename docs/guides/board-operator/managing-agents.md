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
- `claude_local` / `codex_local` / `opencode_local` / `hermes_local` for local coding agents
- `hermes_gateway` / `openclaw_gateway` / `http` for webhook-based external agents
- `process` for generic local command execution

Use `hermes_local` when Paperclip should start the local Hermes CLI. Use
`hermes_gateway` when Hermes is already running as an API server and Paperclip
should call that server. Both are built-in adapter types from the unified
`@paperclipai/hermes-paperclip-adapter` package.

For `opencode_local`, configure an explicit `adapterConfig.model` (`provider/model`).
Paperclip validates the selected model against live `opencode models` output.

### Reusing model connections

Both onboarding and the new-agent connection step can reuse saved credentials
in the selected organization. A saved subscription is the default when available;
otherwise a saved API key is selected automatically. Personal keys appear before
organization keys. You can still choose a new key or another account:

- Claude can use your saved subscription login without another sign-in.
- OpenAI lists ChatGPT accounts saved by Paperclip's Codex sign-in flow. Choose
  an account or select **Sign in to another account**.
- In API-key mode, choose a saved personal or organization provider key, or
  enter a new key. The picker recognizes canonical provider keys (such as
  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`) and the distinct keys created by
  agent setup.

Reusing a connection binds its secret reference to the agent. It does not copy
or rotate the saved value. The connection is tested before the agent is created;
being listed does not guarantee that a provider still accepts the credential.
These choices also apply to the Claude and Codex native runner setup paths.

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
