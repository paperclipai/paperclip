# TSBC-1549 Reconciliation — Grok 4.5 Hermes-lean engineer/cto evidence bank

Date: 2026-07-30T15:41:28+00:00
Parent: TSBC-1543
Agent: Bench-grok-4.5-hermes-lean (95135c2f-1233-4c04-baa4-b46a0963743d)
Live routing changed: false
Published: false
Duplicated TSBC-1542: false
Overall verdict: `decision_grade_bank`

## Mandate compliance

- CLI subscription surfaces only (no console/API key requested)
- Power file respected; lane workers=1 (maxConcurrentRuns discipline)
- Source+render under `work-products/TSBC-1543/TSBC-1549/`
- Text-benchmark work only

## Provenance caveats (do not merge into clean/current/minimal)

1. **Shared HERMES_HOME with clean:** `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1153/hermes-clean-profile-v2/.hermes` — lean is NOT isolated at the Hermes profile-home layer. Distinguish via model label `grok-4.5-hermes-lean`, agent id, and lean cell agent-file SHA `a3fe5d96277ee604cb0acd75532bcf2f403afa514220ea1430ca68c218546715`.
2. **agentFile meta label:** probe meta says `agentFile=current` because the CLI enum has no `lean`; actual body is the lean cell override (`agentFileSourceKind=override`).

## Suite 1 — engineer (DECISION-GRADE)

| Field | Value |
|---|---|
| Run | `probe-20260730-161626` |
| Model | `grok-4.5-hermes-lean` |
| Adapter | hermes / single_shot_concat |
| Tasks × reps | 12 × 3 = 36 samples |
| okCount | 36/36 (successRate=1.0) |
| meanQuality / minQuality | 0.9640 / 0.7833 |
| q/1k-out | 6.8298 |
| mean out/in tokens | 175.0 / 423.3 |
| Suite SHA-256 | `b7373c2152d432ffadaa313c61133d110457a1e56402bf122dab21c5460d183f` |
| Prompt packet SHA-256 | `beed9cf7bee25221637413b48da327168da33e217c2c4542cdda4f96cc730b89` |
| Agent-file SHA-256 | `a3fe5d96277ee604cb0acd75532bcf2f403afa514220ea1430ca68c218546715` |
| Served | ['grok-4.5'] |

### Counts by task

| Task | samples | ok | meanQ | minQ |
|---|---:|---:|---:|---:|
| eng-concurrency-race | 3 | 3 | 0.9645833333333333 | 0.9575 |
| eng-failure-classify | 3 | 3 | 1.0 | 1.0 |
| eng-flaky-test-diagnose | 3 | 3 | 0.96875 | 0.9525 |
| eng-idempotency-bug | 3 | 3 | 0.95875 | 0.95625 |
| eng-nplus1-fix | 3 | 3 | 0.985 | 0.9774999999999999 |
| eng-prefix-router | 3 | 3 | 1.0 | 1.0 |
| eng-scorecard-sql-bug | 3 | 3 | 0.98 | 0.9625 |
| eng-sql-injection | 3 | 3 | 0.9758333333333333 | 0.95625 |
| eng-stale-reap-default-bug | 3 | 3 | 0.8605555555555556 | 0.7833333333333333 |
| eng-timezone-offbyone | 3 | 3 | 0.9866666666666667 | 0.9825 |
| eng-token-normalizer | 3 | 3 | 0.9966666666666667 | 0.99 |
| eng-unsafe-migration | 3 | 3 | 0.8914880952380952 | 0.8473214285714286 |

### Artifact paths (engineer)

- Canonical: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-161626/`
- Issue bank: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1543/TSBC-1549/engineer/probe-20260730-161626/`

## Suite 2 — cto (DECISION-GRADE)

| Field | Value |
|---|---|
| Run | `probe-20260730-162918` |
| Model | `grok-4.5-hermes-lean` |
| Adapter | hermes / single_shot_concat |
| Tasks × reps | 12 × 3 = 36 samples |
| okCount | 34/36 (successRate=0.944444) |
| failCount | 2 (cto-escalate-to-mc rep03, cto-eng-load-balance rep03) |
| meanQuality / minQuality | 0.9616 / 0.7286 |
| q/1k-out | 21.5132 |
| mean out/in tokens | 69.4 / 452.8 |
| Suite SHA-256 | `9178417ea7411729ec604cd6f0f72637a785d4d0f99ddd564fdfd0d4d603c31d` |
| Prompt packet SHA-256 | `f6db83e6192b3aeff74fc255e4ebbcaff47c0b3df38b77cc86952e360fb7ed0c` |
| Agent-file SHA-256 | `a3fe5d96277ee604cb0acd75532bcf2f403afa514220ea1430ca68c218546715` |
| Served | ['grok-4.5'] |

### Counts by task

| Task | samples | ok | meanQ | minQ |
|---|---:|---:|---:|---:|
| cto-build-vs-buy-judge | 3 | 3 | 0.9645833333333333 | 0.95 |
| cto-code-review-security-bug | 3 | 3 | 0.9766666666666667 | 0.96875 |
| cto-eng-load-balance | 3 | 2 | 0.9875 | 0.9875 |
| cto-escalate-to-mc | 3 | 2 | 1.0 | 1.0 |
| cto-fallback-monitor-adapter-trap | 3 | 3 | 0.9125000000000001 | 0.83875 |
| cto-fallback-monitor-option | 3 | 3 | 0.9833333333333334 | 0.97875 |
| cto-gate-keeper-capability-design | 3 | 3 | 0.839047619047619 | 0.7285714285714285 |
| cto-local-only-relay-mismatch | 3 | 3 | 0.9520833333333334 | 0.9437500000000001 |
| cto-plan-approval-gate | 3 | 3 | 0.9766666666666666 | 0.975 |
| cto-reject-overengineering | 3 | 3 | 0.99125 | 0.98625 |
| cto-reject-restart-race-default | 3 | 3 | 0.9716666666666667 | 0.96875 |
| cto-reversibility-rollout | 3 | 3 | 0.9841666666666667 | 0.9825 |

### Artifact paths (cto)

- Canonical: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-162918/`
- Issue bank: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1543/TSBC-1549/cto/probe-20260730-162918/`

## quant

Not run. Engineer+cto already decision-grade; packet priority satisfied.

## Ledger

- 12 engineer + 12 cto `task_probe` rows appended by `tsbc_task_probe.py` to `benchmark/ledger/results.jsonl`
- Merge policy: **do not** fold into clean/current/minimal recommendation rows
