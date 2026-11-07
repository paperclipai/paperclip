# Delivery fixture consolidation receipt

Exact parent: #16111, `06c1b2035df44fa03c065ddd69e8bf8df8513b86`.

The first delivery test in `server/src/__tests__/execution-workspaces-service.test.ts` creates a second Git topology that `seedTerminalWorkspace()` already creates. `candidate.patch` removes the manual repository/worktree and redundant PR-head overwrite. The original DB update and its updatedAt timing remain, with two path references redirected to the seeded fixture.

Savings: +2/-17, net 15 test lines; one repository/worktree and 11 duplicate fixture Git subprocesses. All 67 registered cases remain. All six keeper assertions and 61 other declaration ASTs are unchanged. The 12 retained keeper statements match after the physical-path alias.

| Phase | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Baseline | 67 | 0 | 0 |
| Candidate | 67 | 0 | 0 |
| Full revert | 67 | 0 | 0 |
| Production mutation | 50 | 17 | 0 |
| Restored candidate | 67 | 0 | 0 |

The production mutation in `server/src/services/execution-workspaces.ts` incorrectly requires Git ancestry for merged-PR delivery. The exact intended keeper fails at candidate test line 542: `unmerged` received instead of `merged_via_pr`. Full mutation failure evidence is in `proof/mutation-pr-ancestry.json`.

Source files are restored byte-for-byte, HEAD is unchanged, and the scratch checkout is clean. No branch or PR was created by the proof agent. No shared-checkout source was edited. No further owner tests are running. Runtime slot reservation arrived after this replay started; it finished during stop attempts and may have overlapped the other non-DB lane. No global serialization or CI timing saving is claimed.

`receipt.json` uses checkout-relative source paths and evidence-relative artifacts. Commands run from `server/`; set `AUDIT_EVIDENCE_DIR` to this folder. Baseline source snapshots, all five reports/logs, mutation patch and AST proof are included in `proof/`. The reviewed candidate is only `candidate.patch`; no mutation belongs in the proposed change.

## Reproduce the integrated candidate

The 67-case counts, mutation result and patch hash above are historical results
from the original proof parent. They are not fresh results on current master.
The integrated replay below uses immutable public revisions from this PR's
rebuilt parent and candidate. Its test-only patch is still +2/-17; newer unrelated
owner tests stay in both baseline and candidate. Do not compare current HEAD to
the older historical proof parent.

Run from a dependency-ready repository checkout (Git, Node and the repository's
installed dependencies are required):

```sh
base=1108f714ef42b0c59fea6916647e132e414c7cab
candidate=fa7bc838926164781a1f1170c382819ba86e5a9d
git fetch https://github.com/paperclipai/paperclip.git "$base" "$candidate"
replay_dir=$(mktemp -d)
git diff "$base" "$candidate" -- server/src/__tests__/execution-workspaces-service.test.ts > "$replay_dir/candidate.patch"
git diff --numstat "$base" "$candidate" -- server/src/__tests__/execution-workspaces-service.test.ts
# Expected: 2 added, 17 removed; one test file.
git worktree add --detach "$replay_dir/worktree" "$candidate"
git -C "$replay_dir/worktree" apply --reverse --check "$replay_dir/candidate.patch"
```

Install the repository's pinned dependencies in the isolated worktree before
running its owner suite. From that worktree's `server/`, run
`node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/__tests__/execution-workspaces-service.test.ts --reporter=default`.
Reverse the candidate patch in that worktree to run the matching baseline, then
apply it again and rerun the candidate. The integrated suite may contain more
than the historical 67 cases; record its actual counts rather than substituting
the historical numbers. Clean up only this replay worktree with
`git worktree remove "$replay_dir/worktree"` and `rm -rf "$replay_dir"` after
restoring any production mutation. The historical patch hash above does not
claim to be the hash of this integrated patch.

## Mutation proof

The keeper is `reports a squash cross-branch delivery as merged_via_pr and suppresses the ancestry warning`. In `server/src/services/execution-workspaces.ts`, change the first condition in `deriveExecutionWorkspaceDeliveryState` from `input.sourceIssueTerminal && input.mergedPullRequest` to `input.sourceIssueTerminal && input.mergedPullRequest && input.isMergedIntoBase === true`. This rejects a valid squash/cross-branch PR. The keeper receives `unmerged` instead of `merged_via_pr`. In the full owner run this mutation produced 17 failures; the named keeper failed at candidate line 542. The mutation and candidate were restored byte-for-byte after proof.

Accepted phases were baseline 67/67, candidate 67/67, full revert 67/67, mutated owner 50 pass / 17 fail, and restored candidate 67/67, with zero skipped cases. The mutation controls production behavior; the PR changes tests only.

The proof replay finished during a stop attempt after a runtime-lane reservation arrived. It may have overlapped that lane's non-database test process. No host-wide serialization or CI-time savings are claimed. Proof source hashes, AST comparison, reports, and logs remain in the isolated audit workspace and are not represented as checked-in files.
