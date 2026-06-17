# Gate-Reviewer Worktree Binding — Fix Overview

**Date:** 2026-06-17
**Branch:** `pilot/b1-dogfood`
**Commits:** `1611b281` (L1+L3), `e3b6cd39` (L2), `6057b647` (L4)
**Area:** `server/src/services/heartbeat.ts`, `plan-gates.ts`, gate routes, `packages/adapter-utils`, gate AGENTS.md

---

## Problem

Gate-reviewer agent runs (code-reviewer / wiring-expert / completeness-critic) could
resolve their working directory to an **empty per-agent fallback workspace**
(`agent_home`) instead of the issue's **git worktree**.

Observed failures:
- The completeness-critic reviewed an **empty diff** and rejected a real, merged-quality
  feature as *"not implemented."* A confidently-wrong verdict.
- Reviewers prefixed every shell command with `WORKTREE="/…/.paperclip/worktrees/…"` and
  re-`cd`'d on each call (cwd does not persist between Bash calls), burning 26+ commands,
  hitting the 60-turn cap, failing the run, and replaying at full token price.

## Root causes (verified)

1. **Gate wakes carried no workspace binding.** The three wake sites
   (`routes/issues.ts`, `routes/approvals.ts`, `routes/plans.ts`) put only
   `{issueId, approvalId, lensKey?, prUrl?}` in `contextSnapshot`. `resolveWorkspaceForRun`
   then DB-looked-up `issues.projectId`, which was **NULL** for leaves created before a
   project record existed → no project → empty `agent_home` fallback (`heartbeat.ts:4476`).
2. **The fallback was silent.** The existing guard skipped its checks when no project
   binding was present, so a misplaced reviewer ran with no error.
3. **`forceFreshSession` skipped prior-session cwd reuse**, making the fallback more likely.

## Fix — four layers (defense in depth)

| Layer | Role | What | Files |
|---|---|---|---|
| **1. Deterministic resolution** | the cure | Gate wakes carry the issue's `executionWorkspaceId` (`buildGateWorkspaceContext`); `resolveWorkspaceForRun` binds directly to that persisted git-worktree row (new `issue_worktree` source) before the fallback chain. | `plan-gates.ts`, `heartbeat.ts`, 3 route files, `issue-approvals.ts` |
| **2. Env + prompt** | the cost win | `PAPERCLIP_WORKTREE` env var (worktree path, else cwd; stripped/rewritten for remote). Gate AGENTS.md run `git -C "$PAPERCLIP_WORKTREE" diff master...HEAD` — no path-hunting, no per-turn `cd`. | `adapter-utils/server-utils.ts`, `cursor-cloud/execute.ts`, 6 AGENTS.md |
| **3. Fail-closed** | the safety net | A gate-review run that lands in `agent_home` **while a project binding exists** now fails loudly via the existing `WorkspaceValidationFailure` plumbing, instead of reviewing the wrong tree. | `heartbeat.ts` (`assertGitSensitiveAdapterWorkspaceValid`) |
| **4. Back-link** | the root-cause fix | When a plan-root gains a `projectId` (null→set), propagate it + project workspace to null-projectId descendant leaves, keyed on `planRootIssueId`. Gives Layer 1 the binding to resolve. | `issues.ts` (`update`) |

### Why all four
- **1** makes the common case correct; **4** ensures **1** has the data to resolve;
  **2** makes a correct resolution cheap (~6 commands, not 26); **3** ensures any residual
  miss is a *loud failed run*, not a *silent wrong verdict*.

## Key design properties

- **Binding is by issue, not agent.** A dynamically-provisioned reviewer (e.g. a
  completeness-critic added mid-plan) inherits the worktree automatically — no per-agent
  setup. This was the explicit "works for any dev-team / dynamic agents" requirement.
- **DB-backed, not session-backed.** Resolution reads the persisted `execution_workspaces`
  row, so it survives `forceFreshSession` and cold wakes.
- **Reuses existing plumbing.** Layer 3 rides the existing `WorkspaceValidationFailure` →
  run-failed → recovery path; no new error class or surfacing code.
- **No regression for light/solo.** The fail-closed clause is gated on a real project
  binding, so profiles that legitimately have no worktree (and implementor first-runs)
  still use `agent_home`.

## New / changed surface

- `buildGateWorkspaceContext(issue)` — `server/src/services/plan-gates.ts` (new export).
- `ResolvedWorkspaceForRun.source` + `ExecutionWorkspaceInput.source` + the shared
  `WorkspaceRealizationRequest.source.kind` gain `"issue_worktree"`.
- `assertGitSensitiveAdapterWorkspaceValid` gains an `isGateReview` input.
- `applyPaperclipWorkspaceEnv` / cursor-cloud emit `PAPERCLIP_WORKTREE`;
  `refreshPaperclipWorkspaceEnvForExecution` strips it on remote.
- `listIssuesForApproval` projection widened with `projectWorkspaceId` + `executionWorkspaceId`.

## Verification

- Typecheck clean: `shared`, `adapter-utils`, `server`, `cursor-cloud`.
- 140 server gate/workspace tests + 41 adapter-utils tests pass. New coverage:
  - fail-closed clause: throws for gate review + agent_home + binding; passes for solo/light.
  - `buildGateWorkspaceContext` field inclusion/omission.
  - `PAPERCLIP_WORKTREE` set (worktree else cwd) and remote-stripped.
- Fixed a pre-existing stale test (`buildGateApprovalsForActivation` expected 5 gates → 11
  with lens + completeness gates); confirmed it failed identically on base.

## Manual smoke (recommended next run)

Trigger a `dev_team` leaf to `in_review` on an issue whose implementor created a worktree;
confirm the woken reviewer's run cwd equals the worktree path and
`git -C "$PAPERCLIP_WORKTREE" diff master...HEAD` returns the real diff on the first
command. Re-run the Hive Pilot completeness gate and confirm it resolves to the leaf
worktree without the `WORKTREE=…` re-anchor pattern.

## Related

- Precursor fixes this session: completeness-critic token caps + per-role command budgets
  (`bf445360`, `8fc68042`) — reduce turns once the reviewer is in the right place.
- Plan: `~/.claude/plans/scalable-marinating-candy.md`.
