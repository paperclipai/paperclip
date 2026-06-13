# B1 Pilot — Bug Report

> Every defect found and fixed during the first dev-team-factory dogfood (B1)
> and its remediation, 2026-06-13 → 2026-06-14. Branch `pilot/b1-dogfood`.
> Each entry: symptom → root cause (with `file:line`) → fix → commit → how it was
> verified. Severity: 🔴 critical (safety/security) · 🟠 high · 🟡 medium · ⚪ low.

The pilot itself was the test. It proved the *machinery* (plan → activate → gates
→ budget → model tiering) materializes correctly, but surfaced 10 defects in the
*config plumbing* and *agent behavior* — most never exercised before because no
real task had run end-to-end.

---

## Summary

| # | Severity | Title | Commit |
|---|---|---|---|
| 1 | 🟠 | git-ops policy unwritable (strict schema rejected `gitOps`) | `42cac7c7` |
| 2 | 🟠 | git-ops policy stripped on read (hand-rolled parser) | `42cac7c7` |
| 3 | 🔴 | Agent ran in the operator's live clone (no worktree isolation) | `a3630ac9` |
| 4 | 🟠 | CTO acted as solo dev — no delegation, duplicate child | re-sync¹ |
| 5 | 🔴 | Implementor contract used the forbidden `gh` + `env.GITHUB_TOKEN` path | re-sync¹ |
| 6 | 🟠 | Soft gates bypassable — agent closed an issue with no PR + pending gates | `145162d9` |
| 7 | 🟡 | `plan create` couldn't set a project → worktree/git-ops unresolvable | `a16dcd05` |
| 8 | ⚪ | Activate response omitted `gateApprovalIds` | `a16dcd05` |
| 9 | 🟡 | `plan create` silent success → duplicate plan | `a16dcd05` |
| 10 | 🟡 | Auto-heartbeat not held during setup → unwanted runs + burn | docs² |

¹ The dev-team AGENTS.md bundles are gitignored vendored config; the operative
fix is the re-sync to the running agents via `PUT /agents/:id/instructions-bundle/file`.
² The hold mechanism already existed (company pause); the fix is procedure, not code.

---

## 1 — 🟠 git-ops policy unwritable

- **Symptom:** `project create --execution-workspace-policy-json '{… "gitOps": …}'`
  returned `unrecognized_keys: ['gitOps']`; the fork remote / base / token-secret
  could not be persisted, leaving git-ops unconfigurable.
- **Root cause:** A6 added `git-ops.ts` reading `executionWorkspacePolicy.gitOps`
  (`server/src/services/git-ops.ts:282`) but never made the key writable —
  `projectExecutionWorkspacePolicySchema` is `.strict()` and had no `gitOps`
  field (`packages/shared/src/validators/project.ts:17`).
- **Fix:** wired `gitOpsProjectPolicySchema` into the parent policy schema.
- **Verify:** `project update` echoes `gitOps`; persisted to DB.

## 2 — 🟠 git-ops policy stripped on read

- **Symptom:** even after the schema fix, the API response dropped `gitOps`.
- **Root cause:** `parseProjectExecutionWorkspacePolicy`
  (`server/src/services/execution-workspace-policy.ts`) is a hand-rolled
  allow-list rebuild that never listed `gitOps`, so it was dropped on read/normalize.
- **Fix:** added a `gitOps` pass-through via `gitOpsProjectPolicySchema.safeParse`.
- **Verify:** API response includes `gitOps` after re-apply.

> Bugs 1 + 2 share a root cause: A6 added the *reader* but never the *writer/parser*.

## 3 — 🔴 Agent ran in the operator's live clone (no isolation)

- **Symptom:** the CTO wrote `CHANGELOG.md` directly into `~/sourceControl/paperclip`
  (untracked) on the working branch — no worktree, no commit, no branch.
- **Root cause:** `buildExecutionWorkspaceAdapterConfig`
  (`server/src/services/execution-workspace-policy.ts:320-330`) injects the
  `git_worktree` strategy **only** for `mode==='isolated_workspace'`; every other
  mode deletes it, so `realizeExecutionWorkspace` returns `project_primary` with
  `cwd = baseCwd` (the configured project clone) at
  `workspace-runtime.ts:1104-1116`. Any non-isolated run under a worktree-isolation
  policy got write access to the real repo. No guard enforced isolation.
- **Fix:** (a) reroute — `shouldUseProjectWorkspaceForRun` keeps the clone only for
  `isolated_workspace` runs; other modes go to the agent scratch dir;
  (b) fail-closed backstop — `assertRunWorkspaceIsolation` throws after realize if a
  run resolved to a shared clone under a worktree policy (caught by the heartbeat
  setup handler → run fails before the adapter spawns). Pure helpers, 10 unit tests.
- **Verify:** unit tests; 95 existing workspace/heartbeat tests green.
- **Residual (accepted):** cwd isolation governs the default working dir only — a
  `Bash(*)`+skip-permissions agent can still `cd` elsewhere. Full isolation needs a
  sandboxed execution target (future hardening). Operator rule: never point the
  primary workspace at a clone you care about.

## 4 — 🟠 CTO acted as solo dev

- **Symptom:** the CTO created its own child (HIV-9), self-assigned, implemented it
  inline, and marked it done — ignoring the materialized child (HIV-8) and the
  Implementor entirely.
- **Root cause:** `.agents/dev-team/agents/cto/AGENTS.md` never said the plan's
  children already exist (so it duplicated), and nothing hard-stopped it from
  implementing — the "don't write code" line was advisory.
- **Fix:** added "the plan's children already exist — assign them, don't duplicate"
  + a blunt no-implementation rule ("a repo in cwd is not permission to edit;
  assign via `paperclipUpdateIssue({status:in_progress, assigneeAgentId})` then STOP").
  Re-synced to the running CTO.
- **Verify:** read-back of the running agent's bundle shows the new contract.

## 5 — 🔴 Implementor contract used the forbidden token path

- **Symptom:** the Implementor AGENTS.md "PR pipeline" still instructed
  `gh pr create` with credentials from `env.GITHUB_TOKEN` — the exact env-bound
  capability-token path A6 was built to eliminate (a `skip-permissions` agent can
  read/exfiltrate an env token).
- **Root cause:** the implementor bundles were never updated when A6 replaced the
  `gh`/env flow with server-side proxy tools.
- **Fix:** replaced with `paperclipPushBranch({issueId})` /
  `paperclipOpenPullRequest({issueId,title,body})` (server holds the token, derives
  repo/branch/base, records `pr_url`) and an explicit ban on `gh`/`git push`/
  `env.GITHUB_TOKEN`/upstream. Re-synced to both Implementors.
- **Verify:** read-back shows the A6 tools present and the `gh`/env command lines gone.

## 6 — 🟠 Soft gates bypassable (no hard `done` guard)

- **Symptom:** the issue reached `done` with all three review gates still `pending`
  and no PR.
- **Root cause:** `evaluateStageTransition` bypasses agents entirely
  (`server/src/services/issue-stage-machine.ts:45` — `if actorType !== "user" return allowed`);
  nothing blocked an agent `done` on missing PR / pending gates.
- **Fix:** interim C1 guard on the issue PATCH path
  (`server/src/routes/issues.ts`) — an **agent** cannot move a `dev_team`-gated
  issue to `done` until `pr_url` is set and both code + wiring gates are `approved`
  (else `422 dev_team_done_blocked`). User/board may override; the override is
  audited as `issue.gate_overridden`. Pure decision `evaluateDevTeamDoneReadiness`
  in `plan-gates.ts`, 9 unit tests.
- **Verify:** unit tests; 18 plan-gate + parity tests green.

## 7 — 🟡 `plan create` couldn't link a project

- **Symptom:** the plan root issue had `projectId: null`, so worktree + git-ops
  couldn't resolve the repo; required a manual `issue update --project-id`.
- **Root cause:** `createPlanSchema` / `createPlan` / the CLI had no `projectId`.
- **Fix:** `plan create --project <id>` threads `projectId` end-to-end; children
  inherit via `createChild` (`projectId ?? parent.projectId`).
- **Verify (live):** HIV-10 root carries `projectId`; child HIV-11 inherited it.

## 8 — ⚪ Activate response omitted `gateApprovalIds`

- **Symptom:** `POST /plans/:id/activate` returned `childIssueIds` but not the
  created gate ids, making the response look like nothing materialized.
- **Root cause:** `gateApprovalIds` was computed but not included in `res.json`
  (`server/src/routes/plans.ts:207`).
- **Fix:** added `gateApprovalIds` to the response.
- **Verify (live):** activate returns `gateApprovalIds: 3`.

## 9 — 🟡 `plan create` silent success → duplicate plan

- **Symptom:** the first `plan create` succeeded but its (nested `{issue, planDetails}`)
  JSON was mis-read as a failure → a second identical plan was created (HIV-6 + HIV-7).
- **Root cause:** no clear success signal; the created id sits under `.issue.id`,
  not at the top level.
- **Fix:** the CLI now prints a one-line **stderr** confirmation
  (`Plan <identifier> created (draft) — activate to start.`) that shows even in
  `--json` mode without polluting stdout.
- **Verify (live):** confirmation printed on create.

## 10 — 🟡 Auto-heartbeat not held during setup

- **Symptom:** an agent auto-ran on HIV-6 during setup with no manual wake
  (~$0.89 burned); "armed-idle" wasn't idle.
- **Root cause (not a missing mechanism):** the heartbeat drivers + wake **already**
  filter `companies.status === "active"` (e.g. `heartbeat.ts:9841` suppresses wake
  for a non-active company); the pilot simply never paused the company during setup.
- **Fix:** procedure, not code — **pause the company during setup, resume before the
  first wake.** `PATCH /companies/:id {status:"paused"}` (or CLI
  `company update <id> --payload-json '{"status":"paused"}'`); reverse with
  `{"status":"active"}`.
- **Verify (live):** with Hive paused, `agent wake` returned
  `{"error":"Company is not active","details":{"status":"paused"}}`; resumed cleanly.
- **Low-pri follow-up:** company pause sets `status` but does not persist
  `pausedAt`/`pauseReason` (cosmetic; the status filter is what enforces the hold).

---

## Not-yet-fixed / accepted residuals

- **Sandbox isolation (from #3):** cwd isolation is a soft boundary against a
  `cd`-escaping agent. Hard fix = sandboxed execution target. Tracked for future
  hardening; pairs with roadmap C1/C5.
- **`pausedAt`/`pauseReason` not persisted on company pause (#10):** low priority.

## Verification posture

- `pnpm -r typecheck` green after every fix.
- New unit tests: 10 (isolation) + 9 (done-guard) = 19; plus 95 + 18 existing
  workspace/heartbeat/plan-gate tests green (no regressions).
- Live smokes against the running server for the config + CLI fixes (1, 2, 7, 8, 9, 10).
