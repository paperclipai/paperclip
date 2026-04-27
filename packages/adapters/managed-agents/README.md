# @paperclipai/adapter-managed-agents

MVP spike adapter that runs Paperclip agents on Anthropic's **Claude Managed Agents** beta (`managed-agents-2026-04-01`) instead of a local subprocess.

**Status:** Day 1 spike — rough code, not production-ready. See `co_paperclip_spike_scope` in Cornerstone for the decision context.

## What it does

- Treats each Paperclip agent as a **persistent** Managed Agents `agent_...` object (created once, reused across runs)
- Spins up or reuses a Managed Agents `env_...` container per Paperclip agent
- Each `execute()` invocation creates a fresh `sesn_...`, posts the rendered task as a `user.message`, polls the event stream until `session.status_idle`, and returns usage + cost
- Fetches Cornerstone memory via REST `/context` (parallel with session creation to hide 4s+ latency)
- Prompt-injects Cookbook skills via the rendered system prompt
- Reports **combined cost**: token billing + $0.08 / session-hour runtime

## Environment

Server host must export:

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic key with managed-agents-2026-04-01 beta access |
| `MEMORY_API_KEY` | Cornerstone superuser / shared key. Also used as Cookbook MCP Bearer token for the spike |

## Config fields

See `agentConfigurationDoc` in `src/index.ts`. Key ones: `role`, `model`, `cornerstoneNamespace`, `outputFormat`, `paperclipRuntimeSkills`.

## Known rough edges (deferred)

1. One fresh session per run — no session resumption yet (the shape is there; just pass `sessionId` through)
2. System prompt is prefixed to the user message rather than written via `POST /v1/agents/{id}` version bump
3. No SSE streaming — polls `GET /events` every 500ms. Fine for spike, needs stream replacement for long-running tasks
4. Cornerstone cache is in-process only (TTL 5 min)
5. No cancel support
6. No UI parser (`docs/adapters/adapter-ui-parser.md`) — run logs render as generic stdout
7. Agent/env cleanup is not automated. If we add it, note: `DELETE /v1/agents/{id}` requires `anthropic-beta: agent-api-2026-03-01` (session/env deletes use `managed-agents-2026-04-01`). The two betas are mutually exclusive — any delete-all helper must switch headers per resource type.
