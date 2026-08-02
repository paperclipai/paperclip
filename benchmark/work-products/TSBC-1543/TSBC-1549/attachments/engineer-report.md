# TSBC Task Probe — `probe-20260730-161626`

- Role: `engineer`
- Cell: `current + none`
- Tasks: `eng-failure-classify, eng-scorecard-sql-bug, eng-prefix-router, eng-concurrency-race, eng-stale-reap-default-bug, eng-token-normalizer, eng-nplus1-fix, eng-sql-injection, eng-flaky-test-diagnose, eng-unsafe-migration, eng-idempotency-bug, eng-timezone-offbyone`
- Models: `grok-4.5-hermes-lean`
- Reps: `3`
- Judge: `claude-opus`
- Effort override: `cli_default`
- Probe frame policy: `auto_agentic_antigravity_non_bare_for_book-content-cv`
- Planned generation methods: `grok-4.5-hermes-lean=single_shot_concat`
- Agent-file source: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1543/TSBC-1549/agent-files/TSBC-1549-lean-cell.md` (override)
- Skills source: `/Users/glad0s/.paperclip/instances/default/skills/e6361895-a6a4-438d-bb76-b17a0ad026cb/__runtime__` (variants_json)
- Suite source: `/Users/glad0s/paperclip/benchmark/engineer/suite.json`
- Agent-file sha256: `a3fe5d96277ee604cb0acd75532bcf2f403afa514220ea1430ca68c218546715`
- Skills bundle sha256: `none`
- Suite sha256: `b7373c2152d432ffadaa313c61133d110457a1e56402bf122dab21c5460d183f`
- Probe context sha256: `989122a4ec186f6726a40c5aa03c447c17cc147b333814fa2e1b4d8d43a5afbd`
- Prompt packet sha256: `beed9cf7bee25221637413b48da327168da33e217c2c4542cdda4f96cc730b89`

## Overall

| model | frame | effort | tasks | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-lean | single_shot_concat | cli_default | 12 | 36 | 36 | 0.964 | 0.783 | 175.0 | 423.3 | 6.830 |

## Per Task

| model | frame | effort | task | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-concurrency-race | 3 | 3 | 0.965 | 0.958 | 157.3 | 447.0 | 6.152 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-failure-classify | 3 | 3 | 1.000 | 1.000 | 47.0 | 482.0 | 21.363 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-flaky-test-diagnose | 3 | 3 | 0.969 | 0.953 | 170.7 | 444.0 | 5.753 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-idempotency-bug | 3 | 3 | 0.959 | 0.956 | 170.7 | 454.0 | 5.621 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-nplus1-fix | 3 | 3 | 0.985 | 0.977 | 255.7 | 389.0 | 3.879 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-prefix-router | 3 | 3 | 1.000 | 1.000 | 149.0 | 363.0 | 6.711 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-scorecard-sql-bug | 3 | 3 | 0.980 | 0.963 | 170.0 | 399.0 | 5.816 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-sql-injection | 3 | 3 | 0.976 | 0.956 | 172.7 | 399.0 | 5.704 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-stale-reap-default-bug | 3 | 3 | 0.861 | 0.783 | 126.0 | 424.0 | 6.817 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-timezone-offbyone | 3 | 3 | 0.987 | 0.983 | 182.7 | 465.0 | 5.485 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-token-normalizer | 3 | 3 | 0.997 | 0.990 | 167.0 | 383.0 | 5.968 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | eng-unsafe-migration | 3 | 3 | 0.891 | 0.847 | 331.7 | 431.0 | 2.689 |

## TSBC Fairness Closeout (required before recommendation)

- Run IDs: `probe-20260730-161626`
- Issue-close PDF artifact: attach `TSBC-<issue>-report.pdf` before closing any TSBC test issue
- PDF contents: hypothesis, method, data, verdict `CONFIRMED` / `REFUTED` / `INCONCLUSIVE`, dispatched follow-up key
- Repetitions per compared cell: `3`
- Scorer lane: `claude-opus`
- Scorer calibration status: `pass` / `pass_with_caveat` / `needs_calibration` / `failed`
- Calibration set: record the known-good / known-bad / borderline anchors, or `not_preserved:<why missing>`.
- Tie-break owner: name the human or agent adjudicator, or `not_preserved:<why missing>`.
- Fairness verdict: `pass` / `pass_with_caveat` / `fail`
- Evidence depth: `directional` / `candidate` / `decision_grade` / `production_locked`
- Low-tail / min-score note: cite the relevant `minQ` values from the tables above and explain any task-level collapse.
- Token / cost / runtime note or caveat: summarize the token movement shown above and record runtime/cost or an explicit caveat if missing.
- Scorer caveat: record scorer separation/calibration status and whether human review is still required.
- Fingerprint: use `<opco-or-portfolio>:<task-surface>:<lane>:<suite-or-run-id>:<date>`, or `not_preserved:<why missing>`.
- Model version(s): `grok-4.5-hermes-lean`
- Scorer/rubric version: record the exact rubric + judge version, or `not_preserved:<why missing>`.
- Environment: `TSBC task-probe harness; role=engineer; cell=current+none; finished=2026-07-30T15:28:45+00:00`
- Records path: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-161626/report.md`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-161626/records.json`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-161626/summary.json`
- Suite hash: `b7373c2152d432ffadaa313c61133d110457a1e56402bf122dab21c5460d183f` (`/Users/glad0s/paperclip/benchmark/engineer/suite.json`)
- Prompt/system hash: `beed9cf7bee25221637413b48da327168da33e217c2c4542cdda4f96cc730b89` (agent `a3fe5d96277ee604cb0acd75532bcf2f403afa514220ea1430ca68c218546715`, skills `none`)
- Failure-library IDs: list created/referenced IDs, or `none` with why that absence is meaningful.
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable.
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`

> This probe report is evidence, not a finished TSBC closeout. Fill the checklist above in the issue or polished report, render the branded PDF artifact, and attach `TSBC-<issue>-report.pdf` before updating catalog rows or adoption recommendations.
