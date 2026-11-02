# Opt-in CI profiling

Goal: label a PR `profile-ci`, run the complete main PR suite, and open one
Honeycomb waterfall showing the full elapsed timeline. Use that evidence to
decide which CI work to speed up or remove. CI optimizations themselves are a
follow-up, not part of this change.

## Acceptance

| Case | Required behavior | Evidence |
| --- | --- | --- |
| Unlabeled PR | Existing scope and commands; no profile export | Routing and exporter tests |
| Labeled CI CODEOWNER PR, including stacked/release-notes-only | All main PR lanes run | Routing tests and full-run job inventory |
| Completed profile | One trace per run attempt; every job and step uses actual timestamps | Honeycomb waterfall reconciled against GitHub job API |
| Parallel work | Shared wall clock, with waiting and execution distinguishable | Overlapping lanes and root duration checked against GitHub |
| Tests | Vitest and Playwright file/test timings under their job/step; Node test timings where supported | Real reporter smoke runs and hierarchy checks |
| Failure/cancellation/rerun | Preserve completed timing data; mark missing coverage; attempts stay separate | Exporter regression cases |
| Credentials | Master-only environment owns ingest secret; trusted exporter verifies CI CODEOWNER author and actors; PR jobs only write timing artifacts | Workflow review, hostile-identity cases, and environment settings |

Scope: the main `PR` workflow and every lane of `pr-trusted.yml`, including
policy, build, typecheck/release-registry, general/serialized test shards,
Runner checks, canary, and browser E2E. Separate release/deploy/live-provider
workflows remain outside this first trace. Rust checks are visible as complete
job/step timings; stable libtest does not provide per-test wall-clock reports.
No sampling inside a selected run.

## State

- Branch: `codex/ci-honeycomb-profiling` in the existing `76aa` worktree.
- PR: https://github.com/paperclipai/paperclip/pull/16378
- Baseline: GitHub run `38671274294`, 48 jobs, 479 seconds from creation to last
  job completion. Raw GitHub evidence is in `/tmp/paperclip-ci-profile-evidence`.
- Honeycomb: existing `paperclip` team / `test` environment; dedicated `paperclip-ci`
  dataset. Authorized local configuration key ingested the historical baseline;
  verified 731 spans and 7m 59s in the [live Honeycomb waterfall](https://ui.honeycomb.io/paperclip/environments/test/datasets/paperclip-ci/trace/oaPMzw8zGwG).
- Implemented label selection, full-suite override, test timing reporters, trusted
  post-run exporter, direct waterfall link, and missing-data diagnostics.
- Verified: 48-job / 731-span historical reconstruction; 508 workflow/reporter/shard
  checks; real root-config probe with 13 tests and one file span; full Node 24
  typecheck and build. The local full Vitest run was stopped after a setup-token
  timeout and a distribution-plugin-catalog fixture failure. The setup-token
  suite passed on focused rerun; the directory-symlink removal failure reproduces
  with the unchanged base configuration and test/service files on this macOS
  Node 24.11.0 host. The PR body records the latest remote CI and review results.
- Created and verified the repository `profile-ci` label. Dedicated Honeycomb
  ingest key `paperclip-ci-profile` has no dataset-creation permission. It is
  stored only as `HONEYCOMB_CI_API_KEY` in the `ci-profiling` GitHub environment,
  restricted to the `master` branch. Temporary key file removed; both credentials
  scanned absent from repository files and branch history.
- Added CODEOWNER author/actor authorization and rejection tests, plus CODEOWNERS
  coverage of the privileged exporter.
- Review fixes: retain `node --test` for older checked-out revisions; record expected
  invocations outside reporters to detect wholly missing reporters. The shard
  inventory now writes synchronously before exit after reproducing truncation
  on both the unchanged baseline and working branch.
- Real partial-rerun evidence showed GitHub carrying old successful jobs into
  the new attempt's inventory with the new attempt number. Exclude jobs whose
  completion precedes the attempt start, and record their count explicitly.
- Delivery: reviewable PR and live Honeycomb evidence. Activation of new trusted
  workflow definitions requires merge to master; do not claim pre-merge evidence
  proves the post-merge label-triggered journey.
