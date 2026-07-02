# Agent Runtime Guide

Status: User-facing guide
Last updated: 2026-03-26
Audience: Operators setting up and running agents in Paperclip

## 1. What this system does

Agents in Paperclip do not run continuously.  
They run in **heartbeats**: short execution windows triggered by a wakeup.

Each heartbeat:

1. Starts the configured agent adapter (for example, Claude CLI or Codex CLI)
2. Gives it the current prompt/context
3. Lets it work until it exits, times out, or is cancelled
4. Stores results (status, token usage, errors, logs)
5. Updates the UI live

## 2. When an agent wakes up

An agent can be woken up in four ways:

- `timer`: scheduled interval (for example every 5 minutes)
- `assignment`: when work is assigned/checked out to that agent
- `on_demand`: manual wakeup (button/API)
- `automation`: system-triggered wakeup for future automations

If an agent is already running, new wakeups are merged (coalesced) instead of launching duplicate runs.

## 3. What to configure per agent

## 3.1 Adapter choice

Built-in adapters:

- `claude_local`: runs your local `claude` CLI
- `codex_local`: runs your local `codex` CLI
- `opencode_local`: runs your local `opencode` CLI
- `cursor`: runs Cursor in background mode
- `pi_local`: runs an embedded Pi agent locally
- `hermes_local`: starts your local `hermes` CLI through `@paperclipai/hermes-paperclip-adapter`
- `hermes_gateway`: calls an already-running Hermes API server through `@paperclipai/hermes-paperclip-adapter/gateway`
- `openclaw_gateway`: connects to an OpenClaw gateway endpoint
- `process`: generic shell command adapter
- `http`: calls an external HTTP endpoint

External plugin adapters (install via the adapter manager or API):

- `droid_local`: runs your local Factory Droid CLI (`@henkey/droid-paperclip-adapter`)

For local CLI adapters (`claude_local`, `codex_local`, `opencode_local`, `hermes_local`, `droid_local`), Paperclip assumes the CLI is already installed and authenticated on the host machine. For `hermes_gateway`, Paperclip assumes the Hermes API server is already running, reachable from the Paperclip server, and configured with an API key. The older `@paperclipai/adapter-hermes-gateway` npm package is only a deprecated compatibility shim; the adapter type remains `hermes_gateway`.

## 3.2 Runtime behavior

In agent runtime settings, configure heartbeat policy:

- `enabled`: allow scheduled heartbeats
- `intervalSec`: timer interval (0 = disabled)
- `wakeOnAssignment`: wake when assigned work
- `wakeOnOnDemand`: allow ping-style on-demand wakeups
- `wakeOnAutomation`: allow system automation wakeups

## 3.3 Working directory and execution limits

For local adapters, set:

- `cwd` (working directory)
- `timeoutSec` (max runtime per heartbeat)
- `graceSec` (time before force-kill after timeout/cancel)
- optional env vars and extra CLI args
- use **Test environment** in agent configuration to run adapter-specific diagnostics before saving

## 3.4 Prompt templates

You can set:

- `promptTemplate`: used for every run (first run and resumed sessions)

Templates support variables like `{{agent.id}}`, `{{agent.name}}`, and run context values.

> **Note:** `bootstrapPromptTemplate` is deprecated and should not be used for new agents. Existing configs that use it will continue to work but should be migrated to the managed instructions bundle system.

## 4. Session resume behavior

Paperclip stores session IDs for resumable adapters.

- Next heartbeat reuses the saved session automatically.
- This gives continuity across heartbeats.
- You can reset a session if context gets stale or confused.

Use session reset when:

- you significantly changed prompt strategy
- the agent is stuck in a bad loop
- you want a clean restart

## 5. Logs, status, and run history

For each heartbeat run you get:

- run status (`queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`)
- error text and stderr/stdout excerpts
- token usage/cost when available from the adapter
- full logs (stored outside core run rows, optimized for large output)

In local/dev setups, full logs are stored on disk under the configured run-log path.

## 6. Live updates in the UI

Paperclip pushes runtime/activity updates to the browser in real time.

You should see live changes for:

- agent status
- heartbeat run status
- task/activity updates caused by agent work
- dashboard/cost/activity panels as relevant

If the connection drops, the UI reconnects automatically.

## 7. Common operating patterns

## 7.1 Simple autonomous loop

1. Enable timer wakeups (for example every 300s)
2. Keep assignment wakeups on
3. Use a focused prompt template that tells agents to act in the same heartbeat, leave durable progress, and mark blocked work with an owner/action
4. Watch run logs and adjust prompt/config over time

## 7.2 Event-driven loop (less constant polling)

1. Disable timer or set a long interval
2. Keep wake-on-assignment enabled
3. Use child issues, comments, and on-demand wakeups for handoffs instead of loops that poll agents, sessions, or processes

## 7.3 Safety-first loop

1. Short timeout
2. Conservative prompt
3. Monitor errors + cancel quickly when needed
4. Reset sessions when drift appears

## 8. Troubleshooting

If runs fail repeatedly:

1. Check adapter command availability (e.g. `claude`/`codex`/`opencode`/`hermes` installed and logged in).
2. Verify `cwd` exists and is accessible.
3. Inspect run error + stderr excerpt, then full log.
4. Confirm timeout is not too low.
5. Reset session and retry.
6. Pause agent if it is causing repeated bad updates.

Typical failure causes:

- CLI not installed/authenticated
- bad working directory
- malformed adapter args/env
- prompt too broad or missing constraints
- process timeout

Claude-specific note:

- If `ANTHROPIC_API_KEY` is set in adapter env or host environment, Claude uses API-key auth instead of subscription login. Paperclip surfaces this as a warning in environment tests, not a hard error.

## 9. Security and risk notes

Local CLI adapters run unsandboxed on the host machine.

That means:

- prompt instructions matter
- configured credentials/env vars are sensitive
- working directory permissions matter

Start with least privilege where possible, and avoid exposing secrets in broad reusable prompts unless intentionally required.

## 10. Team-scoped session reset

When an agent gets stuck — rate-limited, zero-token, or looping silently — a same-team peer or manager can clear the session without needing a CEO/board relay.

### Endpoint

```
POST /api/agents/{agentId}/sessions/reset
Authorization: Bearer <agent-api-key>
Content-Type: application/json

{
  "reason": "Agent appears stuck after rate-limit window",
  "clearIssueLock": true,
  "issueId": "<uuid-of-the-stuck-issue>"
}
```

### Who can call it

- **Same-team agent** — caller must share the same `reportsTo` as the target agent (peer), or the caller must be the direct manager of the target agent.
- **Board/admin** — always accepted (same as the legacy board-only reset endpoint).
- Rate limit: 20 calls per minute per calling agent.

### What it does

1. Deletes the persisted `agentTaskSessions` rows for the target agent, forcing a fresh session on the next heartbeat.
2. Clears the `agentRuntimeState.sessionId` and `lastError` fields.
3. When `clearIssueLock: true` and `issueId` is provided, nulls out `executionRunId` and `executionLockedAt` on that issue, releasing any stale checkout lock.
4. Emits an `agent.session.reset` audit event with actor, target, reason, and team context.

### Response

| Scenario | HTTP | Body |
|---|---|---|
| Reset performed | 200 | `{ status: "reset", agentId, issueLockCleared, issueId, sessionState }` |
| Session already gone (idempotent) | 200 | `{ status: "no_session" }` |
| Caller not same team | 403 | `{ error: "Forbidden: ..." }` |
| Rate limit exceeded | 429 | `{ error: "Rate limit exceeded", retryAfterSeconds }` |

### When to use this

Use `sessions/reset` when:

- An agent stopped producing output after a Claude rate-limit window and is not self-recovering after a full minute.
- A heartbeat ended with a zero-token / empty run and subsequent wakes are also silent.
- An issue has a stale `executionLockedAt` from a previous run that crashed before releasing the lock, and the issue is stuck in a loop.

**Do not use `sessions/reset` when:**

- The adapter has a **misconfigured API key** — clearing the session will not fix the credential error; the next run will fail identically.
- The adapter code has a **bug** (wrong `cwd`, missing dependency, syntax error in the prompt template) — you need to fix the root cause first.
- The agent is **paused** — unpause it instead.
- The issue was intentionally checked out by another agent and is actively running — verify before clearing the lock.

### End-to-end scenario

1. CSO's productivity-review agent detects peer agent `X` has been silent for 10+ minutes on issue `OUT-99999`.
2. Productivity-review agent calls:
   ```
   POST /api/agents/<X-agent-id>/sessions/reset
   { "reason": "Silent for 10 min post rate-limit", "clearIssueLock": true, "issueId": "<OUT-99999-uuid>" }
   ```
3. Paperclip returns `{ status: "reset", issueLockCleared: true }`.
4. Agent `X`'s next scheduled wakeup starts with a fresh session and a cleared checkout lock.

### Legacy board-only endpoint

The existing `POST /api/agents/{agentId}/runtime-state/reset-session` (board/admin only, accepts `taskKey`) remains available for board-driven resets and admin scripting. The new `sessions/reset` endpoint is the preferred path for agent-to-agent team recovery.

## 11. Minimal setup checklist

1. Choose adapter (e.g. `claude_local`, `codex_local`, `opencode_local`, `hermes_local`, `hermes_gateway`, `cursor`, or `openclaw_gateway`). External plugins like `droid_local` are also available via the adapter manager.
2. Set `cwd` to the target workspace (for local adapters).
3. Optionally add a prompt template (`promptTemplate`) or use the managed instructions bundle.
4. Configure heartbeat policy (timer and/or assignment wakeups).
5. Trigger a manual wakeup.
6. Confirm run succeeds and session/token usage is recorded.
7. Watch live updates and iterate prompt/config.
