# TSBC Task Probe — `probe-20260730-040556`

- Role: `cv-review`
- Cell: `bare + none`
- Tasks: `cv-title-inflation-gap, cv-unsubstantiated-metrics, cv-role-mismatch, cv-clean-calibration, cv-date-inconsistency, cv-pii-overshare, cv-benign-contract-overlap, cv-explained-career-break, cv-keyword-stuffed-role-mismatch, cv-team-metric-attribution`
- Models: `grok-4.5-hermes-clean`
- Reps: `3`
- Judge: `claude-opus`
- Effort override: `cli_default`
- Probe frame policy: `auto_agentic_antigravity_non_bare_for_book-content-cv`
- Planned generation methods: `grok-4.5-hermes-clean=single_shot_concat`
- Agent-file source: `/Users/glad0s/paperclip/benchmark/variants/agentfiles/cv-review.md` (variants_json)
- Skills source: `/Users/glad0s/paperclip/benchmark/variants/skills/cv-review` (variants_json)
- Suite source: `/Users/glad0s/paperclip/benchmark/cv-review/suite.json`
- Agent-file sha256: `none`
- Skills bundle sha256: `none`
- Suite sha256: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`
- Probe context sha256: `55302cafd6158dc086dbe70f70b68e1d79352ce3d756e7f30a29074d732d2445`
- Prompt packet sha256: `6b35df56f07dd0b847d3da27a5699cf01ae1803fe55201f84d13f2f3681a5039`

## Overall

| model | frame | effort | tasks | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-clean | single_shot_concat | cli_default | 10 | 30 | 30 | 0.897 | 0.333 | 244.9 | 147.9 | 4.600 |

## Per Task

| model | frame | effort | task | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-benign-contract-overlap | 3 | 3 | 1.000 | 1.000 | 146.7 | 168.0 | 6.843 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-clean-calibration | 3 | 3 | 0.778 | 0.333 | 198.3 | 146.0 | 3.974 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-date-inconsistency | 3 | 3 | 1.000 | 1.000 | 138.7 | 112.0 | 7.217 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-explained-career-break | 3 | 3 | 0.667 | 0.500 | 373.7 | 197.0 | 1.800 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-keyword-stuffed-role-mismatch | 3 | 3 | 1.000 | 1.000 | 247.7 | 177.0 | 4.203 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-pii-overshare | 3 | 3 | 0.905 | 0.714 | 220.3 | 129.0 | 4.299 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-role-mismatch | 3 | 3 | 1.000 | 1.000 | 150.7 | 115.0 | 6.668 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-team-metric-attribution | 3 | 3 | 0.625 | 0.625 | 394.3 | 167.0 | 1.604 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-title-inflation-gap | 3 | 3 | 1.000 | 1.000 | 143.7 | 141.0 | 7.018 |
| grok-4.5-hermes-clean | single_shot_concat | cli_default | cv-unsubstantiated-metrics | 3 | 3 | 1.000 | 1.000 | 434.7 | 127.0 | 2.369 |

## TSBC Fairness Closeout (required before recommendation)

- Run IDs: `probe-20260730-040556`
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
- Environment: `TSBC task-probe harness; role=cv-review; cell=bare+none; finished=2026-07-30T03:20:04+00:00`
- Records path: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-040556/report.md`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-040556/records.json`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-040556/summary.json`
- Suite hash: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61` (`/Users/glad0s/paperclip/benchmark/cv-review/suite.json`)
- Prompt/system hash: `6b35df56f07dd0b847d3da27a5699cf01ae1803fe55201f84d13f2f3681a5039` (agent `none`, skills `none`)
- Failure-library IDs: list created/referenced IDs, or `none` with why that absence is meaningful.
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable.
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`

> This probe report is evidence, not a finished TSBC closeout. Fill the checklist above in the issue or polished report, render the branded PDF artifact, and attach `TSBC-<issue>-report.pdf` before updating catalog rows or adoption recommendations.
