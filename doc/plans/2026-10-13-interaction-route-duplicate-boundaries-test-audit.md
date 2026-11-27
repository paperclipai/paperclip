# Interaction route duplicate boundaries test audit — 2026-10-13

Status: candidate consolidation awaiting focused validation. Based on the clean PR stack at `ec4124ec76`. Owners: `issue-thread-interaction-routes.test.ts` and `interaction-resolution-cross-issue-cap-postgres.test.ts`. Production code is unchanged.

## Removed executions and retained proof

| Removed declaration | Retained keeper and transferred assertions |
| --- | --- |
| `allows the creator agent and creating run under anyone` | The existing five-kind `lets the creator and same run resolve $kind through anyone` matrix already uses the same creator agent, creating run, open policy, assigned issue, and successful HTTP boundary. Its service assertion now checks interaction ID, request body, and authenticated `agentId`/`runId` for every kind. |
| Four-row `fails a capped run closed on cross-issue $route with no interaction effect` | The real-routes/real-Postgres four-endpoint cap matrix checks the same 429 code, cap, count, enforcement mode and redaction, plus persisted pending interaction, no child task, no wake, and exactly the rejection activity. It now also checks actionable `Try this:` copy and rejection receipt `kind: interaction_resolution` / `allowed: false`. |
| `does not charge a same-issue resolution even past the cap` | The Postgres `leaves same-issue and board resolutions outside the counter` keeper seeds a fully spent run, resolves a same-issue interaction successfully, and verifies the observation count stays at the cap and the rejected count stays zero. |
| `leaves board resolutions outside the per-run counter` | The same Postgres keeper resolves a board request on a different issue successfully while preserving both persisted counter totals. |

The four positive cross-issue route wiring cases remain: each of `accept`, `reject`, `respond`, and `verdicts` must dispatch its own service exactly once and write one shared observation with source/target issue IDs. Postgres currently proves positive charging through `respond`; it therefore does not replace the other positive route wiring cases. Creator/run exclusion, addressed-agent authorization, human-only policy, trust/watchdog gates, native delivery, governed actions, interaction effects, and all remaining route cases remain.

## Savings and validation

Four declarations and seven expanded test executions are removed. The mocked route file changes from 3,404 to 3,295 lines (68 to 64 declarations); the Postgres file gains five net lines. Test files total **104 fewer lines** (12 inserted, 116 deleted). Seven repeated route requests and their per-test reset/import setup disappear. No production lines are removed. No wall-clock or CI saving is claimed without a comparable timing run.

Static review confirmed that the three dispatched service methods accept the asserted `(issue, interactionId, body, actor)` arguments. `git diff --check` passes. Supervisor validation passed both complete owner suites serially: route suite **79/79** in 43.41 seconds; real embedded-Postgres cap suite **7/7** in 15.63 seconds. The PostgreSQL suite ran (not skipped), including each capped endpoint and persisted no-effect checks. No mutation validation or runtime savings claim is made.
