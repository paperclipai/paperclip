# B1 Pilot — First Dogfood Run

First end-to-end run of the dev-team factory. Goal: prove the loop
(decompose → plan gate → worktree → implement → push → PR → review gates →
done) on **one small issue**, with cost + audit attached and zero human
intervention except merge.

Branch: `pilot/b1-dogfood`. Overview + setup: `dev-team-factory-overview.md`.

---

## Success criteria
- [ ] PR opened on the **fork** (Moyal17/paperclip), base = fork master.
- [ ] Both review gates decided by the **right agents** (code-reviewer, wiring-expert).
- [ ] Plan gate decided by the architect.
- [ ] Total cost visible on the issue.
- [ ] Runaway budget guard installed (issue-scoped hard-stop policy on the plan root).
- [ ] No token leakage in any agent-visible output or log.
- [ ] Zero human action except merge.

---

## Setup hold (do this FIRST — Fix 4)
Pause the company during setup so no auto-heartbeat run fires before you're ready
(every heartbeat driver + wake is suppressed while a company is not `active`):
```
curl -s -X PATCH http://127.0.0.1:3100/api/companies/<companyId> \
  -H 'content-type: application/json' -d '{"status":"paused"}'
```
Build the company/project/agents/plan, activate, then **resume** right before
waking the CTO:
```
curl -s -X PATCH http://127.0.0.1:3100/api/companies/<companyId> \
  -H 'content-type: application/json' -d '{"status":"active"}'
```

## Pre-run prerequisites (interactive — run yourself with `!`)
1. **Server on this branch** so the git-ops routes + new MCP tools are live:
   `! pnpm dev`  (on `pilot/b1-dogfood`). Sanity: `POST /api/issues/<id>/git/push`
   resolves (403/404, not "route not found").
2. **Onboard the CLI:** `! pnpm paperclipai onboard`.
3. ⚠ **Fork PAT in your shell env — never committed, never inlined:**
   `! export GITHUB_FORK_PAT='<fork-scoped, no-upstream, short-expiry PAT>'`
   The agent never sees this value; it is read into a company secret below.
4. **AGENTS.md** (local dev-team bundle) already instruct the implementor to call
   `paperclipOpenPullRequest` / `paperclipPushBranch` instead of `gh`.

## One-pass setup (CLI)
Paste as a block in the same shell that has `GITHUB_FORK_PAT` exported. Requires
`jq`. Replace `LOCAL_CLONE` with the path to a local paperclip clone the worktrees
branch from.

```bash
PC="pnpm paperclipai"
LOCAL_CLONE="$HOME/sourceControl/paperclip"   # repo the worktrees fork from

# 1. Company
COMPANY_ID=$($PC company create --json --payload-json '{"name":"Hive"}' | jq -r '.id')

# 2. Agents. Names derive url-keys: CTO->cto, "Code Reviewer"->code-reviewer, etc.
#    Org chain matters (wake 409s on an invalid chain): CTO at top, rest report to it.
CTO_ID=$($PC agent create -C "$COMPANY_ID" --json \
  --payload-json '{"name":"CTO","adapterType":"claude_local"}' | jq -r '.id')
for NAME in Architect "Code Reviewer" "Wiring Expert" Implementor; do
  $PC agent create -C "$COMPANY_ID" \
    --payload-json "{\"name\":\"$NAME\",\"adapterType\":\"claude_local\",\"reportsTo\":\"$CTO_ID\"}"
done

# 3. Fork PAT as a company secret — value read from the env var, never inlined.
$PC secrets create -C "$COMPANY_ID" --name github-fork-pat \
  --provider local_encrypted --value-env GITHUB_FORK_PAT

# 4. Project + worktree/gitOps policy.
PROJECT_ID=$($PC project create -C "$COMPANY_ID" --name Paperclip --json \
  --execution-workspace-policy-json '{
    "defaultMode":"isolated_workspace",
    "workspaceStrategy":{"type":"git_worktree","branchTemplate":"issue/{{issue.identifier}}-{{slug}}"},
    "gitOps":{"remoteUrl":"https://github.com/Moyal17/paperclip.git","baseBranch":"master","tokenSecretName":"github-fork-pat"}
  }' | jq -r '.id')

# 5. Primary project workspace = the local clone the worktrees branch from.
$PC project-workspace create "$PROJECT_ID" \
  --payload-json "{\"sourceType\":\"local_path\",\"cwd\":\"$LOCAL_CLONE\",\"isPrimary\":true}"

# 6. dev_team plan, one small cargo task, token cap (E6 installs the hard-stop),
#    assigned to the CTO.
$PC plan create -C "$COMPANY_ID" --gate-profile dev_team --token-cap 2000000 \
  --assignee-agent-id "$CTO_ID" \
  --title "Pilot: tiny low-blast-radius change" \
  --task "Add one line to a docs list (pick something trivial)"

# 7. Activate the plan on the board (no CLI activate yet), THEN wake the CTO:
#    ! open the board, click Activate on the new plan  — or POST /api/plans/<id>/activate
$PC agent wake cto -C "$COMPANY_ID"
```

**Notes / verify at runtime**
- `--gate-profile dev_team` is new on this branch (`cli plan create`); rebuild the
  CLI if it runs from `dist` (`pnpm --filter @paperclipai/cli build`).
- No `plan activate` CLI command exists — activate via the board or
  `POST /api/plans/<planIssueId>/activate`. Activation is what materializes the
  gates **and** the E6 hard-stop budget policy.
- If `agent create` rejects the org chain, set `reportsTo` (done above) or check
  `agent get cto`.
- The PAT secret value is read from `GITHUB_FORK_PAT` via `--value-env`; it is
  never written to a file, the command line, or an agent env.

## Cargo (the one pilot issue)
Pick low blast radius. Recommended: a docs line-item or a tiny single-file change
(e.g. add one entry to a list). Avoid anything touching auth, payments, or
migrations. Create as a `dev_team`-gated plan with ONE first-tier task; assign to
the CTO; wake.

---

## Setup observations (pre-wake, 2026-06-13)
Company `Hive` (f5fad0cb), 8 agents pre-existing (url-keys correct). Secret
`github-fork-pat` added via UI (encrypted store, not env-bound — safe path).

| Setup step | Expected | Observed |
|---|---|---|
| Project + gitOps policy | gitOps persisted on project | ✅ after fixing 2 gaps (dev #1/#2); `adc86b6a` |
| Primary workspace | local clone, isPrimary | ✅ `2cb296ca` cwd=~/sourceControl/paperclip |
| Plan create (dev_team, 2M cap) | draft plan + 1 requested child | ✅ HIV-7, gate=dev_team, capTokens 2M |
| Plan root projectId | linked to Paperclip project | ⚠ null on create (dev #3) — set manually |
| Activate | materialize child + gates + budget | ✅ child HIV-8 (projectId inherited), 3 gates pending |
| Gate routing | right designated agents | ✅ plan→Architect, code→Code Reviewer, wiring→Wiring Expert |
| E6 budget guard | issue-scoped hard-stop on plan root | ✅ total_tokens/lifetime/2M/hard_stop=true/active |

## Run observations
Fill during the run. One row per stage; note token burn + any deviation.

| Stage | Expected | Observed | Deviation? |
|---|---|---|---|
| Wake | CTO runs | ✅ ran on opus ($0.30 first run) | no |
| Decompose | CTO splits into ≥1 child | ⚠ created HIV-9 BUT orphaned pre-materialized HIV-8 | **YES** |
| Plan gate | architect decides on plan root | ❌ gate stayed `pending` — architect never ran/decided | **YES** |
| Worktree | `issue/<id>-<slug>` worktree realized | ❌ ws=null — no worktree ever provisioned | **YES** |
| Implement | commits land on worktree branch | ❌ wrote CHANGELOG.md **directly into the live repo** (untracked), no commit, no branch | **YES (safety)** |
| Push | `paperclipPushBranch` → fork | ❌ never called | **YES** |
| PR | `paperclipOpenPullRequest` → PR + pr_url | ❌ never called; pr_url null | **YES** |
| Code review gate | code-reviewer decides | ❌ stayed `pending` | **YES** |
| Wiring gate | wiring-expert decides | ❌ stayed `pending` | **YES** |
| Cost | burn visible | ✅ ~$4.03 total / 5 CTO runs for a 5-line file | (over-burn) |
| Budget guard | hard-stop present | ✅ present, not tripped (2M cap, ~well under) | no |
| Done | issue closes; human=merge only | ❌ CTO self-marked HIV-9+HIV-7 done bypassing the whole pipeline | **YES** |

**Headline:** under the SOFT gate profile the CTO behaved as a **solo dev** — created
its own child (HIV-9), implemented inline **in the primary workspace (= the live
clone)**, self-assigned, self-marked done, and skipped delegation, worktree
isolation, push/PR, and all three review gates (which stayed `pending`, ignored).
Nothing blocked it because soft gates block nothing. Total burn ~$4.03 across 5
runs (heartbeat churn + a duplicate plan) for a 5-line CHANGELOG.

## Deviations (log every one)
1. **A6 config unwritable (schema).** `git-ops.ts` reads
   `executionWorkspacePolicy.gitOps`, but `projectExecutionWorkspacePolicySchema`
   (`.strict()`) had no `gitOps` key → rejected on create. Fixed: wired
   `gitOpsProjectPolicySchema` into the parent schema
   (`packages/shared/src/validators/project.ts`).
2. **A6 config stripped (parser).** `parseProjectExecutionWorkspacePolicy`
   (hand-rolled allow-list rebuild) dropped `gitOps` on read/normalize. Fixed:
   added a `gitOps` pass-through via `gitOpsProjectPolicySchema.safeParse`
   (`server/src/services/execution-workspace-policy.ts`). Both gaps = A6 added
   the reader but never the writer/parser — never exercised until now.
3. **Plan root projectId null on `plan create`.** No `--project` flag on the CLI
   and create doesn't infer one, so worktree+gitOps can't resolve the repo. Worked
   around by `issue update --project-id` on the plan root (children inherit via
   `createChild: projectId ?? parent.projectId`). Fix forward: `plan create
   --project <id>` flag, or default to the company's primary project.
4. **Activate response under-reports.** `POST /plans/:id/activate` returned
   `children:[]`, `gateApprovalIds:0` despite correct materialization (verified via
   plan details + approvals). Cosmetic projection mismatch, not functional.
5. **Duplicate plan (operator error).** First `plan create` succeeded but its JSON
   print was mis-parsed as a failure → a second identical plan was created. Result:
   HIV-6 + HIV-7 both "Pilot: add changelog stub line". HIV-6 rejected + cancelled.
   Fix forward: `plan create` should print a clean id even with `--json`; operator
   must verify creation before retrying.
6. **CTO did not delegate — acted as solo dev.** CTO created HIV-9 itself, assigned
   it to **itself** (not an Implementor), implemented, and closed it. Dev-team role
   separation (CTO orchestrates → Implementor builds → reviewers gate) collapsed
   into one agent doing everything. Likely AGENTS.md / heartbeat-prompt gap: nothing
   tells the CTO it MUST hand a child to an implementor and stop.
7. **No worktree isolation — agent wrote to the live repo (SAFETY).** A2 worktree
   provision triggers on a child → `in_progress` WITH an agent assignee. The CTO
   skipped that transition (todo → done, self-assigned), so no worktree realized
   (ws=null) and the edit landed in the **primary project-workspace, which was the
   real clone `~/sourceControl/paperclip`** — CHANGELOG.md is untracked there on
   `pilot/b1-dogfood`. An agent editing the operator's working tree directly is the
   exact isolation failure A2/A6 were meant to prevent.
8. **git-ops never exercised.** No push, no PR, pr_url null — because no worktree
   and no in_progress transition. The A6 tool flow was never reached this run.
9. **Soft gates are theater (expected, now proven).** All 3 gates stayed `pending`
   and `done` was still reached. Confirms C1 (hard-block) is required before any
   trust — a guard must block `done` without push/PR + decided code/wiring gates.
10. **Pre-materialized child orphaned.** Activation materialized HIV-8 from the
    plan's `requestedChildren`, but the CTO ignored it and created HIV-9. Two
    competing child models (plan-materialized vs CTO-authored). Pick one: either
    the CTO works the materialized children, or activation shouldn't pre-create them.
11. **Heartbeat auto-runs agents.** A scheduler woke agents without an explicit
    `agent wake` (auto-run on HIV-6). "Armed-idle" is not idle — agents tick and
    burn on their own. Need a way to hold/pause auto-heartbeat during setup.

## Top-3 fixes before a second run
1. **Isolation/safety FIRST.** Never point the primary project-workspace at the live
   repo. Agents must only ever write inside a worktree. Ensure the worktree is
   realized BEFORE any agent edit, and fail closed if it isn't. (Blocks any further
   run.)
2. **Enforce delegation + the in_progress→worktree transition.** CTO must assign the
   child to an Implementor and move it to `in_progress` (which triggers A2), not
   self-implement. Fix the CTO AGENTS.md/heartbeat contract; reconcile HIV-8 vs
   HIV-9 child duplication.
3. **A guard that blocks `done` without the pipeline** (interim C1): no `done` while
   gates pending or pr_url null, for agent actors. Soft gates proved insufficient.

## Top-3 fixes before a second run
1.
2.
3.

---

## First-exercise watch-list (never unit-tested — watch closely)
- Credential helper actually releases creds for github.com and the push succeeds.
- Push fails **closed** if the branch/remote is wrong (no token leak).
- PR idempotency: re-running open-PR returns the existing PR, no duplicate.
- 30s push timeout / 10s GitHub abort behave on a slow/hung network.
- Identifier vs UUID on the git endpoints → 404, never a 500.
