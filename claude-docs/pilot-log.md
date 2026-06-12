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

## Run observations
Fill during the run. One row per stage; note token burn + any deviation.

| Stage | Expected | Observed | Deviation? |
|---|---|---|---|
| Decompose | CTO splits into ≥1 child issue | | |
| Plan gate | architect gate appears on plan root | | |
| Worktree | `issue/<id>-<slug>` worktree realized | | |
| Implement | commits land on the worktree branch | | |
| Push | `paperclipPushBranch` pushes to fork (no token in output) | | |
| PR | `paperclipOpenPullRequest` opens PR; `pr_url` stored; chip shows | | |
| Code review gate | code-reviewer decides via /agent-decide | | |
| Wiring gate | wiring-expert decides via /agent-decide | | |
| Cost | issue cost widget shows burn | | |
| Budget guard | hard-stop policy present; trips if cap exceeded | | |
| Done | issue closes; human = merge only | | |

## Deviations (log every one)
1.
2.
3.

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
