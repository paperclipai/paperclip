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
- [Authority contract](#authority-contract)
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

1. **Walks the watched subtree.** Starts at the configured issue and follows `parent_id` downward, excluding every issue whose `originKind = 'task_watchdog'` and everything below it. This excludes the watchdog's own review tasks so it cannot trigger itself. The scan includes at most 100 levels, with the watched issue at level 1. If an eligible child remains beyond that limit, the result is **incomplete**. Paperclip skips review dispatch and rejects watchdog mutation revalidation until it can read the full subtree. A leaf at level 100 does not by itself make the scan incomplete. Reconciliation reports these cases separately through `incomplete` and `incompleteIssueIds`. Startup and periodic reconciliation warn when a watched issue first becomes incomplete. The warning contains the newly affected issue IDs. An unchanged incomplete issue does not produce repeated warnings. Once a successful scan no longer reports that issue as incomplete, a later incomplete scan can warn again.
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
- If a leaf is not genuinely complete, restore a live path: reopen the issue, reassign, comment actionable instructions, create a follow-up child issue inside the watched subtree, or resolve an interaction that the ordinary agent audience permits.
- If the blocker is real, leave a valid waiting disposition that names the unblock owner and the next action.

The mandate also enforces safety constraints that custom instructions **cannot override**:

- Stay inside the watched subtree. No cross-company mutations, no mutations outside the watched issue and its non-watchdog descendants.
- No impersonating formal approvals, accepting spend or hiring decisions, using an interaction response as downstream authority, or bypassing execution-policy stages that require a typed reviewer or approver.
- No creating another watchdog for the watched subtree. No waking itself. Exactly one reusable review task per watched issue.
- Custom instructions can narrow focus or veto specific shortcuts. They cannot grant authority the server does not already give the watchdog.

The formal authority contract (the full list of allowed and disallowed mutations) is in [Authority contract](#authority-contract) below. The ordinary interaction resolver contract is in [execution semantics](execution-semantics.md#issue-thread-interaction-resolution).

### Writing custom instructions

Custom instructions are most useful when they tell the watchdog what evidence to look at and what shortcuts to refuse. Examples:

> Before accepting any leaf as done, check that there is a corresponding green CI run linked in the comments. If there isn't, reopen the leaf and ask for one.

> When an interaction is `not_creator` or `human_only`, preserve that restriction. Do not treat the watchdog role as an override.

> If a leaf is blocked on the marketing team, accept the wait but make sure the unblock owner is named in the blocker reason.

What custom instructions cannot do: grant authority outside the watched subtree, approve formal governance decisions, widen an interaction's resolver audience, or override safety constraints. The server enforces this regardless of what the instructions say.

---

## Scope enforcement

Every watchdog-originated mutation is gated by a server-side scope check derived from the agent run's `contextSnapshot.taskWatchdog` field. The check resolves to a `{ kind: "watchdog", watchdogId, companyId, watchedIssueId, watchdogIssueId }` envelope and rejects:

- mutations on issues outside the watched subtree (parent-chain walk, depth-limited)
- mutations on issues whose company id does not match the watchdog's company
- interaction resolution outside the ordinary effective audience, named addressee, company/issue scope, run-attribution, low-trust/task-bridge, target-staleness, or exact-once checks
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
- formal approvals or security-sensitive downstream actions — an interaction response cannot authorize those
- replacing a human reviewer on a typed execution-policy stage — the watchdog cannot bypass typed participants

If what you actually want is "wake me when this is done," use a routine or an issue-thread interaction with `continuationPolicy: wake_assignee`, not a watchdog.

---

## Authority contract

A task watchdog is a scoped execution capacity for a configured watchdog agent on one watched issue subtree. It is not a separate principal, does not inherit board auth, and does not expand the selected agent's company boundary. The server must enforce the watchdog contract from persisted watchdog configuration and run context; custom instructions and prompt text can narrow the mandate but cannot expand it.

The watched subtree is the source issue plus descendants reached through `parent_id`, excluding every issue whose `origin_kind = 'task_watchdog'` and excluding all descendants below those watchdog issues. The generated reusable watchdog issue is outside the watched work subtree for scan purposes, but the watchdog agent may update that reusable watchdog issue to record its own review disposition.

Task-watchdog wakes must include server-derived capability metadata that names the watched root, reusable watchdog issue, excluded `task_watchdog` origin branches, allowed operations, and denied operations. Watchdogs must use that metadata and server denials for capability discovery; they must not create visible probe issues, comments, or throwaway tasks to learn their permissions.

### Allowed watchdog mutations

Within the watched subtree, a watchdog run may perform only mutations that restore or clarify the next live/waiting path:

- add comments that explain findings, evidence, and next action
- create descendant follow-up issues under an included subtree issue, inheriting company, project, goal, and workspace strategy from that subtree; each follow-up gets its own execution workspace
- assign or reassign included issues to active, invokable, same-company agents when normal assignment checks and scoped assignment grants allow it
- move included issues among `todo`, `in_progress`, `in_review`, and `blocked` when the transition is needed to restore a valid action path
- reopen `done` or `cancelled` included issues only with explicit resume metadata and an audit comment when evidence shows the stopped disposition is wrong or incomplete
- add, replace, or clear blockers on included issues when the blocker target is in the same company and the change makes the waiting path more accurate
- set or refresh a one-shot monitor on an included issue when the current assignee owns the future check
- resolve issue-thread interactions through the ordinary resolver-audience path
  when the watchdog agent otherwise has issue access and the effective policy allows it
- update the reusable watchdog issue itself to `done`, `in_review`, or `blocked` with the evidence for the watchdog decision

Every watchdog-triggered mutation must write activity with the watchdog id, source issue id, watchdog issue id when present, run id, and stop fingerprint. Mutations still use the normal status-transition, blocker, assignment, budget, and company-boundary guards.

The atomic recovery batch, restoration verification and escalation, and interaction
resolution rules for watchdog runs are in
[execution semantics §11](execution-semantics.md#11-task-watchdog-for-issue-trees).

### Disallowed watchdog mutations

A task watchdog must not:

- mutate issues outside the watched subtree, except for comments or newly created follow-up issues that are children of included subtree issues
- mutate company, project, goal, agent, auth, API key, budget, secret, environment, plugin, or deployment settings
- approve or reject rows in the `approvals` table, including hiring, CEO strategy, spend, budget override, or `request_board_approval` decisions
- resolve execution-policy decisions unless the watchdog agent is the typed participant under that policy outside of its watchdog capacity
- force-release checkout/execution locks, cancel active runs, terminate processes, or perform active-run output watchdog decisions
- create visible probe issues, comments, or throwaway tasks to discover whether an operation is allowed
- delete issue documents, comments, attachments, work products, or activity records
- change the watchdog configuration, select a different watchdog agent, or create nested watchdog configurations
- treat custom instructions as authority to bypass approval gates, cross company boundaries, access secrets, or override this contract

When the safe next action needs one of these disallowed mutations, the watchdog must leave a valid waiting path by commenting, creating an in-subtree escalation/follow-up issue, assigning to the correct owner, or leaving the source issue blocked on a first-class blocker.

### Deferred capabilities

Deliberately deferred and disallowed for the first implementation: letting watchdogs cancel active runs, approving board/governance actions, mutating outside the watched subtree, or allowing watchdog agents to modify their own watchdog configuration. Any expansion of those capabilities requires a new product/security review.

---

## Reference

| Topic                            | File                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| Authority contract (formal)      | [Authority contract](#authority-contract) (this doc)                  |
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
