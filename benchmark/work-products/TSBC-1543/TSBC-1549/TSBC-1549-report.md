# TSBC-1549 Report — Grok 4.5 Hermes-lean engineer/cto evidence bank

**Parent:** TSBC-1543  
**Model lane:** grok-4.5-hermes-lean  
**Agent:** Bench-grok-4.5-hermes-lean (hermes_local)  
**Date:** 2026-07-30  
**Overall verdict:** `decision_grade_bank`  
**Live routing changed:** false · **Published:** false · **Duplicated TSBC-1542:** false

## Mandate compliance

- CLI subscription surfaces only (no console/API key)
- Power file respected; maxConcurrentRuns=1 discipline for this lane (workers=1)
- Source + render under `work-products/TSBC-1543/TSBC-1549/`
- Text-benchmark work only; no live routing changes

## Decision-grade tally

| Suite | Run | samples | ok | success | meanQ | minQ | q/1k-out | Decision-grade |
|---|---|---:|---:|---:|---:|---:|---:|:---:|
| engineer | probe-20260730-161626 | 36 | 36 | 1.000 | 0.9640 | 0.7833 | 6.830 | YES |
| cto | probe-20260730-162918 | 36 | 34 | 0.944 | 0.9616 | 0.7286 | 21.513 | YES |
| quant | — | — | — | — | — | — | — | deferred |

## Provenance caveats

- Lean lane shares `HERMES_HOME` with hermes-clean-profile-v2. Do **not** merge into clean/current/minimal verdicts.
- Lean cell agent-file SHA-256: `a3fe5d96277ee604cb0acd75532bcf2f403afa514220ea1430ca68c218546715`
- Requested model id: `grok-4.5-hermes-lean` · served model_arg: `grok-4.5` · adapter: hermes (Paperclip agent adapterType hermes_local)

## engineer detail

- Suite SHA: `b7373c2152d432ffadaa313c61133d110457a1e56402bf122dab21c5460d183f`
- Prompt packet SHA: `beed9cf7bee25221637413b48da327168da33e217c2c4542cdda4f96cc730b89`
- Cell: lean override + skills=none · frame: single_shot_concat · judge: claude-opus · reps: 3

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

## cto detail

- Suite SHA: `9178417ea7411729ec604cd6f0f72637a785d4d0f99ddd564fdfd0d4d603c31d`
- Prompt packet SHA: `f6db83e6192b3aeff74fc255e4ebbcaff47c0b3df38b77cc86952e360fb7ed0c`
- Cell: lean override + skills=none · frame: single_shot_concat · judge: claude-opus · reps: 3
- Two generation failures (not quality zeros): cto-escalate-to-mc rep03, cto-eng-load-balance rep03 — success still 34/36 ≥ 0.8 floor

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

## Evidence paths

- WP root: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1543/TSBC-1549`
- Engineer results: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-161626/`
- CTO results: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-162918/`
- Ledger: `/Users/glad0s/paperclip/benchmark/ledger/results.jsonl` (+24 task_probe rows)
- Config: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1543/TSBC-1549/config/config-grok-4.5-hermes-lean.json`
- Lean cell: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1543/TSBC-1549/agent-files/TSBC-1549-lean-cell.md`

## Close checklist

- [x] Raw session/probe evidence banked under work-products
- [x] Ledger delta note
- [x] Machine-readable verdict.json
- [x] Branded TSBC-1549-report.pdf (this report rendered)
- [x] No publish / no live routing
