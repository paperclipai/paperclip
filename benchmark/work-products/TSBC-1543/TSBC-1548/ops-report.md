# TSBC Task Probe — `probe-20260730-154720`

- Role: `ops`
- Cell: `current + none`
- Tasks: `ops-diagnose-recovery-loop, ops-escalation-decision, ops-diagnose-restart-race, ops-failover-routing, ops-pseudo-stop-classify, ops-incident-triage, ops-cascade-rootcause, ops-alert-actionable, ops-rollback-decision, ops-runbook-ordering`
- Models: `grok-4.5-hermes-current`
- Reps: `3`
- Judge: `claude-opus`
- Effort override: `cli_default`
- Probe frame policy: `auto_agentic_antigravity_non_bare_for_book-content-cv`
- Planned generation methods: `grok-4.5-hermes-current=single_shot_concat`
- Agent-file source: `/Users/glad0s/.paperclip/instances/default/companies/baba1235-7f5b-4555-aed8-c06efa095125/agents/4984170a-f593-404d-bd46-6c1fc48b20ab/instructions/AGENTS.md` (variants_json)
- Skills source: `/Users/glad0s/.paperclip/instances/default/skills/baba1235-7f5b-4555-aed8-c06efa095125/__runtime__` (variants_json)
- Suite source: `/Users/glad0s/paperclip/benchmark/ops/suite.json`
- Agent-file sha256: `3dfefe166a71880be1c4c885e3d7b9fd0bb35f4ac4fd13f1980000152958527f`
- Skills bundle sha256: `none`
- Suite sha256: `af81fcc8c8acf9b45aac20aa118d2e0116e4e875fd9b8b4e4f07df614a7bef25`
- Probe context sha256: `e17359767a14f7aed0803fd16fdde1da62bcd87f17365b75dfdd72f63719461d`
- Prompt packet sha256: `ea2c6fd52ffa81e2a57d31131ceff1a8c010ef92bacdaad3e47ec4ce76099855`

## Overall

| model | frame | effort | tasks | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-current | single_shot_concat | cli_default | 10 | 30 | 30 | 0.964 | 0.714 | 117.5 | 2208.0 | 22.821 |

## Per Task

| model | frame | effort | task | samples | ok | meanQ | minQ | meanOut | meanIn | q/1k-out |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-alert-actionable | 3 | 3 | 0.983 | 0.980 | 86.7 | 2263.0 | 11.429 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-cascade-rootcause | 3 | 3 | 0.981 | 0.979 | 208.0 | 2330.0 | 4.767 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-diagnose-recovery-loop | 3 | 3 | 0.828 | 0.748 | 241.0 | 2166.0 | 3.495 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-diagnose-restart-race | 3 | 3 | 0.990 | 0.990 | 327.0 | 2210.0 | 3.038 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-escalation-decision | 3 | 3 | 1.000 | 1.000 | 42.7 | 2097.0 | 23.594 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-failover-routing | 3 | 3 | 1.000 | 1.000 | 28.7 | 2127.0 | 35.926 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-incident-triage | 3 | 3 | 1.000 | 1.000 | 13.0 | 2132.0 | 76.923 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-pseudo-stop-classify | 3 | 3 | 1.000 | 1.000 | 106.0 | 2150.0 | 9.556 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-rollback-decision | 3 | 3 | 0.954 | 0.941 | 103.7 | 2261.0 | 9.223 |
| grok-4.5-hermes-current | single_shot_concat | cli_default | ops-runbook-ordering | 3 | 3 | 0.905 | 0.714 | 18.0 | 2344.0 | 50.265 |

## TSBC Fairness Closeout (required before recommendation)

- Run IDs: `probe-20260730-154720`
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
- Environment: `TSBC task-probe harness; role=ops; cell=current+none; finished=2026-07-30T15:03:36+00:00`
- Records path: `/Users/glad0s/paperclip/benchmark/results/probe-20260730-154720/report.md`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-154720/records.json`, `/Users/glad0s/paperclip/benchmark/results/probe-20260730-154720/summary.json`
- Suite hash: `af81fcc8c8acf9b45aac20aa118d2e0116e4e875fd9b8b4e4f07df614a7bef25` (`/Users/glad0s/paperclip/benchmark/ops/suite.json`)
- Prompt/system hash: `ea2c6fd52ffa81e2a57d31131ceff1a8c010ef92bacdaad3e47ec4ce76099855` (agent `3dfefe166a71880be1c4c885e3d7b9fd0bb35f4ac4fd13f1980000152958527f`, skills `none`)
- Failure-library IDs: list created/referenced IDs, or `none` with why that absence is meaningful.
- Any `not_preserved:*` field must explain why the artifact is missing; blank fields are not acceptable.
- Next gate: `catalog_only` / `create_candidate_pack` / `run_opco_live_proof` / `adopt` / `reject` / `rerun` / `supersede`

> This probe report is evidence, not a finished TSBC closeout. Fill the checklist above in the issue or polished report, render the branded PDF artifact, and attach `TSBC-<issue>-report.pdf` before updating catalog rows or adoption recommendations.
