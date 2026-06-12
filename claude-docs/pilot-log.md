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

## Pre-run setup (operator — gated items marked ⚠)

1. **Server on this branch.** Restart the Paperclip stack on `pilot/b1-dogfood`
   so the git-ops routes + the two new MCP tools are live (`pnpm dev`). Confirm
   `GET /api/issues/:id/git/push` exists (405/404, not "route not found") and the
   mcp-server build includes `paperclipPushBranch` / `paperclipOpenPullRequest`.
2. **CLI / auth.** `paperclipai onboard` (or use the UI) against the instance.
3. **Hive company + agents.** A company with the six dev-team agents; gate roles
   must have urlKeys `architect` / `code-reviewer` / `wiring-expert`. An
   implementor is the issue assignee.
4. **Project config.** On the Hive project set `executionWorkspacePolicy`:
   - `defaultMode: isolated_workspace`, `workspaceStrategy.type: git_worktree`,
     `branchTemplate: "issue/{{issue.identifier}}-{{slug}}"`
   - `gitOps: { remoteUrl: "https://github.com/Moyal17/paperclip.git",
     baseBranch: "master", tokenSecretName: "github-fork-pat" }`
   - project repo path = a local paperclip clone.
5. ⚠ **Fork PAT as a company secret.** Create the secret `github-fork-pat`
   (provider `local_encrypted`) with a **fork-scoped, no-upstream, short-expiry**
   GitHub PAT. **Operator-supplied — never committed, never env-bound.**
   The agent never sees this value.
6. **AGENTS.md** (local dev-team bundle): implementor calls
   `paperclipOpenPullRequest` / `paperclipPushBranch` instead of `gh`.
7. **Plan budget cap.** Set a token cap on the plan so E6 installs the hard-stop
   guard before the unattended run.

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
