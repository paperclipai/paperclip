# workspace-runtime resolveShell duplicate-row retirement — 2026-10-17

One redundant registered execution is retired from
`server/src/__tests__/workspace-runtime.test.ts`. No production file
changes. No execution-time or CI-time benefit is claimed.

Discovery base: `5555817c2b18a1a5ebc3a3b01883c1b12b86df5a` (master head).
Applied skill: installed test-audit, SKILL.md sha256
`d2569031196778bebb7fd623d87b4379ed1a0d372d1ea004b0b3d330b352d1d2`.

## Change and keeper

| Candidate | Decision | Contract | Keeper | Evidence |
| --- | --- | --- | --- | --- |
| `falls back to /bin/sh on darwin when SHELL is unset` (resolveShell describe) | Delete | Non-win32 fallback returns `/bin/sh`. | `falls back to /bin/sh on non-Windows when SHELL is unset` (linux row) | `resolveShell()` computes the fallback from a single two-arm ternary, `process.platform === "win32" ? "sh" : "/bin/sh"`. darwin and linux both evaluate the same non-win32 arm and assert the same value through the same production path, so the darwin row cannot fail while the linux row passes. Inputs and assertions are otherwise identical (unset SHELL, mocked platform, fallback value). |

Retained siblings in the same describe: the win32 row (only observation of
the `"sh"` arm), the empty-string and whitespace-only rows (missing versus
invalid input; whitespace-only additionally pins trim-before-falsy-check),
and the missing-absolute-path row (only observation of the `existsSync`
guard). The non-Windows/linux row keeps the non-win32 arm pinned after this
change, verified by control below.

## Validation

Focused owner runs, `pnpm --filter @paperclipai/server exec vitest run
-t "shell fallback" src/__tests__/workspace-runtime.test.ts` (vitest 5.0.3,
Node 25.9.0, isolated checkout with `pnpm install --filter @paperclipai/server...`):

1. Baseline (before edit): 9/9 passed.
2. Candidate (darwin row deleted): 8/8 passed.
3. Control: temporarily changed the production fallback arm to
   `"/bin/bash"` and reran the same focused selection (re-verified
   2026-10-17). Exactly three rows failed at the same assertion shape
   (`expected '/bin/bash' to be '/bin/sh'`): the retained linux unset
   row (the deleted darwin row's keeper), the empty-`SHELL` row, and
   the missing-absolute-path row. The win32 rows and the set-`SHELL`
   rows still passed (3 failed, 5 passed). This proves the retained
   linux row carries the deleted row's failure sensitivity; it also
   shows the same non-win32 fallback value is observed by the
   empty-`SHELL` and missing-absolute-path rows, so that value keeps
   multiple guards after this change. An earlier draft of this receipt
   wrongly said the mutation "breaks nothing else" in the selected run;
   that claim is corrected here (Greptile review finding, PR #16639).
4. Production restored byte-exact (sha256
   `335fd5332b4242ab0ff2a565323e27db48a69ddfb7bbd8d913e5148f79ff961b`
   before and after), rerun: 8/8 passed.

The full `workspace-runtime.test.ts` owner and the repo-wide
typecheck/test/build suite were not run locally in this session; this
container cannot complete the git-fixture cases inside their 15-second
budgets (three unrelated reconciliation cases time out at 15,000 ms here
before and after this change, and the production-internal 8-second git scan
budget also fires), so those runs are left to PR CI. The change is a
six-line deletion inside one describe; no production file, lockfile,
workflow, or shard manifest is touched.

## Deferred candidate (evidence, not applied)

`keeps forward reconciliation fail-closed for an unrelated task branch`
(line ~3491) repeats `keeps forward reconciliation fail-closed for
same-content rewritten history` (line ~3461): identical git topology (each
branch one commit ahead of main), identical assertion union through
`expectPersistedBranchMismatchRejected` (verdict `diverged`, reason
`expected branch and current HEAD differ`), and the differing fixture bytes
(file names, commit messages) are never read by
`inspectGitWorktreeBranchIncoherence`, which decides on cleanliness, branch
existence, ancestry, and worktree registration only. The third sibling
(`live branch is behind`) is retained: its topology makes the actual branch
an ancestor in the reverse direction, so it uniquely guards the ancestry
comparison's direction. Deletion of the unrelated-task row is deferred
because the local environment cannot produce a passing baseline for these
git-fixture cases (15-second per-test timeout); it needs validation on a
host where the fixtures complete, or via CI evidence.

## Other examined-and-retained areas

- `native-runner-input-boundary.test.ts` alias: retained per the 2026-10-13
  execution-wrapper receipt; still the only entry point for the Runner
  contract suite in the root default run. Historical weight 204 ms.
- Repo-wide duplicate-title and near-identical-body scans over the top-30
  duration-weighted server suites: all other matches protect distinct
  contracts (different function, input class, platform arm, or boundary) and
  are retained.

Test source changes: −6 test lines, zero production lines, zero docs lines
outside this receipt. One registration removed per complete-suite
invocation. No measured wall-time saving is claimed.
