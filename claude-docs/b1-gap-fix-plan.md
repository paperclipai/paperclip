# B1 Gap-Fix Plan — make the factory actually follow the protocol

> Written 2026-06-13 after the first B1 pilot run. The pilot proved the
> *machinery* (plan → activate → gates → budget → model tiering) materializes
> correctly, but the *agent behavior* bypassed the entire dev-team protocol and —
> critically — an agent wrote into the operator's real working clone. This plan
> fixes the gaps in priority order. Each fix is grounded in the code path that
> caused it. Build through `/dev-roles`, safety items first.
>
> Source evidence: `pilot-log.md` (deviations 1–11). This doc = the remediation.

---

## Root cause (one sentence)

The run never went **assign → in_progress → worktree realized → implement →
push → PR**; instead the CTO, in a single heartbeat, created a child,
self-assigned, implemented inline **in the project primary workspace (= the live
clone)**, and marked it done — because **none of those steps are enforced**:
isolation is best-effort, delegation is advisory, and soft gates bypass agents
entirely.

### The four enforcement holes (grounded)

| # | Hole | Where | Effect |
|---|---|---|---|
| H1 | Isolation is best-effort | `workspace-runtime.ts:1104-1116` silently returns `strategy:"project_primary"`, `cwd = baseCwd` (the real clone) when a worktree isn't realized. No guard in `heartbeat.ts:8157-8167` rejects a project_primary cwd when the policy mandates `git_worktree`. | Agent wrote to `~/sourceControl/paperclip`. |
| H2 | Worktree only realizes for a leaf issue that gets a **run** via in_progress+assignee | `routes/issues.ts:5514-5537` queues a wakeup only on assignee-change or backlog/blocked/closed→todo; a `todo→done` self-assigned transition realizes nothing (`heartbeat.ts:8157` never runs for that issue). | HIV-9 got no worktree; CTO ran on HIV-7 in the primary clone. |
| H3 | Delegation is advisory | `.agents/dev-team/agents/cto/AGENTS.md` says "you do not write code" but nothing **gates** it; no rule "assign child to an Implementor + move to in_progress, then stop." | CTO acted as solo dev. |
| H4 | Soft gates bypass agents | `issue-stage-machine.ts:45` `if (ctx.actorType !== "user") return { allowed: true }`. No guard blocks an agent `done` with pending gates or null `pr_url`. | `done` reached with all 3 gates pending. |

---

## Fix 1 — P0 SAFETY: enforce worktree isolation; agents never write the live clone

**Goal:** under a `git_worktree` project policy, an agent run MUST execute in a
realized worktree. If one can't be realized, **fail the run closed** — never fall
back to the project primary workspace cwd.

**Changes**
1. `server/src/services/workspace-runtime.ts:1104-1116` — when the requested
   strategy is `git_worktree` but realization can't produce one, do **not** return
   `strategy:"project_primary"` with `cwd = baseCwd`. Return an explicit
   `strategy:"unrealized"` / throw a typed error carrying the reason.
2. `server/src/services/heartbeat.ts` (after `realizeExecutionWorkspace()` at
   `:8157-8167`) — add the missing guard:
   ```
   if (projectPolicy?.workspaceStrategy?.type === "git_worktree"
       && executionWorkspace.strategy !== "git_worktree") {
     throw isolationViolation(issueId, executionWorkspace.cwd);
   }
   ```
   Fail the run with a clear status; do **not** spawn the adapter in `baseCwd`.
3. **Plan-root issues never get a writable repo cwd.** The CTO orchestrates — it
   should never have the live clone as cwd. Plan-root (orchestration) runs get a
   throwaway scratch dir (the existing `resolveDefaultAgentWorkspaceDir(agent.id)`
   fallback at `heartbeat.ts:4372`), NOT the project primary workspace. Gate the
   primary-workspace cwd path to leaf, in_progress, implementor-assigned issues
   only.
4. **Operator config rule (immediate, no code):** never point a project's primary
   project-workspace at a clone you care about. For dogfood, branch worktrees from
   a **dedicated throwaway clone**, not `~/sourceControl/paperclip`.

**Tests** (`server/src/__tests__/`)
- git_worktree policy + unrealizable worktree → run fails closed; adapter never
  invoked with `baseCwd`.
- Plan-root run resolves to a scratch dir, not the primary workspace.
- Leaf issue in_progress+implementor → worktree realized, cwd = worktree path.

**Acceptance:** no code path hands an agent a cwd equal to a real clone under a
git_worktree policy. Verified by a test asserting the thrown isolation error.

---

## Fix 2 — P0: CTO delegates, cannot implement; work the materialized children

**Goal:** the CTO assigns each plan child to an Implementor and moves it to
`in_progress` (which triggers Fix-1 worktree provisioning via H2's run path),
then stops. It never edits files. It works the **already-materialized** children
(no duplicate creation).

**Changes**
1. `.agents/dev-team/agents/cto/AGENTS.md` — add a hard, unambiguous contract:
   - "The plan's first-tier child issues **already exist** (materialized at
     activation). Do **not** create new children — find and assign the existing
     ones."
   - "For each child: `paperclipUpdateIssue({ issueId, status: 'in_progress',
     assigneeAgentId: <implementor> })`. Then **stop**. Implementation is the
     Implementor's job."
   - "You have no implementation mandate. If you find yourself about to edit a
     file, that is a protocol violation — stop and assign instead."
2. Reconcile **HIV-8 vs HIV-9** (deviation #10): pick one child model. Recommended:
   keep activation's materialized children and make the CTO assign them. (Alt:
   stop pre-materializing in `plans.ts` activate and let the CTO create — more
   work, more drift. Reject.)
3. Re-sync the managed instruction bundle to the running agents
   (`server/src/services/agent-instructions.ts` managed path /
   `.agents/dev-team` install/import) so the new contract is live before re-run.
4. Implementor AGENTS.md already wired for `paperclipPushBranch` /
   `paperclipOpenPullRequest` (A6) — confirm it instructs: implement in the
   worktree → commit → call the push tool → call the PR tool → move to `in_review`.

**Tests / verification**
- Bundle-sync produces the new CTO AGENTS.md for the agent (managed instructions
  read-back).
- Dry assertion (manual on re-run): CTO assigns HIV-8 to an Implementor and
  transitions it to in_progress; creates no new child; edits no file.

**Acceptance:** on re-run, the CTO's run touches issue state only (assign +
in_progress), never the filesystem; the Implementor does the code in a worktree.

---

## Fix 3 — P1: hard `done`-guard for dev_team issues (interim C1, narrow)

**Goal:** an **agent** cannot move a dev_team-gated issue to `done` unless it has
an open PR and its review gates are decided. User/board can override (and it's
logged). This makes "done" earned, not skippable. Narrow slice of roadmap C1 —
only the done-transition, not activation.

**Changes**
1. New guard in `server/src/routes/issues.ts` after the stage-machine check
   (`~:4905`), before `assertAgentInReviewReviewPath` (`:4907`). Pattern-match the
   existing `assertAgentInReviewReviewPath` guard (`:1507-1531`, throws
   `unprocessable`).
   - Applies only when: `actor.actorType === "agent"` (via `getActorInfo`,
     `authz.ts:77-94`) AND `effectiveTargetStatus === "done"` AND the issue's
     `planRootIssueId` resolves to a `planDetails.gateProfile === "dev_team"`
     (lookup pattern already at `issues.ts:5334-5342`).
   - Reject if `existing.prUrl` is null → `unprocessable("dev_team issue requires
     an open PR before done", { code: "missing_pr" })`.
   - Reject if any `gate_code_review` / `gate_wiring_review` approval for the plan
     is `pending`/`rejected` → `unprocessable("review gates not passed", { code:
     "gates_pending" })`. Query via `approvals.list(companyId, undefined,
     planRootIssueId)` (`approvals.service.ts:83-92`), filter gate types
     (`plan-gates.ts` `GATE_DESIGNATED_URL_KEY` keys).
2. **User/board override is allowed** (actor !== agent) → on a done that would have
   failed the agent guard, write `issue.gate_overridden` activity
   (`activity-log.ts:53-63` `logActivity`) with the unmet conditions in `details`.
3. Gate it on `gateProfile === "dev_team"` so `none` plans are unaffected (parity).

**Tests** (`server/src/__tests__/`)
- agent done blocked: pending code/wiring gate → 422 `gates_pending`.
- agent done blocked: null pr_url → 422 `missing_pr`.
- agent done allowed: PR present + both gates approved.
- user/board done allowed with pending gates → succeeds + `gate_overridden` logged.
- `gateProfile:"none"` issue → no guard (existing behavior).

**Acceptance:** the exact bypass the pilot hit (agent done, gates pending, no PR)
returns 422; operator override still works and is audited.

---

## Fix 4 — P1: hold auto-heartbeat during setup

**Goal:** "armed-idle" is actually idle. Today a 30s `setInterval`
(`index.ts:766`, `HEARTBEAT_SCHEDULER_ENABLED`/`heartbeatSchedulerIntervalMs`,
`config.ts:332-333`) auto-runs agents — it woke an agent on HIV-6 with no manual
wake and burned ~$0.89.

**Changes (pick minimal first)**
1. **Immediate (no code):** run the pilot server with
   `HEARTBEAT_SCHEDULER_ENABLED=false`; wake agents only with explicit
   `agent wake`. OR pause the company (`companies.status` + `pausedAt`) /
   per-agent (`agents.status="paused"`, checked at `heartbeat.ts:7035, 9316`)
   during setup, un-pause when ready.
2. **Optional UX (later):** a board/CLI "hold company" toggle wrapping the company
   pause fields, so setup doesn't require an env restart.

**Acceptance:** with the scheduler held, zero runs occur until an explicit wake;
documented in the runbook.

---

## Fix 5 — P2: cleanup (the small deviations 3–5)

Bundle into one low-risk PR:
- **Plan-root `projectId`** (#3): add `plan create --project <id>` to the CLI and
  default to the company's primary project, so worktree+gitOps resolve without a
  manual `issue update`.
- **`plan create --json`** (#5): always print a clean id object so a created plan
  can't be mistaken for a failure (prevents the duplicate-plan trap).
- **Activate response projection** (#4): `POST /plans/:id/activate` should return
  the real `createdChildren` + `gateApprovalIds` (cosmetic; the data is correct).

**Acceptance:** one `plan create --project` call yields an activatable, repo-linked
dev_team plan with no manual issue patching; activate echoes its children.

---

## Sequencing

```
Fix 1 (isolation, P0)  ─┐
                         ├─► both land before ANY re-run (stop the safety hole + solo-dev)
Fix 2 (delegation, P0) ─┘
        │
        ▼
Fix 3 (hard done-guard, P1)   ◄ makes the pipeline non-skippable
        │
        ▼
Fix 4 (heartbeat hold, P1)    ◄ control during the next setup
        │
        ▼
Fix 5 (cleanup, P2)           ◄ removes the operator foot-guns
        │
        ▼
B1 re-run (second pilot)      ◄ expect: assign → worktree → implement → push → PR → gates → done
```

Each of Fix 1–3 is a `/dev-roles` task (plan → architect → implement → code +
wiring review). Fix 1 + Fix 2 are the gate to a second run — **do not re-run B1
until both land**, because without Fix 1 an agent can still write your real repo.

## Definition of done for the remediation

- A git_worktree-policy agent run cannot execute in a non-worktree cwd (Fix 1
  test green).
- On a re-run, the CTO assigns and stops; the Implementor produces the code in a
  worktree and opens a PR; the agent cannot mark `done` until gates pass + PR
  exists (Fix 3 test green).
- Auto-heartbeat can be held for a clean, deterministic setup (Fix 4).
- `plan create --project` produces a one-shot, repo-linked, activatable plan
  (Fix 5).
- Second B1 pilot reaches: PR on the fork, both review gates decided by the right
  agents, cost attached, human action = merge only — the original B1 success
  criteria, this time actually earned.
