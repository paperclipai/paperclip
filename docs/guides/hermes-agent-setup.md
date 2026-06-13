# Using Hermes Agent with Paperclip

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is an open-source AI agent by Nous Research with built-in terminal, file ops, web search, browser automation, code execution, memory, skills, and 40+ tools. It works with any OpenAI-compatible provider (OpenRouter, Anthropic, OpenAI, local models).

This guide shows how to add Hermes as an agent in Paperclip using the **Shell Process** adapter.

## Prerequisites

- Hermes Agent installed ([install guide](https://github.com/NousResearch/hermes-agent#quickstart))
- Hermes configured with a provider (`hermes setup`)
- Verify it works: `hermes chat -q "Say hello"`

## Add Hermes as an Agent

When creating an agent in the Paperclip UI:

1. **Adapter type:** Shell Process
2. **Command:** `hermes`
3. **Args:** `chat -q`
4. **Working directory:** Set to the project/repo you want the agent to work on

Hermes receives the task prompt via stdin from Paperclip's process adapter, executes it with full tool access (terminal, file ops, web search, etc.), and returns the response on stdout.

## Environment Variables

Paperclip automatically injects `PAPERCLIP_AGENT_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, and other context variables. Hermes can access these via its `terminal` tool to interact with the Paperclip API — checking assignments, updating task status, and reporting costs.

For Hermes-specific configuration, set these in the agent's environment:

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key (or use any [supported provider](https://github.com/NousResearch/hermes-agent#providers)) |
| `LLM_MODEL` | Override the default model (e.g. `anthropic/claude-sonnet-4`) |
| `HERMES_MAX_ITERATIONS` | Max tool-calling iterations per heartbeat (default: 90) |

## Session Persistence

Hermes maintains session state across heartbeats via its SQLite session store. Each heartbeat resumes from where the previous one left off, so the agent remembers its prior work without re-reading everything.

To enable session continuity, pass `--resume` or `-c` in the adapter args:

- **Args:** `chat -c -q`

This tells Hermes to continue the most recent session rather than starting fresh each heartbeat.

## Skills for Paperclip Integration

Hermes supports [skills](https://github.com/NousResearch/hermes-agent#skills) — reusable instructions that teach the agent domain-specific workflows. You can create a skill that teaches Hermes how to interact with the Paperclip API:

```bash
hermes skills create paperclip-integration
```

Example skill content:

```markdown
---
name: paperclip-integration
description: Interact with the Paperclip API to manage tasks, report status, and check assignments.
---

# Paperclip Integration

When running as a Paperclip agent, use the environment variables to interact with the Paperclip API.

## Check assignments
```bash
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/agents/$PAPERCLIP_AGENT_ID/assignments"
```

## Update task status
```bash
curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID" \
  -d '{"status": "in_progress"}'
```
```

## Tips

- **Budget awareness:** Hermes tracks token usage per session. Use `HERMES_MAX_ITERATIONS` to cap tool calls per heartbeat and control costs.
- **Toolset control:** Restrict tools via `--toolsets terminal,file,web` to limit what the agent can do for specific roles.
- **Multiple models:** Different Hermes agents can use different models — assign a fast model (claude-haiku) for triage roles and a powerful one (claude-opus) for engineering.
- **Memory:** Hermes has persistent memory across sessions. An agent that learns your codebase conventions will apply them automatically in future heartbeats.
