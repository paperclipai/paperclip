---
title: Runtime Runbook
summary: Shared operating guide for agent bootstrap, task flow, review dispatch, routines, and troubleshooting
---

This is the operator runbook for the current Paperclip runtime. Use it when setting up agents, choosing workspace policy, or diagnosing why work is not moving. If this guide and runtime behavior ever disagree, trust the code in `server/src/services` and `packages/shared/src/constants.ts`.

## Source Documents

Keep these open while operating the system:

- [Managing Agents](/guides/board-operator/managing-agents)
- [macOS background service (LaunchAgent)](/guides/board-operator/macos-background-service)
- [Managing Tasks](/guides/board-operator/managing-tasks)
- [Agent Runtime Guide](/agents-runtime)
- [Adapters Overview](/adapters/overview)
- [Issues API](/api/issues)
- [Agents API](/api/agents)
- [Routines API](/api/routines)

## 1. Bootstrap Rules For Managed Agents

For managed local adapters, a healthy agent now requires the same four bootstrap files in two places:

- inside the managed instructions bundle
- inside `$AGENT_HOME`

Required files:

- `AGENTS.md`
- `HEARTBEAT.md`
- `SOUL.md`
- `TOOLS.md`

Additionally, the server ensures `$AGENT_HOME/memory/YYYY-MM-DD.md` exists for the **local calendar date** of the Paperclip process when the file is missing (stub with “Today's Plan” and “Timeline” headings). That happens during managed-agent bootstrap validation and again at the start of each heartbeat run, so default `HEARTBEAT.md` steps that read the daily note do not hit a missing file on a fresh agent home.

When the Paperclip process restarts, in-memory tracking of local adapter children is lost. If the database still shows a run as `running` with a live OS pid, startup recovery **sends SIGTERM** to that pid, marks the run `failed` (`process_lost` with `orphan_terminated`), applies the usual process-loss retry rules, and resumes `queued` runs for that agent. Periodic recovery does the same after a run has stayed `process_detached` long enough (aligned with the stale threshold), so the agent queue cannot stall forever on a zombie `running` row.

If the run never had a recorded `processPid` (restart happened before spawn metadata was written), startup still classifies the row as **`server_restart`** `process_lost` and **enqueues the same single automatic retry** as for a known stale pid, so the agent is not left dead-ended.

This integrity check applies to these adapter types:

- `claude_local`
- `codex_local`
- `cursor`
- `gemini_local`
- `opencode_local`
- `pi_local`

Operational rules:

- Run "Test environment" before saving agent config changes.
- Agent create/update is blocked when the environment test returns errors or blocking warnings.
- Broken bootstrap is now treated as an operational fault and surfaced as an auto-managed health alert issue.

## 2. Supported Adapter Families

| Adapter type | Use it for | Notes |
| --- | --- | --- |
| `claude_local` | Local Claude Code workers | Host CLI must be installed and authenticated |
| `codex_local` | Local Codex workers | Persists sessions; uses isolated `CODEX_HOME` inside managed worktrees |
| `gemini_local` | Local Gemini workers | Same heartbeat/runtime model as other local CLIs |
| `opencode_local` | Local OpenCode workers | Model list is discovered live in `provider/model` format |
| `openclaw` | External OpenClaw agents | Use for remote agent onboarding and webhook delivery |
| `process` | Scripts, probes, non-LLM workers | Good for deterministic local commands |
| `http` | External HTTP executors | Use when Paperclip should call a remote service |

Use local coding adapters for agents that need repo context and filesystem access. Use `process` or `http` when the task is operational automation instead of interactive coding.

## 3. Workspace And Worktree Policy

Paperclip now separates "where this task runs" from raw adapter `cwd`.

Default model:

- `shared_workspace` uses the project's primary workspace
- `isolated_workspace` uses a derived execution workspace, usually `git_worktree`
- `agent_default` leaves workspace handling to the adapter/runtime

Current guardrails:

- The `git_worktree` strategy is only meaningful when isolated workspaces are enabled.
- A `git_worktree` policy must resolve from a real project git checkout. If the project workspace is not a git repo, the heartbeat fails early with `execution_workspace_policy_violation`.
- Issue-level workspace settings may override the project default when enabled, but should still stay inside the declared workspace strategy rather than ad hoc `cwd` edits.

Codex-specific notes:

- When `PAPERCLIP_IN_WORKTREE=true`, `codex_local` switches to a worktree-isolated `CODEX_HOME` so skills, sessions, and logs do not leak across checkouts.
- Unscoped heartbeats (no issue/task in the run context) do **not** resume the last Codex thread from agent runtime state, so idle timer wakeups are less likely to burn tokens replaying a huge session. Scoped work still resumes per-task sessions as usual.
- Prefer explicit per-agent model config; managed roles default to **OpenCode + Minimax M2.5 (free)** via `pnpm rollout:codex-presets -- --apply` (use `--apply --all-agents` for every `opencode_local` / `codex_local` agent) — see [Agent Runtime Guide](/agents-runtime).
- If Codex subscription quota is exhausted, the Costs UI may suggest the same OpenCode fallback model id; rollouts also use `pnpm rollout:opencode-from-codex-quota` (same script behavior).
- To compare the latest heartbeat `usageJson.model` to config, run `pnpm audit:agent-models` (see [Agent Runtime Guide](/agents-runtime)).

## 4. Issue Lifecycle And Ownership

Current lifecycle:

```text
backlog -> todo -> claimed -> in_progress -> handoff_ready -> technical_review -> human_review -> done
              \______________________________/                     \-> changes_requested -/
                                       \-> blocked                          \-> blocked
```

Key rules:

- Enter `in_progress` from `todo`, `blocked`, or `changes_requested` via `POST /api/issues/{id}/checkout`.
- `claimed -> in_progress` is allowed after the issue is already explicitly claimed.
- Legacy `in_review` data is treated as `handoff_ready`.
- Do not checkout `handoff_ready`, `technical_review`, or `human_review` just to add operational context; leave a comment without reopening the execution lane.

The UI now exposes `currentOwner`, which answers "who acts now" instead of just "who is assigned":

- `handoff_ready`: the technical reviewer child issue, if one exists; otherwise an unassigned technical-review queue
- `human_review`: the board by default, or the explicit human/user assignee when set
- other active states: the assignee agent or user

This keeps the assignee field stable while still showing who should move the issue next.

**Agent inbox (`GET /api/agents/me/inbox-lite`):** includes assignments in `todo`, `in_progress`, **`handoff_ready`**, `changes_requested`, `claimed`, and `blocked`, sorted so **`in_progress`** comes first, then **`handoff_ready`** (executors can see stuck handoffs / dispatch noops without a separate query), then rework and new work (priority, then **`createdAt`** ascending within the same status and priority). Technical review work for reviewers still usually arrives as **child** issues in `todo` / `in_progress` / `changes_requested`.

## 5. Technical Review Dispatch

Moving a source issue to `handoff_ready` can dispatch technical review automatically.

Current dispatch contract:

- **Reviewer** resolution order:
  - Company field `technicalReviewerReference`
  - Env `PAPERCLIP_TECHNICAL_REVIEWER_REFERENCE`
  - Default agent name reference `revisor-pr`
- **Where to set the company field:** board **Company Settings** → *Technical review*, or PATCH `/api/companies/{companyId}`.
- **Operator recommendation (important):** set `technicalReviewerReference` explicitly via board for every active company. Keeping it unset makes dispatch depend on env/default references and increases the chance of no-op dispatches (`reviewer_not_found` / `reviewer_ambiguous`).
- **Match rule:** the resolved reference must match a single non-terminated agent in the company.
- **Ambiguity:** when multiple agents match the resolved reference (e.g. duplicate name slugs), dispatch is a noop with reason `reviewer_ambiguous`.
- **PR URLs** are parsed for **github.com** only (`owner/repo/pull/n`); other hosts are not auto-dispatched—attach a GitHub work product or link in handoff text, or create review issues manually.
- PR context is resolved in this order:
  1. attached work product of type pull request
  2. the **`comment` body on the same `PATCH`** that leaves the issue in `handoff_ready`, if it contains a GitHub PR URL (no `# Handoff` / `@revisor pr` required)
  3. recent issue comments (newest-first, up to 20): prefer comments with explicit handoff markers (`# handoff`, `@revisor pr`) or no-new-diff phrases; otherwise the **newest** comment that contains a GitHub PR URL
  4. source issue description containing a GitHub PR URL
- Review children are created with `originKind='technical_review_dispatch'`.
- Dedup uses the current diff identity:
  - preferred: repository + PR number + head SHA
  - fallback: repository + PR number + handoff comment or description identity
- When a handoff comment carries an explicit head marker such as `Head: abc1234`, Paperclip now promotes that comment to head-based diff identity even if the pull-request work product is missing or late.

Practical effect:

- same PR, new diff: a new review ticket can be opened
- same PR, same diff: the dispatcher reuses or reports the existing review ticket
- same PR, same code but a restored handoff comment explicitly says there was no new code/commit/push: the dispatcher treats it as the same diff and does not open a duplicate review ticket
- same PR, same explicit head SHA repeated in a new handoff comment: the dispatcher treats it as the same reviewed diff and does not open a duplicate review ticket
- when the dispatcher lands on `already_reviewed` for a completed review child, Paperclip now tries to self-heal the source issue immediately instead of waiting for a coordinator reconciliation pass
- no PR reference: dispatch is a no-op and the operator must attach or mention the PR explicitly (activity `issue.review_dispatch_noop` with `reason` is logged for `reviewer_not_found`, `reviewer_ambiguous`, and `pull_request_not_found`)
- when the review child is closed with blocking findings, Paperclip requeues the source issue for the assigned executor and restores it to `in_progress`
- when the review child is closed without blocking findings, Paperclip advances the source issue to `human_review`
- **Unparsed or ambiguous review summaries:** if the free-text summary does not match the classifier (`server/src/services/technical-review-outcome.ts`), the source issue **stays** in its current state; the server emits a **warn** log and activity **`issue.review_outcome_unparsed`** on the review child. Operators should fix the summary wording (see `doc/plans/2026-04-05-review-outcome-classification-matrix.md`) or move the parent manually; monitor unparsed rates when the Revisor template changes.
- this reconciliation also works when the reviewer posts the summary comment first and closes the review child in a later separate update
- manual child issues titled like `Revisar PR #... de ...` are reconciled the same way as dispatched review children, which helps clean up historical/manual review tickets
- when the source issue's pull-request work product is later updated to `merged` (or `closed` with merge metadata), Paperclip auto-reconciles the source issue to `done` and cancels any still-open technical-review child tickets for that PR
- **PR merge auto-complete integrity:** parent transitions to `done` and cancellation of open review children (`technical_review_dispatch` or legacy `Revisar PR #…` titles) are applied in **one database transaction**. If that transaction fails, no issue row reaches `done` while children stay active in the same attempt—retry the work-product update or PATCH again (idempotent once merged). **After** commit, routine run sync and the `issue.updated` activity log run separately; if those fail, check server logs for `routine sync failed after PR merge auto-complete` or `PR merge auto-complete transaction failed`, verify routine execution rows, and confirm whether `issue.updated` with `autoCompletedFromPullRequest` is missing for auditing.

### Direct merge eligible (executor + GitHub)

Use this when you want **technical review** to stay the gate in Paperclip, but the **merge on GitHub** to happen without the board clicking merge—subject to branch protection and (when enabled) CI.

**Contract**

- **GitHub PR body** must contain the HTML comment marker `<!-- direct_merge_eligible -->` (matching is case-insensitive; convention for humans and for the optional GitHub Action).
- **Paperclip** only schedules an executor wake when the primary pull-request work product has **`metadata.directMergeEligible: true`** (boolean). Set this when creating or updating the work product via `POST /api/issues/{id}/work-products` or `PATCH /api/work-products/{id}` so the server does not scrape PR bodies.

**Paperclip behavior**

- After a technical review child closes **approved** and the parent reaches **`human_review`**, if the linked PR is not draft and `directMergeEligible` is true, the server wakes the **parent assignee** (typically the executor, e.g. Claudio) with payload `mutation: "review_approved_merge_delegate"` and a `contextSnapshot` that includes `pullRequestUrl`, `pullRequestNumber`, and `workProductId`. If that wakeup throws (budget, paused agent, wake policy), an activity entry **`issue.merge_delegate_wakeup_failed`** is recorded on the parent issue.
- The executor should merge with `gh` (or rely on the GitHub Action below), then **`PATCH` the work product** to merged state so the issue auto-completes (see [Issues API](/api/issues) lifecycle notes).

**GitHub Action**

- Workflow `.github/workflows/direct-merge-eligible.yml` runs after the **`PR`** workflow succeeds on a pull request targeting **`master`**. If the PR body contains `<!-- direct_merge_eligible -->` (case-insensitive), the PR is not draft, and the base is `master`, it runs `gh pr merge --auto --squash`.
- **Billing / Actions off:** if organization workflows do not run, this job never fires; use the executor wake path and local `gh` only.
- **Avoid double merge:** pick one primary path per team—either enable the Action **or** have the executor run `gh pr merge`, not both racing the same PR.

## 6. Routines And Compensation Loops

Use routines for recurring operational work, not as a substitute for missing issue transitions.

Rules that matter in practice:

- Agents can only create and manage routines assigned to themselves.
- Board operators can create or reassign routines for any agent.
- `coalesce_if_active` is the safest default for periodic nudges.
- `always_enqueue` is only appropriate when every trigger must become its own issue/run.

Recommended pattern:

- use assignment/comment wakes for normal task execution
- use scheduled routines for reconciliation, backlog opening, health sweeps, and other recurring control-plane work
- retire compensation routines once the runtime gains a first-class automation path

## 7. Health Monitoring And Observability

Two runtime signals matter most when you are operating the system:

### Agent health alerts

The native health monitor now creates or reuses corrective issues with `originKind='agent_health_alert'` when it detects:

- broken company membership or permissions
- stale heartbeat activity
- queue starvation
- adapter/runtime state mismatch
- managed bootstrap integrity failures
- adapter `testEnvironment` regressions

When the underlying problem disappears, the alert is automatically cancelled.

To reduce alert churn, non-review-queue agent health alerts now use a short reopen cooldown after auto-cancellation. If the same transient condition flaps again immediately, Paperclip suppresses the reopen instead of bouncing the same alert issue open/closed within minutes.

### Operational effect per run

Heartbeat runs now expose `operationalEffect`, which answers whether a completed run changed anything meaningful.

Signals include:

- comments
- status changes
- handoffs
- assignment changes
- checkouts
- document updates
- work product updates
- approvals
- issue creations

Interpretation:

- `Effect`: the run produced at least one meaningful mutation
- `No effect`: the run finished but only read state, coalesced, or exited without changing anything material

Activity logs also surface review-dispatch dedup signals. Reused/already-reviewed dispatches now include `duplicatePrevented=true` and a `dedupReason`, which helps separate healthy dedup from accidental review churn.

The dashboard's Operational Observability panel now rolls these last-24-hour signals up into two explicit counters:

- `Review Dedup (24h)`: repeated review dispatches that were prevented before creating churn
- `Alert Suppressions (24h)`: transient health alerts whose reopen was intentionally suppressed during cooldown

This is the fastest way to separate "the process ran" from "the system actually moved."

## 8. Troubleshooting

| Symptom | Likely cause | Operator action |
| --- | --- | --- |
| `409 Conflict` on checkout | Another run or agent already owns the issue | Do not retry. Move to another assignment or wait for the owning run to finish |
| Run fails with `execution_workspace_policy_violation` | `git_worktree` policy resolved from a non-git project workspace | Fix the project primary workspace first, then rerun |
| Health alert for `bootstrap_integrity` | Required bootstrap files are missing in bundle or `$AGENT_HOME` | Rebuild the managed instructions bundle and restore `AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, `TOOLS.md` |
| Issue reaches `handoff_ready` but no review ticket appears | No reviewer agent reference or no PR artifact could be resolved | Ensure `revisor-pr` exists and attach a pull-request work product or handoff comment with the GitHub PR URL |
| Routine creation fails for another agent | Agents cannot manage routines assigned to others | Create or reassign the routine as the board, or have the target agent own the routine |
| Run shows `No effect` | The heartbeat completed without operational mutations | Check the run log and issue comments; this may be valid for no-op triage or a sign the prompt is not driving action |

## 9. Minimal Operating Checklist

When the system feels off, verify these in order:

1. Agent config passes "Test environment".
2. Managed agents have all four bootstrap files in bundle and `$AGENT_HOME`.
3. Project workspace policy matches the repo reality, especially before enabling `git_worktree`.
4. The issue state is valid for the intended next action (`checkout`, `handoff_ready`, review, or human review).
5. The expected reviewer/worker agent exists and is not paused.
6. The latest run produced `Effect`; if not, read the run log before changing more config.
