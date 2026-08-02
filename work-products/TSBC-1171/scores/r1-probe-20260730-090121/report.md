# TSBC Task Probe — `probe-20260730-090121`

- Role: `cv-review`
- Cell: `current + none`
- Tasks: `cv-title-inflation-gap, cv-unsubstantiated-metrics, cv-role-mismatch, cv-clean-calibration, cv-date-inconsistency, cv-pii-overshare, cv-benign-contract-overlap, cv-explained-career-break, cv-keyword-stuffed-role-mismatch, cv-team-metric-attribution`
- Models: `grok-4.5-hermes-clean`
- Reps: `3`
- Judge: `claude-opus`
- Effort override: `cli_default`
- Probe frame policy: `auto_agentic_antigravity_non_bare_for_book-content-cv`
- Planned generation methods: `grok-4.5-hermes-clean=single_shot_concat`
- Agent-file source: `/Users/glad0s/.paperclip/instances/default/projects/e212ce50-b524-408c-b3d4-0c6108d8c2e2/f71e8665-3f38-4920-b777-348ec85b9071/_default/work-products/TSBC-1171/candidates/r1-lean-zero-skill.md` (override)
- Skills source: `/Users/glad0s/paperclip/benchmark/variants/skills/cv-review` (variants_json)
- Suite source: `/Users/glad0s/paperclip/benchmark/cv-review/suite.json`
- Agent-file sha256: `28da1e97d8a312aca0cd50602d712ffb8a243d0f564213632b72374c7371ab04`
- Skills bundle sha256: `none`
- Suite sha256: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`
- Probe context sha256: `d6fecef39db346812757689d8b5152d9ea24cea8c1d5260ee22c9516367d67ae`
- Prompt packet sha256: `0ad397d3a31b7e3c456e854ecc5dd2581bae9008bd54277076a14c047f85c077`

## Overall

| model | frame | effort | tasks | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-clean | single_shot_concat | cli_default | 10 | 30 | 30 | 0.963 | 0.625 | 160.1 | 511.3 | 12.558 |

## Per Task

| model | frame | effort | task | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-benign-contract-overlap | 3 | 3 | 1.000 | 1.000 | 156.7 | 531.0 | 6.456 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-clean-calibration | 3 | 3 | 1.000 | 1.000 | 38.3 | 509.0 | 64.190 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-date-inconsistency | 3 | 3 | 1.000 | 1.000 | 108.3 | 475.0 | 9.414 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-explained-career-break | 3 | 3 | 1.000 | 1.000 | 104.7 | 561.0 | 10.004 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-keyword-stuffed-role-mismatch | 3 | 3 | 1.000 | 1.000 | 172.0 | 541.0 | 5.827 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-pii-overshare | 3 | 3 | 1.000 | 1.000 | 123.7 | 492.0 | 8.177 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-role-mismatch | 3 | 3 | 1.000 | 1.000 | 99.3 | 478.0 | 10.158 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-team-metric-attribution | 3 | 3 | 0.625 | 0.625 | 210.7 | 531.0 | 3.007 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-title-inflation-gap | 3 | 3 | 1.000 | 1.000 | 168.7 | 504.0 | 5.946 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-unsubstantiated-metrics | 3 | 3 | 1.000 | 1.000 | 418.3 | 491.0 | 2.398 |

## TSBC Fairness Closeout (required before recommendation)

- Run IDs: `probe-20260730-090121`
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
- Model version(s): `grok-4.5-hermes-clean`
- Scorer/rubric version: record the exact rubric + judge version, or `not_preserved:<why missing>`.
- Environment: `TSBC task-probe harness; role=cv-review; cell=current+none; finished=2026-07-30T08:15:03+00:00`
- Records path: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-090121/report.md`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-090121/records.json`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-090121/summary.json`
- Suite hash: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61` (`/Users/glad0s/paperclip/benchmark/cv-review/suite.json`)
- Prompt/system hash: `0ad397d3a31b7e3c456e854ecc5dd2581bae9008bd54277076a14c047f85c077` (agent `28da1e97d8a312aca0cd50602d712ffb8a243d0f564213632b72374c7371ab04`, skills `none`)
- Failure-library IDs: list created/referenced IDs, or `none` with why that absence is meaningful.
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable.
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`

> This probe report is evidence, not a finished TSBC closeout. Fill the checklist above in the issue or polished report, render the branded PDF artifact, and attach `TSBC-<issue>-report.pdf` before updating catalog rows or adoption recommendations.
