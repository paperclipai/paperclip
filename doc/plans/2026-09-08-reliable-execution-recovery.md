# Reliable execution and continuation — implementation and verification

## Outcome

Failed provider sessions retain their structured failure meaning. Recovery uses a shared incident budget of three provider attempts, including the original attempt. A fresh replacement requires a fenced predecessor, durable completed results, preserved workspace state, authorized task history, and reconciled pending effects. Unknown external effects receive an automatic preserve-without-replay disposition; they never require a reconciliation form.

The server owns the continuation envelope. It includes the triggering request, subsequent user direction, interaction outcomes, completed work, and an explicit history cursor. The latest request supplies the completion objective; an old task title cannot satisfy a new follow-up.

Confirmed provider descendant IDs survive restart and stay exact within a 4,096-entry inventory, with IDs bounded to 240 bytes. Capacity exhaustion stops provider work with an explicit reconciliation reason; it never evicts identities or pretends that a valid child is an integrity violation. Repeated progress diagnostics remain bounded.

Local CLI run-authored comments retain their provenance in history and cannot replace the latest human objective. Scheduled replacements and the final dispatch gate reject another run's execution or checkout lock.

A shared execution projection distinguishes confirmed work, recovery, scheduled retries, finalization, and real interaction waits. The composer remains usable. The failed predecessor remains inspectable after a replacement.

## Reproduced failure

A Codex notification named another thread. Recovery attempted an unusable checkpoint. On a later attempt, the admission transaction held the task row while waiting for provider spawn or adapter settlement. Failure finalization waited for the same row. PostgreSQL confirmed the blocking transaction. The final gate now initiates the adapter handoff while ownership is locked, then commits without awaiting provider work. Bootstrap and finalization can acquire the same rows independently; a competing owner cannot enter between the final check and handoff.

A connection continuation also omitted the follow-up that requested a second service. Its old completion objective referred to the first service. The continuation envelope now preserves the source request even when the preceding run already received that message.

The shared protocol-integrity and cleanup changes incorporate the relevant prerequisites from PR #13038. They do not require its chat feature.

## Functional evidence before the quiet UI revision

Five independent fresh source-CLI `test-drive` instances passed these browser journeys:

| Journey | Provider | Result |
| --- | --- | --- |
| Safe replacement | Native Codex driver with deterministic model and MCP fixtures | A second-service request survives the injected failure and receives a tool-backed answer without another Run click. |
| Unknown action | Native Codex driver with deterministic fixtures | No speculative replay. The operator records action outcomes before continuation. |
| Restart during retry | Native Codex driver with deterministic fixtures | Durable retry survives server restart with one successor. |
| CEO descendant events | Native Codex driver with deterministic fixtures | Provider-confirmed descendant notifications do not crash or complete the root. |
| Unsupported legacy recovery | Deterministic process adapter | Unknown action outcomes create an operator-owned recovery action. |

These fixtures do not prove live provider authentication. A separate retained live instance completed the current Gmail request with native Codex and model `gpt-5.6-sol`: one search call and five thread reads. History, assignment, and existing connections were retained. No mail was sent. Private provider history, instance identifiers, and credentials are excluded from this repository.

The live journey required explicit operator reconciliation during diagnosis. It proves the repaired functional path, not a frictionless first attempt.

## Automated checks before the quiet UI revision

Before PR rebase, the repository test groups, typecheck, build, token gates, and Storybook build passed. The server test groups ran in shards, with affected suites rerun after repairs. Runner TypeScript passed 1,665 tests with eight skips; Node contracts passed 38 tests; the full Rust workspace passed. After the rebase, the PR checks verify the new head, including the session-goal changes on master.

Focused coverage includes provider event identity, structured failure propagation, atomic finalization, cleanup failure, lease loss, publication recovery, one-successor dispatch, shared retry budgets, quota monitors, current reviewer authorization, ownership changes, continuation context, and uncertain actions. Legacy adapters need positive pre-provider evidence to authorize a bootstrap retry. A pre-provider workspace wait does not consume the failure budget.

## Browser and Storybook reproduction

Finish the runner build before browser acceptance. Do not rebuild generated provider artifacts while a fixture consumes them.

```sh
pnpm exec playwright test --config tests/e2e/execution-recovery/playwright.config.ts recovery.spec.ts
pnpm --filter @paperclipai/ui build-storybook
RECOVERY_STORYBOOK_URL=http://127.0.0.1:6108 pnpm exec playwright test --config tests/e2e/execution-recovery/playwright.config.ts storybook.spec.ts
```

Serve the built Storybook at the configured URL before the second browser command. The recovery suite creates and stops fresh test-drive instances itself. Each journey records its actual URL, data directory, checkout, task/run identifiers, provider calls, and screenshots in the Playwright output directory.

The quiet UI revision removes the execution status card, list badges, and reconciliation dialog. Existing transcript headers may briefly show Reconnecting. The source task and composer remain visible. Unknown action outcomes receive a durable automatic no-replay disposition; no operator questionnaire is shown.

Independently addressable stories under `tasks-execution-recovery`:

`working`, `reconnecting`, `retry-scheduled`, `waiting-for-workspace`, `finalizing`, `safely-replaced`, `recovery-exhausted`, `uncertain-action`, `unavailable-recovery`, `waiting-for-access`, `waiting-for-answer`, `narrow-long-error`, `composer-during-recovery`, `task-list-badges`, `task-list-badges-canonical`, `native-chat-status-labels`, `legacy-chat-status-labels`, `dashboard-status-labels`.

Open a story with `?path=/story/tasks-execution-recovery--<suffix>`. The badge story names remain stable for review links; their rows now demonstrate the absence of execution badges. Earlier screenshots of the status card and dialog are obsolete and are not acceptance evidence for this revision.

Representative screenshots for the quiet presentation:

- [Task lists without execution badges](../assets/execution-recovery/quiet-task-list.png)
- [Temporary reconnection in the existing transcript header](../assets/execution-recovery/quiet-retry.png)
- [Fixture continuation after refresh](../assets/execution-recovery/fixture-completed.png)

## Quiet recovery revision verification

All five fresh deterministic journeys passed. The uncertain-action and legacy journeys were then rerun with assertions for the visible blocked status, absence of the reconciliation form and Retry control, and preserved draft text. Both passed. A missing execution projection in the history response was fixed so the feed does not offer a retry that the server will reject.

The 72 Storybook theme/viewport combinations passed, with 16 affected combinations rerun after presentation changes. Repository typecheck, build, token gates, and Storybook build passed. Focused recovery, projection, activity-history, and UI tests passed. The full local suite exposed a fixture race that closed a task before provider acceptance; the fixture now waits for actual provider acceptance, and all 64 tests across the affected continuation and recovery-route suites pass.

Recovery decisions remain visible in local run logs. The durable status broadcast contains only run/agent identifiers, status, timestamps, and delivery ID; it does not broadcast provider output or errors. New verified evidence can clear an automatically settled hold through the existing authorized evidence API. Generic retries and duplicate requests cannot clear the hold. No dialog is exposed for this path.

## Rollout and limits

The recovery migrations were renumbered to 0250–0254 after master added session goals and action-delivery storage. Their SQL remains idempotent for instances that applied the earlier branch numbers. Migration snapshots include both sets of schema changes.

Control transitions have a 60-second deadline and a 15-second reconciliation cadence. With a healthy database and scheduler, abandoned transitions must be repaired or surfaced within 90 seconds. Healthy provider silence has no new timeout. An upgrade never automatically replays ambiguous historical work. Default CEO instructions remain unchanged.

Fresh test-drive instances use local-trusted mode. Authenticated/cloud browser behavior, every legacy provider, and every deployment topology were not exercised live. Automated tests cover authorization and company boundaries. An early terminal-delivery screenshot still showed Working briefly; the final refreshed screenshot above shows the completed state.

The final ownership-handoff regressions passed (42 tests across the dispatch adapter and stale-queue suites). They verify competing ownership at the handoff boundary and provider failure before a spawn callback, without retaining database locks for provider completion.
