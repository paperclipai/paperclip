# Issues service fixture replay audit — 2026-10-13

## Scope and savings

This candidate changes only `server/src/__tests__/issues-service.test.ts`. It consolidates repeated setup while retaining the observable list, count, description-preview, dependency-readiness, and deep-ancestor contracts. Production code, database fixture ownership, cleanup hooks, and `ensureIssueRelationsTable` are unchanged. The existing `seedIssueCompany`, `seedWorkspaceProject`, and `seedCodexCoder` helpers remain intact; the candidate uses existing company seed calls and preserves the Codex coder seed in the dependency keeper.

Against the existing stack, the test-file diff is 63 lines added and 218 removed: **155 net test lines removed**, including the reviewer-requested removal of an inline comment. The existing stack already shares seed helpers, so savings are smaller than the earlier candidate. Seven standalone test declarations are removed. All four description inputs and all three count calls remain. The 60-node ancestor chain remains; its descendants use one insert statement instead of 60. These are source and operation counts, not a measured CI speedup.

## Removal and keeper ledger

| Removed standalone case | Keeper and retained proof |
| --- | --- |
| `counts only unassigned issues for assigneeAgentId='null'` | `filters and counts unassigned issues with assigneeAgentId='null'` uses the assigned/unassigned fixture and explicitly asserts count `1` as well as the selected issue ID. |
| `counts UUID-assigned issues with assigneeAgentId` | `filters and counts only issues assigned to the requested UUID` explicitly asserts count `1`. Its fixture includes the requested assignee, another assignee, and an added unassigned row, preserving the removed case's unassigned exclusion while exercising another-assignee exclusion. |
| `rejects malformed assigneeAgentId filter values in count` | `rejects malformed assigneeAgentId filters in list and count` retains both independent calls and `/assigneeAgentId/i` rejection assertions. |
| `marks list descriptions as not truncated when they fit the preview limit` | `trims large list payloads and preserves description preview boundaries` retains an exact 1,200-character input and asserts length `1200` and `descriptionTruncated: false`. |
| `marks null list descriptions as not truncated` | The same preview keeper retains a null input and asserts null output and `descriptionTruncated: false`. |
| `does not let description preview truncation split multibyte characters` | The same preview keeper retains 1,199 ASCII characters followed by an em dash and a suffix. It asserts length `1200`, the final em dash, and `descriptionTruncated: true`. The original 5,000-character input and null large-payload field assertions remain. Results are selected by ID rather than relying on row order. |
| `treats blockers with no executionWorkspaceId as not subject to the workspace-finalize barrier` | `only returns dependents once every blocker is done` explicitly seeds both blocker workspace IDs as null. It retains the not-ready assertion with a remaining open blocker, then the exact dependent/assignee result after both finish, plus both blocker IDs and an explicit two-ID length check to retain the removed case’s exact-set proof. This success still fails if the workspace-finalize barrier starts requiring a workspace for unattached blockers. |

## Deep-chain setup

`finds the ancestor through an arbitrarily deep chain` retains all 60 descendants, each parent link, the selected leaf, and the expected ancestor ID. IDs and rows are assembled locally, then inserted together. Only redundant database round trips are removed; the traversal depth and cycle/closed-ancestor sibling cases are unchanged. The owner suite must confirm the batched self-referencing inserts against the real embedded PostgreSQL database.

## Validation

`git diff --check` passed. The adapted candidate passed the complete owner suite with embedded PostgreSQL enabled: **130/130 passing** in **29.51 seconds** (start 08:19:20), using `node_modules/.bin/vitest run --project @paperclipai/server server/src/__tests__/issues-service.test.ts`. This exact-head rerun validates the 60-row self-referencing batch insert after removing the inline comment. An initial sandboxed attempt could not open localhost sockets and was stopped; the completed run used permission to enable the PostgreSQL fixture. No baseline/candidate timing comparison was performed, so no runtime savings are claimed. Repository-wide checks and CI remain campaign-level gates.

## Deferred work

Database fixture pooling is deliberately deferred. Sharing the existing 11 database bootstraps across groups requires separate cleanup and ordering evidence, baseline/candidate timing, and a reversible experiment. This candidate changes none of that ownership.
