# TSBC-1230 CV Ladder Recovery — Clean Hermes Launch Path for Run 01

Source issue: [TSBC-1230](/TSBC/issues/TSBC-1230)  
Resumed execution issue: [TSBC-1176](/TSBC/issues/TSBC-1176)  
PDF filename: `TSBC-1230-report.pdf`  
Report date: `2026-07-23`  
Brand pack: `stack-lab`  
Hypothesis verdict: `CONFIRMED`  
Dispatched follow-up key: [TSBC-1176](/TSBC/issues/TSBC-1176)

## Hypothesis

The blocked clean-Hermes run can be made actionable again without changing the benchmark inputs by restoring stable served-tree paths for the pinned TSBC-1171 candidate and preregistration, then writing one concrete launch packet that points the next run at the accepted clean-profile contract and the exact 10-case x 3-repetition scope.

## Method

I verified the served workspace and durable company work-products copies of the pinned inputs, then materialized a stable launch directory for run 01:

- Candidate: `work-products/TSBC-1171/candidates/r1-lean-zero-skill.md`
- Preregistration: `work-products/TSBC-1171/prereg-r1-lean-zero-skill.json`
- Suite: `/Users/glad0s/paperclip/benchmark/cv-review/suite.json`

I reused the previously accepted clean-profile evidence from TSBC-1153:

- Clean profile manifest: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1153/hermes-clean-profile-v2/manifest.json`

Then I added the launcher `work-products/TSBC-1230/launch_tsbc_1176_run01.py`, executed it from the served tree, and wrote a stable launch contract plus linked run packet under `work-products/TSBC-1171/runs/r1-lean-zero-skill/run-01-launch/`.

## Data

### Verified pinned hashes

| Artifact | Path | SHA-256 |
|---|---|---|
| Candidate | `work-products/TSBC-1171/candidates/r1-lean-zero-skill.md` | `28da1e97d8a312aca0cd50602d712ffb8a243d0f564213632b72374c7371ab04` |
| Suite | `/Users/glad0s/paperclip/benchmark/cv-review/suite.json` | `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61` |

### Materialized launch packet

| Field | Value |
|---|---|
| Launcher | `work-products/TSBC-1230/launch_tsbc_1176_run01.py` |
| Exact invocation verified from served tree | `python work-products/TSBC-1230/launch_tsbc_1176_run01.py` |
| Launch contract | `work-products/TSBC-1230/TSBC-1230-launch-contract.json` |
| Stable launch directory | `work-products/TSBC-1171/runs/r1-lean-zero-skill/run-01-launch/` |
| Linked candidate | `work-products/TSBC-1171/runs/r1-lean-zero-skill/run-01-launch/candidate.md` |
| Linked preregistration | `work-products/TSBC-1171/runs/r1-lean-zero-skill/run-01-launch/prereg.json` |
| Linked suite | `work-products/TSBC-1171/runs/r1-lean-zero-skill/run-01-launch/suite.json` |
| Clean profile evidence | `TSBC-1153/hermes-clean-profile-v2/manifest.json` |

### Recovered run contract

The generated launch contract fixes the discovery gap that stranded [TSBC-1176](/TSBC/issues/TSBC-1176):

- `desiredSkills` remains `[]` from the preregistration.
- The run shape is pinned to the exact ten development tasks and `3` repetitions per case.
- The clean lane contract reuses `hermes_local`, `persistSession=false`, and the accepted clean-profile manifest from TSBC-1153.
- The required evidence list is copied from the preregistration so the resumed run still has to produce raw outputs, `records.json`, `per_task.json`, `summary.json`, `report.md`, requested/served model evidence, prompt/session evidence, fresh/cache/output tokens, latency, tool calls, and failures/rejection reasons.

## Verdict

`CONFIRMED`. The served workspace now contains a stable, reproducible launch packet for run 01, and the exact invocation has been verified from the served tree. The recovery restored the live execution path without altering the pinned candidate or suite hashes.

## Next action

Move [TSBC-1176](/TSBC/issues/TSBC-1176) out of `blocked`, point it at the recovered launcher and contract, and let the assigned clean Hermes lane generate the actual benchmark evidence.

## Evidence

- Launcher: `work-products/TSBC-1230/launch_tsbc_1176_run01.py`
- Launch contract: `work-products/TSBC-1230/TSBC-1230-launch-contract.json`
- Stable launch directory: `work-products/TSBC-1171/runs/r1-lean-zero-skill/run-01-launch/`

## TSKB

Canonical TSKB delta: none. This heartbeat recovered a stranded launch contract but did not create reusable new process knowledge that belongs in `~/TSKB/KB/`.

## Render command

```sh
brandsuite pdf --brand stack-lab -- --input work-products/TSBC-1230/TSBC-1230-report.md --out work-products/TSBC-1230/TSBC-1230-report.pdf --title "TSBC-1230 CV ladder Hermes launch recovery"
```
