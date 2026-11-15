# Test audit, Round 7 UI — AppDetail follow-up

This follow-up removes **one duplicate registered invocation, one complete render, and seven net test lines** from `ui/src/pages/apps/AppDetail.test.tsx`. It adds no helper and changes zero production lines. Combined with the [approved first UI batch](2026-10-12-test-audit-r7-ui.md), the branch removes **371 net test lines and two registered invocations**. The original UI report, controls and test bytes remain unchanged.

The follow-up audit base is local UI commit `81cd7ab0ca0bdc55ea0927bc44fcf6e764a530ed`. This file has the same original bytes at Round 6 parent `e868e6645ce0d598d756d3458f0b3d71afd6db4a`.

## Exact retirement and keeper

Retired: `removes the separate always-installed controls from Permissions`.

Keeper: `renders searchable action groups with three-way permission toggles`.

Both cases use the same enclosing beforeEach, connection, catalog, profiles, grants, install state and spies. Their two pre-assertion statements are byte-identical: select the permissions tab, then await the same complete AppDetail render. Neither case changes a fixture or takes a user action before its assertions. Both permission observations were updated by [PR #12802](https://github.com/paperclipai/paperclip/pull/12802).

All three retired observations move unchanged into the keeper, immediately after render and before its existing assertions:

- The agent-access question is visible.
- The old Always installed copy is absent.
- The connection-install mutation API has not been called.

The keeper also retains its original fixed action-group counts, action names, review prompt, search input, selected Allowed/Ask first radio states, two Test actions, old-copy exclusions and card-layout exclusion. Viewer gates, picked-agent mode, required installed agents, access mutations, AI credential routing, task-grant removal and failure paths remain separate cases.

App.tsx mounts AppDetail at `apps/:connectionId/:tab`. AppDetail's actual permissions path renders AgentAccessSection and ActionsSection in PermissionsPanel. AgentAccessSection supplies the question and access controls. The install API is used by the explicit AI-connection save path, so a no-write-on-read check is a separate observation from absent UI copy. Both fixed guards remain in the keeper. The grouped action-control sibling suite remains unchanged.

The test stays in the `@paperclipai/ui` project and the `general-workspaces-a` lane. This cut removes a collected test and its full query-client/root render; it changes no suite inclusion or CI routing. No wall-time improvement is claimed.

## Proof

| Complete AppDetail file | Registered cases | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline | 78 | 78 | 0 | 0 |
| Candidate | 77 | 77 | 0 | 0 |

Run from `ui/`: `pnpm exec vitest run src/pages/apps/AppDetail.test.tsx`.

The body audit checks the two identical setup statements, copies the three exact assertion ASTs, and compares full original/candidate programs outside the declared removal and insertion. It also reconstructs the exact candidate text from only those source edits and requires byte equality. Every other source byte remains unchanged, including all mock factories, beforeEach, render helper, spies, waits, cleanup and original keeper assertions. No withPermissions helper exists in these pinned file bytes; no such setup was added or changed.

Both positive keeper controls passed. Two deliberately broken production owners failed at the intended migrated guard:

| Production regression | Direct keeper failure |
|---|---|
| Reintroduce Always installed copy beside the access question in PermissionsPanel | Fixed negative old-copy assertion. |
| Write connection installs from an AppDetail mount effect | Fixed no-install-API-call assertion. |

Each negative control selected only the keeper. Its unselected cases do not count as complete-file proof. Neither mutation failed on setup, timeout or an unrelated action assertion. Both production owners were restored byte for byte and checked against pinned Git source.

[Follow-up controls](2026-10-12-test-audit-r7-ui-appdetail-controls.json) retain exact original/candidate hashes, the unchanged prior proof hashes, body-audit digest, complete-file results, mutation descriptions, intended failures, run/log digests and source-restoration receipts. Raw verifiers and logs remain temporary audit packets; their digests do not retain complete payloads. Latest delivery-head replay, typecheck, token gates, build and CI status belong in the PR. The broad local default run was stopped before completion as recorded by the coordinator; it is not a full-suite pass.
