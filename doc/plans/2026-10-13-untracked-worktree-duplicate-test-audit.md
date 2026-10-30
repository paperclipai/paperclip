# Test audit: remove duplicate untracked-worktree execution

Date: 2026-10-13
Discovery base: `418eb4623ae767b5c9ce28c1c3e9fcb98f63702e` (PR #16173).
Stack replay base: `4a7d8ae4fc05acbdc5d2eefaf909fd3b29ab822c`.

This candidate removes one 21-line test and one redundant execution from
`server/src/__tests__/workspace-runtime.test.ts`. It changes zero production
lines. Complete owner/sibling proof passes 190 cases before and 189 after,
with zero failures or skips in the accepted runs. The whole owner run was
**36.124 seconds slower** after the change. No whole-file CI speedup is claimed.

## Retired case and keeper

Retire `does not reset a reused worktree with untracked changes` (baseline
line 1172). Keep `does not reset a reused worktree with untracked changes when
status.showUntrackedFiles=no` unchanged (candidate line 1172).

The keeper repeats all ten original statements, in the same order, and adds
one real Git configuration call. An AST comparison preserves identifiers,
string bytes, expressions, and assertion order; it ignores source offsets and
comments. Both cases create a real repository, bare remote, clone and managed
worktree, write the same scratch bytes, advance the remote, and realize reuse.
All four receipts remain: reused rather than created, unchanged HEAD, exact
scratch bytes, and the one-commit base-drift warning. The keeper also verifies
that the guard works when Git configuration hides untracked files.

`refreshUnstartedWorktreeToBase` always requests `--untracked-files=all` and
branches on returned dirtiness, not the configuration value. Thus the added
configuration does not select a separate production decision. Its caller is
`realizeExecutionWorkspace`, reached by heartbeat workspace preparation.
Both cases were introduced together in PR #8412. No test-only seam becomes
unused. The clean fast-forward, task-commit protection, exact-branch no-reset,
authentication and runtime lifecycle cases remain separate and unchanged.
An independent preservation review approved this exact deletion before edits.

## Regression control

The unmodified keeper passes. Changing only the owner's dirty condition from
`status.trim().length > 0` to the impossible `< 0` makes the same keeper fail
at its direct unchanged-HEAD assertion. The failed check reads the actual Git
HEAD; it is not a timeout or setup failure. Production bytes were restored
exactly, with SHA-256 `e45729293762be132b74f8eb0efe1e4b8fbefaf96839c28dcc1ef255fe97d56c`.
The replay parent's owner and original test hashes match the measured base.

## Observed cost and limitations

The accepted complete baseline passes 175 owner plus 15 scheduler cases.
The accepted complete candidate passes 174 owner plus the same 15 scheduler
cases. Owner windows are 157.794 seconds before and 193.918 seconds after.
This pair does not establish a whole-suite runtime reduction.

Six completed runs select only the two untracked cases before deletion and the
one keeper after deletion. The order is baseline/candidate/candidate/baseline/
baseline/candidate. All selected cases pass. Median selected execution drops
from 2.007489 seconds to 0.755868 seconds: an observed 1.251621-second reduction.
The retired case alone takes 0.958–1.129 seconds, median 1.081 seconds, in those
baseline samples (0.633 seconds in the accepted complete baseline).
Process wall time includes large variable import costs; its median drops from
19.028 to 14.482 seconds, but that difference is not attributed to this deletion.

| Sample | Variant | Selected execution seconds | Process wall seconds |
| --- | --- | ---: | ---: |
| 1 | baseline | 2.007 | 19.028 |
| 2 | candidate | 1.249 | 14.482 |
| 3 | candidate | 0.742 | 9.412 |
| 4 | baseline | 2.291 | 14.911 |
| 5 | baseline | 1.726 | 19.374 |
| 6 | candidate | 0.756 | 15.809 |

The first sandbox baseline was invalid because socket/process fixtures lacked
host permissions. An initial permitted candidate attempt passed 179 assertions,
failed before ten startup-reconciliation cases could run, and exposed no failed
test assertion. Its JSON did not preserve the hook error. The unchanged group
then passed all ten cases with full reporters, and the final complete candidate
passed all 189. Other concurrent work reported exhausted Postgres shared-memory
identifiers. That is consistent with setup contention, not proof of the precise
cause of this initial failure. Neither invalid run supplies accepted proof or
speedup evidence. No timeouts, retries, skips, fixtures or production code changed.

## Reproduction and provenance

Run from `server/` with the repository Vitest executable:

```sh
pnpm exec vitest run src/__tests__/workspace-runtime.test.ts src/services/workspace-git-operation-scheduler.test.ts
pnpm exec vitest run src/__tests__/workspace-runtime.test.ts -t 'does not reset a reused worktree with untracked changes'
```

The isolated checkout uses external dependency links and candidate-local
workspace links; the shared checkout's sources were not edited. Node 26.4.0
and Vitest 5.0.3 produced the local evidence. Broad workspace typecheck, build
and default full tests were not repeated locally for this 21-line deletion;
PR checks provide those gates. The targeted server no-emit typecheck and
`git diff --check` pass. Browser suites did not change.

Raw reports stay in the temporary audit directory. Their SHA-256 digests are:

| Receipt | SHA-256 |
| --- | --- |
| Accepted complete baseline | `c232815e2cda75bea004a9025cd5f8e3dbaeb110cba9821e72df20bc164337cb` |
| Accepted complete candidate | `182c030d0385e36d7f16f4ad2821124391daf16597cc7e6098f468a5d2f927d8` |
| Keeper regression control | `e182bb2e8297dc1630dfb379eaf7a8fc32714f7e5269d5e9fd17a596c0b03cff` |
| Six timing samples | `09ac6c640a67d8db20928c338f93f865fa5180b1c7fb7691a43a6c364caee3ac` |
| Original owner test | `89a5ad0dd1400880695942e049a91b18a92e0469dc6a8c2cafc5f27e5747688a` |
| Candidate owner test | `d7f09f62d92a853de3ed61a14fe941fcdc934d41d3672da0c72a3143cdef6ad2` |

This follows the [test-audit workflow](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md).
