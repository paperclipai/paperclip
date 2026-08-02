# TSBC-1527 cell closeout — r2 ambiguous ownership clarify

## Cell
- Candidate: `work-products/TSBC-1171/candidates/r2-ambiguous-ownership-clarify.md`
- Candidate sha256: `fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf`
- Suite sha256: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`
- Adapter: hermes_local / recorded adapterType=hermes
- desiredSkills: [] (skills=none, stagedSkills=0)
- Probe: `probe-20260730-094016`
- Durable evidence: `work-products/TSBC-1171/runs/r2-ambiguous-ownership-clarify/probe-20260730-094016/`

## Results (10 tasks × 3 reps = 30)
| cell | meanQ | minQ | meanOut | ok |
|---|---:|---:|---:|---:|
| bare baseline (TSBC-1170 / probe-20260730-040556) | 0.8974 | 0.3333 | 244.9 | 30/30 |
| r1 lean zero-skill (TSBC-1176 / probe-20260730-090121) | 0.9625 | 0.6250 | 160.1 | 30/30 |
| **r2 ambiguous-ownership-clarify (this cell)** | **1.0000** | **1.0000** | **155.0** | **30/30** |

## Deltas
- r2 − bare: meanQ +0.1026, minQ +0.6667, meanOut -89.9
- r2 − r1: meanQ +0.0375, minQ +0.3750, meanOut -5.1

## Lane controls
- allPinned: True
- agentFileSha256 unique: ['fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf']
- suiteSha256 unique: ['4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61']
- skills unique: ['none']
- stagedSkills unique: [0]
- adapterType unique: ['hermes']
- model_reported unique: ['grok-4.5']

## Verdict
**CONFIRMED** — R2 agent-file revision reaches perfect development-suite quality under frozen zero-skill hermes_local controls, improving low-tail vs bare and r1 without token inflation.

## Artifacts
- summary/records/per_task/report + raw×30 under durable probe path above
- comparison: `work-products/TSBC-1171/scores/r2-vs-baseline-r1-comparison.json`
- outcome: `work-products/TSBC-1171/runs/r2-ambiguous-ownership-clarify/outcome.json`
- prereg: `work-products/TSBC-1171/prereg-r2-ambiguous-ownership-clarify.json`

## Notes
- Generation completed via clean hermes_local lane (partial stop at 25/30; resume via TSBC-1536 finished remaining 5 rep03 samples).
- No holdout access. No skill bundle. No reusable TSKB process delta beyond cell evidence.
