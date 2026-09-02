# Stress-derived Runner workflow evals

The Runner workflow eval system turns the `STRESS-001`–`STRESS-044` campaign
into complementary deterministic, live, and chaos lanes. It is additive to the
capability inventory, capability cases, and existing scoring/report readers.

The workspace-private `@paperclipai/paperclip-eval-kernel` package owns only
structural scenario-by-candidate orchestration. Runner-specific cases,
observations, scoring, traceability, and report rendering remain package-local.

## Lanes

- `pnpm --filter @paperclipai/paperclip-runner test:runner-workflow-evals`
  runs the credential-free PR gate over sanitized Codex, OpenCode, and ACPX
  normalization fixtures.
- `pnpm --filter @paperclipai/paperclip-runner report:runner-workflow-evals`
  validates the deterministic report and writes JSON, Markdown, JUnit, and
  GitHub-safe artifacts under `.paperclip-local/evals/workflows/` only when all
  scoreable fixture results pass. It makes no network requests.
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

The hosted live workflow is default-branch-only and requires an allowlisted
numeric actor plus the protected `runner-e2e-paid` environment. Scheduled runs
also remain disabled until `RUNNER_LIVE_EVALS_NIGHTLY_ENABLED` is explicitly
set to `true`.

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
