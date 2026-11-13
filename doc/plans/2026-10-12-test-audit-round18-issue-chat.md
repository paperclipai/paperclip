# IssueChatThread test audit: round 18

Exact parent: #16091, `dc6cfe7512d5dcb25aa9df5b918d46f35cd2eb22`.

The complete IssueChatThread owner has 89 declarations and 99 registered rows before this change. The candidate has 87 declarations and 97 rows. All rows and parameter tables outside the two retirements remain intact. The paired TaskChatThread owner has 107 declarations and 225 rows. It has no qualifying cut. Native and legacy modes have separate owners and contracts.

## Retirement map

| Retired invocation | Retained invocation | Preserved proof and phase |
| --- | --- | --- |
| omits the bottom spacer when the composer is hidden | drops the count heading and does not use an internal scrollbox | Same fresh root and renderIssueThread(root, { showComposer: false }); migrate the spacer query and null assertion after initial render, before unmount. |
| keeps the composer floating with a capped editor height | does not restore the composer viewport for passive live updates by default | Same fresh root and renderIssueThread(root); migrate dock, composer and editor queries and every observation after initial render, before the keeper's liveRuns rerender. |

The AST comparison permits only these two declaration removals and exact observer moves. Helpers, hooks, provider inputs, fixtures, cleanup, actions, and parameter rows match the parent. The final runtime case names match the baseline minus the two named retirements. The active composer viewport case stays separate because it changes preservation state and snapshot position. No helper was added.

## Replay

All full-file runs have zero failed or skipped cases.

| Phase | Passed cases |
| --- | ---: |
| Parent baseline | 99 |
| Candidate | 97 |
| Original test revert | 99 |
| Restored candidate after controls | 97 |
| Unchanged TaskChatThread sibling | 225 |

Command: `pnpm exec vitest run ui/src/components/IssueChatThread.test.tsx --reporter=json --outputFile=<phase>.json`. The sibling uses the same command with TaskChatThread.test.tsx.

## Production controls

Each control changes the real IssueChatThread.tsx owner. Each selected keeper fails once at the migrated assertion below. Other cases are filtered with Vitest -t; no test-source skip was added.

| Control | Retained guard | Candidate line |
| --- | --- | ---: |
| hidden-spacer-leak | `expect(spacer).toBeNull()` | 425 |
| missing-dock | `expect(dock).not.toBeNull()` | 3938 |
| dock-sticky | `expect(dock?.className).toContain("sticky")` | 3939 |
| dock-bottom-offset | `expect(dock?.className).toContain("bottom-(--sz-calc-8)")` | 3940 |
| dock-layer | `expect(dock?.className).toContain("z-20")` | 3941 |
| missing-composer | `expect(composer).not.toBeNull()` | 3946 |
| composer-radius | `expect(composer?.className).toContain("rounded-md")` | 3947 |
| composer-padding | `expect(composer?.className).toContain("p-(--sz-15px)")` | 3949 |
| editor-height-cap | `expect(editor?.dataset.contentClassName).toContain("max-h-(--sz-28dvh)")` | 3954 |
| editor-overflow | `expect(editor?.dataset.contentClassName).toContain("overflow-y-auto")` | 3955 |
| editor-min-height | `expect(editor?.dataset.contentClassName).not.toContain("min-h-(--sz-72px)")` | 3956 |
| editor-drop-target | `expect(editor?.dataset.fileDropTarget).toBe("parent")` | 3957 |

The radius positive and negative guards cover the same behavior. The wrong-radius control fails the stronger positive guard; no separate negative-radius mutation is claimed. Production source was restored after every control. SHA256 before and after: `23624e4e25b60c9ce8cc91fa548bfd46e18666723e5aa8d9f882846ded3bdf82`. Candidate test SHA256: `d2361cefd481433b7b5dabd0066b09fa6856f38e3610f910e02e8aab2b3023e3`.

## Scope and checks

The test diff adds 29 lines and removes 55 lines: 26 net test lines removed. It removes two registered executions and two fresh initial root/component renders. No measured runtime savings are claimed. Production LOC changes: zero. Keyboard, hash/manual scroll, permissions, retry, persistence, live update, file input, and parameterized cases remain distinct.

Focused UI typecheck, token gate, and diff check pass. The first UI typecheck could not resolve generated plugin SDK declarations in the fresh checkout. Building the SDK and shared dependency restored the declarations; the rerun passed. Full repository gates are reported in the PR; this focused proof does not claim they passed.

Local replay JSON, logs, complete declaration/runtime ledgers, exact AST proof and mutation failures are preserved under /private/tmp/issue-chat-*. The concise evidence above is included here so the retirement map and observed controls remain reviewable without local artifacts.
