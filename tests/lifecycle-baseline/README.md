# Lifecycle behavior baseline

This suite establishes a measurement before removing narrative/regex authority
from lifecycle decisions. The original baseline changes no production policy. Assertions describe
intended behavior; observed failures are retained rather than blessed as expected
outcomes. Subsequent fixes and fresh measurements are recorded separately.

## Recorded results moved to paperclip-evals

The 16 saved result JSON files and seven dated measurement reports now live in
[the lifecycle authority archive](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/README.md)
in the private `paperclip-evals` repository. Links below pin the archive commit.
The [migration manifest](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/manifest.json)
records original paths and checksums. JSON measurements are unchanged, including
failed and partial attempts; report edits only repair links to application files.

Executable tests, fixtures, graders, run commands, and the scenario inventory
remain here. These tests do not require the archive or access to the private
repository. New runs still write ignored local output under `.lifecycle-baseline/`;
archive retained measurements in `paperclip-evals`, with their source revisions
and coverage, instead of committing result snapshots to the app repository.

| Measurement | Archived report (private) | Published Product E2E report |
|---|---|---|
| September 21 — deterministic baseline | [Report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/BASELINE-2026-09-21.md) | Deterministic tests; run locally below |
| September 21 — initial live baseline | [Report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/LIVE-BASELINE-2026-09-21.md) | [Campaign 35672810261](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35672810261-1/index.html) |
| September 21 — cancellation and fixture fixes | [Report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/LIVE-FIXES-2026-09-21.md) | [Campaign 35680906634](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35680906634-1/index.html) |
| September 22 — continuation authority | [Report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/LEGACY-CONTINUATION-2026-09-22.md) | [Campaign 35747200170](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35747200170-1/index.html) |
| September 22 — explicit work mode | [Report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/EXPLICIT-WORK-MODE-2026-09-22.md) | [Campaign 35806360797](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35806360797-1/index.html) |
| September 22 — accounting baseline | [Report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-2026-09-22.md) | [Campaign 35813099816](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35813099816-1/index.html) |
| September 23 — accounting fixes and PR verification | [Report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-FIXES-2026-09-23.md) | [Campaign 35881382080](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-35881382080-1/index.html) |

The public reports remain available without private-repository access. Each
campaign measures its recorded source and selected cells; this index does not
combine them into one score or qualify later revisions. Large logs, traces,
videos, and browser reports stay in existing campaign artifact storage.

## Run and inspect

From an installed Paperclip checkout:

```sh
pnpm test:lifecycle-baseline --list
pnpm test:lifecycle-baseline unit
pnpm test:lifecycle-baseline runner
pnpm test:lifecycle-baseline integration
pnpm test:lifecycle-baseline grading
pnpm test:lifecycle-baseline
pnpm test:lifecycle-baseline:support
pnpm exec tsc -p tests/lifecycle-baseline/tsconfig.json
```

All four lanes are credential-free. The integration lane uses disposable embedded
Postgres and scripted providers. No command above invokes a model, starts a paid
campaign, or changes an existing Paperclip instance. Tests are outside default
server/workspace discovery; Product E2E matcher calibration remains in its normal
opt-in support suite. The baseline command returns nonzero on failed assertions,
missing evidence, or unavailable selected coverage. Ordinary CI is unaffected.

Each invocation retains an independent directory under `.lifecycle-baseline/`:

- `baseline.md` and `baseline.json`: scenario inventory joined to actual assertions;
- per-lane Vitest JSON: complete assertion results, durations, and failures;
- observation JSONL: fixture inputs/classifications and actual authority effects,
  including both sides of narrative pairs and persisted heartbeat outcomes;
- `source.diff`: tracked implementation delta from the recorded commit.

The commit plus fingerprint covers tracked differences and untracked authored
files. Keep the worktree or commit its tests with retained measurements when
comparing revisions. The scripted report marks live coverage `not_run`; use the separate live Actions
record for provider measurements. Authored definitions and passing grader
calibration are not proof of real provider behavior. A test
suite that cannot load is an evidence/harness failure, not a product finding.
Skips are unavailable coverage, never a pass. Failed assertions require triage;
raw runner/provider text is not uploaded by this command.

## Scenario inventory

`inventory.mjs` is the executable mapping. References to existing suites reuse
their actual assertions rather than duplicating test bodies or counting catalog
entries as executed tests. The report records which matching assertions ran.

| ID | Scenario | Contract |
|---|---|---|
| LCA-01 | Ordinary completion | Valid completion, delivered response, no extra execution |
| LCA-02 | Productive multiple turns | Continue appropriate work without repeating completed operations |
| LCA-03 | Human question | Durable question, matching response, one causal continuation |
| LCA-04 | Approval/decline | Correct actor and approval; other admission gates still apply |
| LCA-05 | Planning/revision | Work mode and exact accepted revision authorize execution |
| LCA-06 | Dependencies | Satisfied dependency condition wakes the parent once |
| LCA-07 | External monitor | Durable eligible wait, one-shot wake, bounded expiry/retry |
| LCA-08 | Conversation | Deliver the reply without forcing task completion or repair loops |
| LCA-09 | Missing disposition | Bounded explicit repair; comments/restarts do not reset attempts |
| LCA-10 | Stop/pause/budget | Preserve distinct semantics; no unauthorized continuation |
| LCA-11 | Terminal ordering | Completion report, provider terminal, and cleanup remain distinct |
| LCA-12 | Replay/restart/ownership | Preserve receipts and budgets; fence stale finalizers |
| LCA-13 | Review | Concrete reviewer/owner and authoritative review outcome |

Troublesome combinations included in the inventory and reused suites:

- Completion followed by failure/cancellation or stream closure without terminal.
- Approval while paused/over budget; response arriving during input handoff/cleanup.
- Reassignment/closure before late finalization; restart between commit and delivery.
- Exhaustion followed by commentary versus an authorized new user request.
- Stale plan revision approval; duplicate question/dependency/reconciler events.
- Wrong company/task or unauthorized resolution; productive versus failure retries.

## Narrative pairs and positive controls

`authority.test.ts` records the legacy classifier for diagnostic comparison and
executes the production structured continuation decision. Assertions compare
scheduling decisions rather than requiring diagnostic labels to be identical.
The persisted legacy authority tests cover replay, restart, exhaustion and
dispatch gates; they also run in the ordinary server suite. Native pairs exercise the actual
status arbiter. The heartbeat cases cross the real persistence/finalization
boundary for both runtimes, including explicit native continuation and the legacy
missing-disposition path. Observations precede cleanup; a second queue/drain pass
checks for additional dispatch. This is not proof about arbitrary future timers:
the existing monitor/retry/reconciler suites separately exercise due-time policy.

Vary summaries/results, existing comment bodies, continuation summaries, stdout,
stderr, titles, and descriptions. Variants cover negation, historical quotation,
Spanish, optional next steps, unsupported completion claims, encouraging prose,
and empty narrative. Commentary-only evidence must not manufacture progress.
Keep authority identical for each pair. Positive controls change real status,
approval, continuation, budget, or ownership with identical prose. New authenticated
user messages are separate causal events, not interchangeable text.

Scripted runner tests validate actual session/event behavior and structured-result
contracts. They do not prove OS termination or real provider compliance. Native
replacement tests inject verifier evidence at their documented boundary. Route
unit tests mock services; database suites test persisted application behavior.
These proof boundaries must remain visible when interpreting the baseline.

## Live evals

The dedicated [live lifecycle suite](../runner-e2e/LIFECYCLE-BASELINE.md) adds
40 explicitly selected real-LLM/browser cells on both runtime generations.
It was authored after the initial scripted baseline and has now run on GitHub
Actions; see the separate live record for measured outcomes. Use
`pnpm test:e2e:runner -- --list --suite lifecycle-baseline` to inspect it.

Product E2E uses the existing `continuation`, `agent-chat`, and
`everyday-workflows` catalogs. Continuation now retains an explicit lifecycle
snapshot at each browser checkpoint and grades pending question identity, plan
revision binding, original run receipts, and the absence of execution/recovery
paths after completion. The grader has valid/wrong/missing-evidence calibration.
The continuation definition version advances so measurements are distinguishable.

Validate/discover without spending:

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list --suite continuation
pnpm test:e2e:runner -- --list --suite agent-chat
pnpm test:e2e:runner -- --list --suite everyday-workflows
```

The sibling `paperclip-evals` change adds the opt-in
`rosters/live-lifecycle-narrative-baseline.json`: ordinary finish/block controls, two
misleading-summary variants, and question/review/dependency/wake cases. It does
not expand the maintained paid campaign. Both cases and the roster are validated
without providers; successful, wrong-state, missing-tool, and extra-wake evidence
calibrate their actual grader.

For subsequent live execution use existing explicit selectors and record exact
App/Evals revisions, profile/environment, retries, usage/cost, and artifact IDs.
See `doc/evals.md`. Do not combine mock-authority Runner Eval scores with Product
E2E scores, or claim full qualification from a partial selection.

September 22 follow-up: [legacy continuation implementation and verification](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/LEGACY-CONTINUATION-2026-09-22.md), including preserved failed campaigns and the remaining backlog.

The [continuation accounting matrix](../../doc/plans/2026-09-22-continuation-accounting-baseline.md) adds ACCT-01 through ACCT-04 for separate allowances, false progress, late gates and restart/replay. Its real-provider companion is the explicit-only `continuation-accounting` Product E2E suite.
The [September 22 measurement](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-2026-09-22.md) records the
enabled failures and preserves both initial and corrected live campaigns.
The [September 23 fixes and fresh verification](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-FIXES-2026-09-23.md)
retain the original measurements and cover separate persisted allowances, delayed
repair promotion and the current native question/response continuation contract.

The inexpensive browser regressions use real Chromium without a provider or
Paperclip instance. They check screenshot readiness and development service-worker
module revalidation across repeated reloads:

```sh
pnpm exec playwright test --config tests/runner-e2e/playwright-support.config.ts
```

Set `PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome` to use an installed Chrome browser.
