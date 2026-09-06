# Stress-derived Runner workflow evals

The Runner workflow eval system turns the `STRESS-001`–`STRESS-044` campaign
into complementary deterministic, live, and chaos lanes. It is additive to the
capability inventory, capability cases, and existing scoring/report readers.

The workspace-private `@paperclipai/paperclip-eval-kernel` package owns only
structural scenario-by-candidate orchestration. Runner-specific cases,
observations, scoring, and traceability remain package-local. The HTML matrix is
rendered by the canonical `paperclip-evals` report program so live results use
the same grid and drill-down pages as the direct Runner eval suite.

## Lanes

- `pnpm --filter @paperclipai/paperclip-runner test:runner-workflow-evals`
  runs the credential-free PR gate over sanitized Codex, OpenCode, and ACPX
  normalization fixtures.
- `pnpm --filter @paperclipai/paperclip-runner report:runner-workflow-evals`
  validates the deterministic fail-closed fixture matrix and writes JSON,
  Markdown, JUnit, and GitHub-safe artifacts under
  `.paperclip-local/evals/workflows/`. It makes no network requests.
- `pnpm --filter @paperclipai/paperclip-runner report:runner-live-evals` runs
  the balanced forty-execution schedule against real provider sessions. Live
  candidate failures are trend-only; missing credentials, qualification
  failures, and provider outages remain unscored.
- `pnpm --filter @paperclipai/paperclip-runner report:runner-chaos-evals`
  writes the eight-scenario fault schedule consumed by weekly and pre-release
  restart, replay, trace, finalization, interaction, and wake-race suites.

The checked-in live manifest contains only adapter/model settings,
qualification variable names, and budgets. Credentials remain in the
environment. `PAPERCLIP_EVAL_MAX_CAMPAIGN_COST_USD` must be a positive finite
number and defaults to 12 USD for scheduled runs.

Live executions export one immutable Evalbook attempt per workflow/candidate to
`.paperclip-local/evals/workflows/evalbook-runs/`, then invoke
`evals/paperclip-runner/tools/eval_program.py report` from a `paperclip-evals`
checkout. That program writes the canonical matrix to
`.paperclip-local/evals/workflows/index.html`, plus `latest.html`, test pages,
and attempt pages. Set `PAPERCLIP_EVALBOOK_PROGRAM` to the program's absolute
path or `PAPERCLIP_EVALS_ROOT` to its repository root. Conventional sibling
worktree locations are discovered automatically. GitHub Actions checks out a
pinned `paperclip-evals` revision, so every hosted run uses the same reviewed
report implementation rather than a copied or package-local renderer.
Filtered reports with only a few candidates expand their result columns to the
available viewport, keeping the PASS, FAIL, and INFRA labels visible without a
horizontal scroll. Full matrices retain the canonical scrollable grid and
sticky test-name column.

The exported artifact contains only the safe workflow observation and
scorecard. Prompts, credentials, raw provider frames, tool arguments, and
reasoning remain excluded. `evalbook-manifest.json` records the generator path
and SHA-256 digest used for the render.

Local and manual GitHub runs can bound paid execution with comma-separated
`--candidate` and `--case` selectors plus `--limit`. For example,
`report:runner-live-evals -- --candidate codex-luna --limit 2` executes only
the first two Codex entries in that week's validated schedule. Subsets receive
a distinct bundle identity and do not contaminate full-campaign trend history.

The hosted live workflow is default-branch-only and requires an allowlisted
numeric actor plus the protected `runner-e2e-paid` environment. Scheduled runs
also remain disabled until `RUNNER_LIVE_EVALS_NIGHTLY_ENABLED` is explicitly
set to `true`. The paid job uses the full-stack workflow's literal runner
selection: `RUNNER_E2E_AWS_ENABLED=true` routes it to the RunsOn Fleet, and any
other value uses `ubuntu-latest`.

## Trace and reasoning safety

Live executions capture provider frames in a run-local mode-`0600` sidecar.
The evaluator verifies byte lengths, SHA-256 digests, order, dispositions, and
lineage, retains only redacted observations plus a digest, and destroys the
temporary trace after execution. Prompts, credentials, tool arguments, and
reasoning text never enter reports or uploaded artifacts. Evals measure visible
progress and activity; they do not inspect or grade hidden chain of thought.

## Compatibility and trends

Live bundle identity includes the Runner version/build, prompt policy, schedule
seed, adapters, resolved models, and reasoning settings. Seven-day comparisons
use only matching bundle IDs, and alerts stay disabled until seven compatible
reports exist. Safe reports are retained for 30 days; raw traces are not
uploaded.

The checked traceability manifest is
`spec/evals/stress-workflow-traceability.json`; CI fails for missing findings,
unknown workflow IDs, or missing regression-test anchors.
