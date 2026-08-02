# TSBC Task Probe — `probe-20260730-205955`

- Role: `engineer`
- Cell: `current + none`
- Tasks: `eng-failure-classify, eng-scorecard-sql-bug, eng-prefix-router, eng-concurrency-race, eng-stale-reap-default-bug, eng-token-normalizer, eng-nplus1-fix, eng-sql-injection, eng-flaky-test-diagnose, eng-unsafe-migration, eng-idempotency-bug, eng-timezone-offbyone`
- Models: `grok-4.5-hermes-current`
- Reps: `3`
- Judge: `claude-opus`
- Effort override: `cli_default`
- Probe frame policy: `auto_agentic_antigravity_non_bare_for_book-content-cv`
- Planned generation methods: `grok-4.5-hermes-current=single_shot_concat`
- Agent-file source: `/Users/glad0s/.paperclip/instances/default/companies/e6361895-a6a4-438d-bb76-b17a0ad026cb/agents/7349cc4f-460f-4f39-9eed-ab9a0c188cfa/instructions/AGENTS.md` (variants_json)
- Skills source: `/Users/glad0s/.paperclip/instances/default/skills/e6361895-a6a4-438d-bb76-b17a0ad026cb/__runtime__` (variants_json)
- Suite source: `/Users/glad0s/paperclip/benchmark/engineer/suite.json`
- Agent-file sha256: `034125e8b1a32beb43ab724ebd0caea09da96ea2abb08cd6f2ead03816cbc4db`
- Skills bundle sha256: `none`
- Suite sha256: `b7373c2152d432ffadaa313c61133d110457a1e56402bf122dab21c5460d183f`
- Probe context sha256: `0660b43cc066edb895e3ffd5afbee5a80ba0d15cb3ba96aeede1a931c8b0d6f8`
- Prompt packet sha256: `6bf8d455daa9eea3e5cad388d49dd6659ba53e506269ae6e0c1014ebd5237eea`

## Overall

| model | frame | effort | tasks | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-current | single_shot_concat | cli_default | 12 | 36 | 36 | 0.973 | 0.572 | 1969.9 | 34200.4 | 1.748 |

## Per Task

| model | frame | effort | task | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-concurrency-race | 3 | 3 | 0.967 | 0.958 | 1484.7 | 32705.7 | 0.930 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-failure-classify | 3 | 3 | 1.000 | 1.000 | 296.0 | 26488.0 | 3.379 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-flaky-test-diagnose | 3 | 3 | 0.983 | 0.983 | 5155.3 | 46463.0 | 0.195 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-idempotency-bug | 3 | 3 | 0.982 | 0.975 | 2514.7 | 40084.0 | 0.821 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-nplus1-fix | 3 | 3 | 0.983 | 0.977 | 2006.0 | 31189.3 | 1.318 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-prefix-router | 3 | 3 | 0.997 | 0.990 | 182.0 | 26386.3 | 5.476 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-scorecard-sql-bug | 3 | 3 | 0.980 | 0.964 | 812.0 | 29430.3 | 1.258 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-sql-injection | 3 | 3 | 0.984 | 0.981 | 371.0 | 27358.7 | 2.763 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-stale-reap-default-bug | 3 | 3 | 0.851 | 0.572 | 3171.7 | 49217.3 | 0.299 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-timezone-offbyone | 3 | 3 | 0.989 | 0.989 | 3029.3 | 37327.0 | 0.328 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-token-normalizer | 3 | 3 | 0.997 | 0.990 | 250.7 | 25440.0 | 3.981 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | eng-unsafe-migration | 3 | 3 | 0.965 | 0.964 | 4366.0 | 38315.3 | 0.223 |

## TSBC Fairness Closeout (required before recommendation)

- Run IDs: `probe-20260730-205955`
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
- Model version(s): `grok-4.5-hermes-current`
- Scorer/rubric version: record the exact rubric + judge version, or `not_preserved:<why missing>`.
- Environment: `TSBC task-probe harness; role=engineer; cell=current+none; finished=2026-07-30T20:29:09+00:00`
- Records path: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-205955/report.md`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-205955/records.json`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-205955/summary.json`
- Suite hash: `b7373c2152d432ffadaa313c61133d110457a1e56402bf122dab21c5460d183f` (`/Users/glad0s/paperclip/benchmark/engineer/suite.json`)
- Prompt/system hash: `6bf8d455daa9eea3e5cad388d49dd6659ba53e506269ae6e0c1014ebd5237eea` (agent `034125e8b1a32beb43ab724ebd0caea09da96ea2abb08cd6f2ead03816cbc4db`, skills `none`)
- Failure-library IDs: list created/referenced IDs, or `none` with why that absence is meaningful.
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable.
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`

> This probe report is evidence, not a finished TSBC closeout. Fill the checklist above in the issue or polished report, render the branded PDF artifact, and attach `TSBC-<issue>-report.pdf` before updating catalog rows or adoption recommendations.
