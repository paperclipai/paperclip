# TSBC Task Probe — `probe-20260730-162918`

- Role: `cto`
- Cell: `current + none`
- Tasks: `cto-reject-restart-race-default, cto-fallback-monitor-option, cto-local-only-relay-mismatch, cto-gate-keeper-capability-design, cto-code-review-security-bug, cto-build-vs-buy-judge, cto-plan-approval-gate, cto-escalate-to-mc, cto-eng-load-balance, cto-fallback-monitor-adapter-trap, cto-reversibility-rollout, cto-reject-overengineering`
- Models: `grok-4.5-hermes-lean`
- Reps: `3`
- Judge: `claude-opus`
- Effort override: `cli_default`
- Probe frame policy: `auto_agentic_antigravity_non_bare_for_book-content-cv`
- Planned generation methods: `grok-4.5-hermes-lean=single_shot_concat`
- Agent-file source: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1543/TSBC-1549/agent-files/TSBC-1549-lean-cell.md` (override)
- Skills source: `/Users/glad0s/.paperclip/instances/default/skills/e6361895-a6a4-438d-bb76-b17a0ad026cb/__runtime__` (variants_json)
- Suite source: `/Users/glad0s/paperclip/benchmark/cto/suite.json`
- Agent-file sha256: `a3fe5d96277ee604cb0acd75532bcf2f403afa514220ea1430ca68c218546715`
- Skills bundle sha256: `none`
- Suite sha256: `9178417ea7411729ec604cd6f0f72637a785d4d0f99ddd564fdfd0d4d603c31d`
- Probe context sha256: `c5d1c04a58aa09412af53e30d54d576c59b5e2b925bcd51c9982ec48e1f9b764`
- Prompt packet sha256: `f6db83e6192b3aeff74fc255e4ebbcaff47c0b3df38b77cc86952e360fb7ed0c`

## Overall

| model | frame | effort | tasks | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-lean | single_shot_concat | cli_default | 12 | 36 | 34 | 0.962 | 0.729 | 69.4 | 452.8 | 21.513 |

## Per Task

| model | frame | effort | task | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-build-vs-buy-judge | 3 | 3 | 0.965 | 0.950 | 87.7 | 469.0 | 11.037 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-code-review-security-bug | 3 | 3 | 0.977 | 0.969 | 168.0 | 432.0 | 5.817 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-eng-load-balance | 3 | 2 | 0.988 | 0.988 | 14.0 | 468.0 | 47.024 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-escalate-to-mc | 3 | 2 | 1.000 | 1.000 | 14.0 | 544.0 | 47.619 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-fallback-monitor-adapter-trap | 3 | 3 | 0.913 | 0.839 | 51.7 | 383.0 | 17.674 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-fallback-monitor-option | 3 | 3 | 0.983 | 0.979 | 78.7 | 511.0 | 12.639 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-gate-keeper-capability-design | 3 | 3 | 0.839 | 0.729 | 16.0 | 502.0 | 52.440 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-local-only-relay-mismatch | 3 | 3 | 0.952 | 0.944 | 67.0 | 418.0 | 14.292 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-plan-approval-gate | 3 | 3 | 0.977 | 0.975 | 123.3 | 387.0 | 7.954 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-reject-overengineering | 3 | 3 | 0.991 | 0.986 | 73.7 | 445.0 | 13.478 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-reject-restart-race-default | 3 | 3 | 0.972 | 0.969 | 69.7 | 476.0 | 13.958 |
| grok-4.5-hermes-lean | single_shot_concat | cli_default | cto-reversibility-rollout | 3 | 3 | 0.984 | 0.983 | 69.3 | 399.0 | 14.226 |

## TSBC Fairness Closeout (required before recommendation)

- Run IDs: `probe-20260730-162918`
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
- Environment: `TSBC task-probe harness; role=cto; cell=current+none; finished=2026-07-30T15:40:25+00:00`
- Records path: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-162918/report.md`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-162918/records.json`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-162918/summary.json`
- Suite hash: `9178417ea7411729ec604cd6f0f72637a785d4d0f99ddd564fdfd0d4d603c31d` (`/Users/glad0s/paperclip/benchmark/cto/suite.json`)
- Prompt/system hash: `f6db83e6192b3aeff74fc255e4ebbcaff47c0b3df38b77cc86952e360fb7ed0c` (agent `a3fe5d96277ee604cb0acd75532bcf2f403afa514220ea1430ca68c218546715`, skills `none`)
- Failure-library IDs: list created/referenced IDs, or `none` with why that absence is meaningful.
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable.
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`

> This probe report is evidence, not a finished TSBC closeout. Fill the checklist above in the issue or polished report, render the branded PDF artifact, and attach `TSBC-<issue>-report.pdf` before updating catalog rows or adoption recommendations.
