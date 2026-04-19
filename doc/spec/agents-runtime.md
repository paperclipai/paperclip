# Agent Runtime Guide

Status: User-facing guide
Last updated: 2026-04-18
Audience: Operators setting up and running agents in PrivateClip

## 1. What this system does

Agents in PrivateClip do not run continuously.  
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
Timer heartbeats are periodic nudges, not catch-up jobs: if a timer-triggered run is already `queued` or `running`, the scheduler keeps that single outstanding wake instead of stacking missed intervals into a backlog.
If a manual wakeup is blocked by policy or company state, the request should return a visible skipped reason rather than appearing to do nothing.

## 3. What to configure per agent

## 3.1 Adapter choice

Common choices:

- `claude_local`: runs your local `claude` CLI
- `codex_local`: runs your local `codex` CLI
- `process`: generic shell command adapter
- `http`: calls an external HTTP endpoint

For `claude_local` and `codex_local`, PrivateClip assumes the CLI is already installed and authenticated on the host machine.

## 3.2 Runtime behavior

In agent runtime settings, configure heartbeat policy:

- `enabled`: allow scheduled heartbeats
- `intervalSec`: timer interval (0 = disabled)
- `wakeOnAssignment`: wake when assigned work
- `wakeOnOnDemand`: allow ping-style on-demand wakeups
- `wakeOnAutomation`: allow system automation wakeups

Archived and paused companies do not start new timer work. Queued runs for archived/paused companies should be cancelled instead of remaining queued indefinitely.

## 3.3 Working directory and execution limits

For local adapters, set:

- `cwd` (working directory)
- `timeoutSec` (max runtime per heartbeat)
- `graceSec` (time before force-kill after timeout/cancel)
- optional env vars and extra CLI args

## 3.4 Prompt templates

You can set:

- `promptTemplate`: used for every run (first run and resumed sessions)

Templates support variables like `{{agent.id}}`, `{{agent.name}}`, and run context values.

## 4. Session resume behavior

PrivateClip stores resumable session state per `(agent, taskKey, adapterType)`.
`taskKey` is derived from wakeup context (`taskKey`, `taskId`, or `issueId`).

- A heartbeat for the same task key reuses the previous session for that task.
- Different task keys for the same agent keep separate session state.
- If restore fails, adapters should retry once with a fresh session and continue.
- You can reset all sessions for an agent or reset one task session by task key.

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

## 5.1 Runtime integrity recovery

Heartbeat recovery has a control-plane reconciliation pass before queued work resumes.

That pass:

- terminalizes wakeups whose linked runs already finished
- cancels queued runs that belong to archived or paused companies
- repairs broken `in_progress` issue ownership by either rebinding to the single live run for that issue or demoting impossible fake WIP back to `todo`

Operators can inspect or run the same repair logic manually:

```sh
pnpm runtime-integrity:reconcile
pnpm runtime-integrity:reconcile -- --apply
pnpm routine-execution:reconcile
pnpm routine-execution:reconcile -- --apply
```

## 6. Live updates in the UI

PrivateClip pushes runtime/activity updates to the browser in real time.

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
3. Use a focused prompt template
4. Watch run logs and adjust prompt/config over time

## 7.2 Event-driven loop (less constant polling)

1. Disable timer or set a long interval
2. Keep wake-on-assignment enabled
3. Use on-demand wakeups for manual nudges

## 7.3 Safety-first loop

1. Short timeout
2. Conservative prompt
3. Monitor errors + cancel quickly when needed
4. Reset sessions when drift appears

## 7.4 Leaving issue-level truth for COO recovery

Operations heartbeats only suppress cross-agent recovery when an assignee leaves explicit issue-level truth.

Use structured line-start markers or headings such as:

- `Status: blocked`
- `Blocked: ...`
- `Handoff: ...`
- `[BLOCKER]`
- `[HANDOFF]`
- `[QA ROUTE]`
- `[READY FOR QA]`
- `[AUTO-FIX BLOCKED]`
- `[POISONED SESSION]`
- `DONE: ...`
- `Workflow gate: ...`
- `Missing permission: ...`
- `Board action required.`

Free-form transcript narration does not count. Mentioning phrases like `QA gate`, `missing permission`, or `before entering in_review` inside ordinary prose should not suppress COO recovery on its own, and markers pasted only inside fenced code blocks or blockquotes are ignored. Once explicit truth is present, newer ordinary chatter does not clear it by itself.

## 7.5 Truthful WIP and same-issue ownership correction

COO treats `assigneeAgentId` and `status` differently:

- `assigneeAgentId` means “who should own this next”
- `status = in_progress` means “this issue is actively consuming an execution slot”

That means COO may correct the same issue without creating a successor issue:

- wrong-specialist ownership can be reassigned on the same issue
- project/domain truth should win over incidental phrasing:
  - `App` project delivery defaults to the app engineer
  - `Website` / marketing-surface delivery defaults to the web engineer
  - generic words like `browser`, `page`, or `route` do not by themselves justify website routing
- backend / API / runtime failure signals should route to platform before website when both appear in the same issue text
- `in_progress` without a live execution run or fresh structured wait/handoff truth can be demoted back to `todo`
- assigned `todo` is valid queued ownership and does not consume a slot
- wakes should only be issued when the selected owner has a real free heartbeat slot
- `coalesce_if_active` and `skip_if_active` routines keep one canonical open issue even when no heartbeat run is currently live
- paused `routine_execution` issues are inert history/work objects and must not be re-woken by COO
- queued heartbeat runs for paused `routine_execution` issues must be cancelled before claim-time recovery can start them
- stale `routine_execution` siblings must not be re-woken once another open issue for the same routine already holds the canonical slot

This is intentionally limited to same-issue correction. `recovered_by` successor issues remain exceptional board-controlled recovery only.

## 7.6 Self-healing heartbeat recovery

The heartbeat runtime should prefer same-issue recovery over operator cleanup:

- active runs are judged by fresh runtime activity, not only by `status = running`
- trusted liveness should come from `lastActivityAt` and runtime signals such as log streaming, adapter metadata, process spawn metadata, and explicit activity reports; ordinary status bookkeeping must not refresh that lease by itself
- a quiet run should become `suspect` before it is declared lost
- the default balanced policy is:
  - suspect after roughly 90 seconds without trusted activity
  - declare loss after roughly 150 seconds without trusted activity
  - recover on the same issue inside 5 minutes when possible
- process loss should retry the same agent on the same issue once, including adapters without a local child pid when the lease has clearly expired
- the queued recovery run may reserve the issue execution lock so another worker does not steal the same execution while recovery is in flight
- if that retry is already used, the run should become terminal from a recovery perspective (`exhausted`, `blocked`, or `non_retriable`)
- transient adapter failures should be classified consistently whether the adapter throws or returns a failed result, so the same retry policy and retry-circuit logic applies to both
- transient adapter failures should trip an adapter-level retry circuit before they create a retry storm, and an open circuit should pause fresh specialist dispatch and cross-agent recovery nudges on that adapter until the cooldown expires while allowing orchestrator-only control-plane runs to keep sweeping and bookkeeping
- recovery should always write structured run events and activity-log rows
- issue comments should only be added when recovery changes ownership, changes status, or needs operator attention
- completion-comment enforcement should apply only to succeeded runs; failed or auto-retrying runs must not create missing-comment recovery noise
- Inbox should not surface failed runs that are still auto-recovering

## 8. Troubleshooting

If runs fail repeatedly:

1. Check adapter command availability (`claude`/`codex` installed and logged in).
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

## 9. Security and risk notes

Local CLI adapters run unsandboxed on the host machine.

That means:

- prompt instructions matter
- configured credentials/env vars are sensitive
- working directory permissions matter

Start with least privilege where possible, and avoid exposing secrets in broad reusable prompts unless intentionally required.

## 10. Minimal setup checklist

1. Choose adapter (`claude_local` or `codex_local`).
2. Set `cwd` to the target workspace.
3. Add bootstrap + normal prompt templates.
4. Configure heartbeat policy (timer and/or assignment wakeups).
5. Trigger a manual wakeup.
6. Confirm run succeeds and session/token usage is recorded.
7. Watch live updates and iterate prompt/config.
