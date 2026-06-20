# Task Watchdog

## Table of contents

- [Why it exists](#why-it-exists)
- [Mental model](#mental-model)
- [Configuration](#configuration)
  - [From the UI](#from-the-ui)
  - [From the API](#from-the-api)
- [How a scan works](#how-a-scan-works)
- [What the watchdog agent does](#what-the-watchdog-agent-does)
  - [Writing custom instructions](#writing-custom-instructions)
- [Scope enforcement](#scope-enforcement)
- [Origin and badges](#origin-and-badges)
- [When not to use a watchdog](#when-not-to-use-a-watchdog)
- [Reference](#reference)

---

A **task watchdog** is an agent you assign to verify a stopped issue tree and put it back into motion when stopping was a mistake. You configure it on a single issue, and it watches that issue plus its non-watchdog descendants. When every leaf in that subtree comes to rest — done, cancelled, blocked, in review, or waiting on an interaction — and there is no live continuation path, Paperclip wakes the watchdog agent to read the evidence and decide whether the stop is legitimate.

Watchdogs are opt-in per issue. There is no global "watch everything" mode.

---

## Why it exists

Agents can stop work for the wrong reasons: misreading a blocker, accepting a stale plan confirmation, declaring "done" without proof, leaving an issue `in_review` with no real reviewer, or running into a recoverable failure and giving up. None of those failures wake anyone on their own — the tree just sits.

A task watchdog gives you a second pass on stopped work without rerunning the original assignee. It is verification-shaped, not execution-shaped: the watchdog reads what other agents claimed, checks it against the evidence in the thread, and either accepts the stop or restores a live path.

It is **not** an output-silence monitor for active runs. That is a separate mechanism — the silent active-run watchdog described in [`doc/execution-semantics.md`](execution-semantics.md) §12. Task watchdog only fires when the whole watched subtree has come to rest.

---

## Mental model

Three concepts share the word "watchdog" inside Paperclip. Keep them separate:

| Concept                       | What it watches                                                       | When it fires                                                     |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Task watchdog** (this doc)  | A configured issue + its non-watchdog descendants                     | The whole watched subtree has stopped and the stop is new         |
| **Silent active-run watchdog**| A single still-running process                                        | The process has produced no output for the threshold window       |
| **Liveness recovery**         | Any agent-owned `in_progress` issue with no live path                 | Stalled work detected during the periodic recovery scan           |

The task watchdog is configured by you (or by an agent on your behalf). The other two run automatically on every project.

---

## Configuration

A watchdog has three fields:

| Field            | Required | Notes                                                                                  |
| ---------------- | -------- | -------------------------------------------------------------------------------------- |
| Watched issue    | yes      | The issue you attach the watchdog to. Configured implicitly via the issue you edit.    |
| Watchdog agent   | yes      | Any same-company, invokable agent. Cannot be paused, terminated, or budget-blocked.    |
| Instructions     | no       | Free-form text (trimmed; empty becomes null). Can narrow focus; cannot expand authority.|

A single watched issue holds **at most one active watchdog**. Re-assigning the agent or editing instructions invalidates the previously reviewed state and forces a fresh evaluation on the next scan.

### From the UI

> **Prerequisite:**
> The watchdog UI elements in the New Issue dialog and Issue Properties panel are only visible if `enableTaskWatchdogs` is enabled under `Instance Settings > Experimental` (or `enableTaskWatchdogs: true` in the instance settings DB table).

Two surfaces edit the watchdog:

- **New issue dialog** — the three-dot menu reveals a **Watchdog** row. Pick an agent and (optionally) type instructions. The chip in the dialog footer shows the chosen agent and a snippet of the instructions. The watchdog is created together with the issue.
- **Issue properties** — the **Watchdog** row sits next to **Monitor**. Empty state reads `Set watchdog`; configured state shows the watchdog agent icon and name plus a truncated instructions preview. Click the row to open the editor popover with an agent picker, an instructions textarea ("What should the watchdog watch for and how should it keep work moving?"), a **Remove** button, and a **Set watchdog** / **Update** button. When a watchdog run has produced a child review task, the row shows a small badge linking to that task.

### From the API

```http
GET    /api/issues/:issueId/watchdog
PUT    /api/issues/:issueId/watchdog   { "agentId": "...", "instructions": "..." | null }
DELETE /api/issues/:issueId/watchdog
```

`PUT` is upsert. `DELETE` disables the row (it is not hard-deleted; the table keeps the history for audit). All three routes require write access to the watched issue and produce activity records (`issue.watchdog_created`, `issue.watchdog_updated`, `issue.watchdog_removed`) with the run id and actor.

---

## How a scan works

Paperclip runs a watchdog reconciliation tick at server startup, at the end of each heartbeat cycle, and on demand after any mutation that could change the watched subtree (status, blockers, assignment, interactions). The tick is per-company and only walks active rows.

For each active watchdog the tick:

1. **Walks the watched subtree.** Starts at the configured issue and follows `parent_id` downward, excluding every issue whose `originKind = 'task_watchdog'` and everything below it. This excludes the watchdog's own review tasks so it cannot trigger itself.
2. **Checks for live paths.** If any included issue has a live run (`queued`, `running`, `scheduled_retry`), a queued wake request, or a scheduled retry, the subtree is **live** and the watchdog does not fire.
3. **Computes a stop fingerprint.** A SHA-256 hash over the stopped leaves' identifiers, statuses, blockers, pending interactions, and the current watchdog configuration. The configuration is part of the fingerprint, so changing the agent or instructions invalidates the previously reviewed state.
4. **Compares against `lastReviewedFingerprint`.** Match → suppress (the watchdog already saw this exact stopped state). New → proceed.
5. **Ensures a review task exists.** Creates (or reopens) one child issue with `originKind = 'task_watchdog'` and `originId = watchedIssueId`. Idempotent per watchdog — only one review task is ever live at a time.
6. **Wakes the watchdog agent.** Sends a wake with `wakeReason = task_watchdog_stopped_subtree`, the stop fingerprint, the leaf summaries, the default mandate, and any custom instructions. The idempotency key is `(watchdogId, stopFingerprint)`, so retries cannot stack duplicate wakes.

When the subtree changes between scans (someone restarts work, adds a blocker, or accepts an interaction) the stop fingerprint changes too, and the watchdog will be woken again for the new state — even if the previous run already disposed of an earlier fingerprint.

---

## What the watchdog agent does

On wake, the watchdog agent reads a fixed default mandate plus your custom instructions. The mandate explicitly tells it to:

- Treat every stopped leaf as a **claim** that must be verified against comments, documents, work products, screenshots, tests, blockers, and review state. Do not accept "I could not" or "waiting for approval" as automatically valid.
- Leave genuinely-complete leaves alone, with a short note on what was checked.
- If a leaf is not genuinely complete, restore a live path: reopen the issue, reassign, comment actionable instructions, create a follow-up child issue inside the watched subtree, or accept an eligible task-level plan confirmation.
- If the blocker is real, leave a valid waiting disposition that names the unblock owner and the next action.

The mandate also enforces safety constraints that custom instructions **cannot override**:

- Stay inside the watched subtree. No cross-company mutations, no mutations outside the watched issue and its non-watchdog descendants.
- No impersonating board-only approvals, accepting spend or hiring decisions, accepting security-sensitive interactions, or bypassing execution-policy stages that require a typed reviewer or approver.
- No creating another watchdog for the watched subtree. No waking itself. Exactly one reusable review task per watched issue.
- Custom instructions can narrow focus or veto specific shortcuts. They cannot grant authority the server does not already give the watchdog.

The formal authority contract (the full list of allowed and disallowed mutations, and the eligibility test for accepting plan confirmations) is in [`doc/SPEC-implementation.md`](SPEC-implementation.md) §9.9.

### Writing custom instructions

Custom instructions are most useful when they tell the watchdog what evidence to look at and what shortcuts to refuse. Examples:

> Before accepting any leaf as done, check that there is a corresponding green CI run linked in the comments. If there isn't, reopen the leaf and ask for one.

> Do not accept a `request_confirmation` plan that proposes more than five subtasks without first asking me to review. Leave the issue in review and ping me.

> If a leaf is blocked on the marketing team, accept the wait but make sure the unblock owner is named in the blocker reason.

What custom instructions cannot do: grant authority outside the watched subtree, approve board-level decisions, expand the interaction kinds the watchdog can resolve, or override safety constraints. The server enforces this regardless of what the instructions say.

---

## Scope enforcement

Every watchdog-originated mutation is gated by a server-side scope check derived from the agent run's `contextSnapshot.taskWatchdog` field. The check resolves to a `{ kind: "watchdog", watchdogId, companyId, watchedIssueId, watchdogIssueId }` envelope and rejects:

- mutations on issues outside the watched subtree (parent-chain walk, depth-limited)
- mutations on issues whose company id does not match the watchdog's company
- attempts to resolve interactions other than eligible task-level `request_confirmation` plan confirmations (see SPEC §9.9 for eligibility)
- changes to the watchdog configuration itself (a watchdog cannot edit its own row or create another watchdog)
- direct edits to active-run output or execution-policy decisions that require a typed participant

The check is wired into the issue update, status change, blocker, assignment, and interaction routes. Any disallowed mutation is rejected at the route layer; the watchdog agent must take a different path (comment, in-subtree follow-up issue, leave a valid waiting state, escalate to a human owner).

---

## Origin and badges

Watchdog-generated review tasks carry `originKind = 'task_watchdog'` and `originId = watchedIssueId`. The UI surfaces this in three places:

- The properties row on the watched issue shows a small **task badge** linking to the active review task whenever one exists.
- The review task itself carries an origin badge distinguishing it from manually created child issues.
- The board's audit activity feed labels every watchdog-driven mutation with the watchdog id, source issue id, watchdog issue id, run id, and stop fingerprint.

These origin markers are also what excludes the review task from future scans. The walk-down ignores them, so the watchdog cannot scan or trigger on its own review tasks.

---

## When not to use a watchdog

A task watchdog is useful when:

- the work has many leaves and you want a second pass before trusting "all green"
- the original assignee tends to declare done too fast, or accept plans you would not accept
- the tree is important enough that a missed false-stop is worth an extra agent run

It is **not** the right tool for:

- monitoring a single running process for silence — that is the silent active-run watchdog, automatic, no configuration
- liveness recovery on stalled agent-owned issues without an explicit recovery surface — that is automatic too
- board-level approvals or anything security-sensitive — the watchdog cannot resolve those
- replacing a human reviewer on a typed execution-policy stage — the watchdog cannot bypass typed participants

If what you actually want is "wake me when this is done," use a routine or an issue-thread interaction with `continuationPolicy: wake_assignee`, not a watchdog.

---

## Reference

| Topic                            | File                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| Authority contract (formal)      | [`doc/SPEC-implementation.md`](SPEC-implementation.md) §9.9           |
| Execution semantics (formal)     | [`doc/execution-semantics.md`](execution-semantics.md) §11           |
| Silent active-run watchdog       | [`doc/execution-semantics.md`](execution-semantics.md) §12           |
| Database schema                  | `packages/db/src/schema/issue_watchdogs.ts`                           |
| Server service                   | `server/src/services/task-watchdogs.ts`                               |
| Scope enforcement                | `server/src/services/task-watchdog-scope.ts`                          |
| Wake context + default mandate   | `packages/adapter-utils/src/server-utils.ts` (`WATCHDOG_DEFAULT_MANDATE`) |
| HTTP routes                      | `server/src/routes/issues.ts` (`GET/PUT/DELETE /issues/:id/watchdog`) |
| Properties UI                    | `ui/src/components/IssueProperties.tsx` (Watchdog row)               |
| New-issue dialog UI              | `ui/src/components/NewIssueDialog.tsx`                                |

---

And that's all folks!

```
              ,.
             (_|,.
            ,' /, )_______   _
         __j o``-'        `.'-)'
         (")                 \'
          `-j                |
            `-._(           /
               |_\  |--^.  /
              /_]'|_| /_)_/
                 /_]'  /_]'
```
