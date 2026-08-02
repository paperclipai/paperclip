# TSBC-1248 Progress — 2026-07-25

Wake context

- Wake payload had `0` new comments and identified this run as scoped recovery for [TSBC-1248](/TSBC/issues/TSBC-1248) after a `codex_local` provider-quota failure.
- During execution I also incorporated the latest board scope correction comment on [TSBC-1248](/TSBC/issues/TSBC-1248): the issue now owns the full six-rung ladder, with rung 1 still blocking the failover decision and rung 2-5 deferred until rung 1 is complete.

What this heartbeat proved

- A reusable Hermes rung-1 path exists for `grok-4.5` when the benchmark overrides the catalog entry to `adapter=hermes`, `lane=hermes`, and runs with:
  - `HERMES_HOME=/Users/glad0s/paperclip/work-products/TSBC-1248/hermes-r1-ops-sample1-proven-home/.hermes`
  - `HERMES_IGNORE_RULES=1`
  - Hermes extra args `--ignore-user-config --ignore-rules`
- The proven base profile was cloned from the TSBC-1153 clean rig under the company work-products tree.
- First completed bare rung-1 sample:
  - Run ID: `run-20260725-214141`
  - Suite: `ops`
  - Model: `grok-4.5`
  - Judge: `claude-opus`
  - Adapter type: `hermes`
  - Quality: `0.987`
  - Success: `10/10` tasks
  - Suite hash: `af81fcc8c8acf9b45aac20aa118d2e0116e4e875fd9b8b4e4f07df614a7bef25`
- The run appended a real bare `kind=model_eval` row to `benchmark/ledger/results.jsonl`.

Parallelization created this heartbeat

- [TSBC-1265](/TSBC/issues/TSBC-1265) — `ceo`, `ops`, `content` on Bench-grok-4.5-hermes-minimal
- [TSBC-1266](/TSBC/issues/TSBC-1266) — `cto`, `ledger`, `cv-review` on Bench-grok-4.5-hermes-current
- [TSBC-1267](/TSBC/issues/TSBC-1267) — `engineer`, `auditor`, `quant` on Bench-grok-4.5-hermes-lean
- Existing dependency: [TSBC-1262](/TSBC/issues/TSBC-1262) for the `paperclip` suite rerun coordinated with [TSBC-1141](/TSBC/issues/TSBC-1141)

Files preserved here

- `work-products/TSBC-1248/evidence/run-20260725-214141/report.md`
- `work-products/TSBC-1248/evidence/run-20260725-214141/recommendations.json`
- `work-products/TSBC-1248/evidence/run-20260725-214141/runs.json`
- `work-products/TSBC-1248/evidence/run-20260725-214141/ledger-row.json`
- `work-products/TSBC-1248/evidence/config-r1-hermes-grok-4.5.json`
