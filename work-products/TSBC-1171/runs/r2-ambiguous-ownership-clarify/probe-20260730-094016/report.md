# TSBC Task Probe — `probe-20260730-094016`

- Role: `cv-review`
- Cell: `current + none`
- Tasks: `cv-title-inflation-gap, cv-unsubstantiated-metrics, cv-role-mismatch, cv-clean-calibration, cv-date-inconsistency, cv-pii-overshare, cv-benign-contract-overlap, cv-explained-career-break, cv-keyword-stuffed-role-mismatch, cv-team-metric-attribution`
- Models: `grok-4.5-hermes-clean`
- Reps: `3`
- Judge: `claude-opus`
- Effort override: `cli_default`
- Probe frame policy: `auto_agentic_antigravity_non_bare_for_book-content-cv`
- Planned generation methods: `grok-4.5-hermes-clean=single_shot_concat`
- Agent-file source: `/Users/glad0s/.paperclip/instances/default/projects/e212ce50-b524-408c-b3d4-0c6108d8c2e2/f71e8665-3f38-4920-b777-348ec85b9071/_default/work-products/TSBC-1171/candidates/r2-ambiguous-ownership-clarify.md` (override)
- Skills source: `/Users/glad0s/paperclip/benchmark/variants/skills/cv-review` (variants_json)
- Suite source: `/Users/glad0s/paperclip/benchmark/cv-review/suite.json`
- Agent-file sha256: `fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf`
- Skills bundle sha256: `none`
- Suite sha256: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`
- Probe context sha256: `b24e1f194117c088bc560d31a52722fd67adff2566f29f29954a7927dd61d7f4`
- Prompt packet sha256: `8069ff0722c0da366b96d62c19da8b367ea4503dd8a08b895e7af48039ef9fa4`

## Overall

| model | frame | effort | tasks | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-clean | single_shot_concat | cli_default | 10 | 30 | 30 | 1.000 | 1.000 | 155.0 | 557.9 | 15.620 |

## Per Task

| model | frame | effort | task | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-benign-contract-overlap | 3 | 3 | 1.000 | 1.000 | 87.3 | 578.0 | 11.595 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-clean-calibration | 3 | 3 | 1.000 | 1.000 | 11.0 | 556.0 | 90.909 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-date-inconsistency | 3 | 3 | 1.000 | 1.000 | 132.3 | 522.0 | 7.678 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-explained-career-break | 3 | 3 | 1.000 | 1.000 | 108.3 | 607.0 | 10.300 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-keyword-stuffed-role-mismatch | 3 | 3 | 1.000 | 1.000 | 163.7 | 587.0 | 6.232 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-pii-overshare | 3 | 3 | 1.000 | 1.000 | 134.7 | 539.0 | 7.569 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-role-mismatch | 3 | 3 | 1.000 | 1.000 | 109.0 | 525.0 | 9.362 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-team-metric-attribution | 3 | 3 | 1.000 | 1.000 | 279.7 | 577.0 | 3.599 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-title-inflation-gap | 3 | 3 | 1.000 | 1.000 | 163.7 | 551.0 | 6.136 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-unsubstantiated-metrics | 3 | 3 | 1.000 | 1.000 | 360.0 | 537.0 | 2.819 |

## TSBC Fairness Closeout (required before recommendation)

- Run IDs: `probe-20260730-094016`
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
- Environment: `TSBC task-probe harness; role=cv-review; cell=current+none; finished=2026-07-30T09:55:15+00:00`
- Records path: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-094016/report.md`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-094016/records.json`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-094016/summary.json`
- Suite hash: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61` (`/Users/glad0s/paperclip/benchmark/cv-review/suite.json`)
- Prompt/system hash: `8069ff0722c0da366b96d62c19da8b367ea4503dd8a08b895e7af48039ef9fa4` (agent `fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf`, skills `none`)
- Failure-library IDs: list created/referenced IDs, or `none` with why that absence is meaningful.
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable.
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`

> This probe report is evidence, not a finished TSBC closeout. Fill the checklist above in the issue or polished report, render the branded PDF artifact, and attach `TSBC-<issue>-report.pdf` before updating catalog rows or adoption recommendations.
