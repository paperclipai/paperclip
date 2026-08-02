# TSR-4704 — post-hire verification (after CV-Review-Grok-R2 created)

Verified 2026-07-31 after Athena-Codex hire comment on agent `e73544da-2ff4-4370-8510-79bcefc24ffd`.

## Config (DB source of truth)

| Field | Expected | Observed |
|---|---|---|
| name | CV-Review-Grok-R2 | CV-Review-Grok-R2 |
| adapter_type | hermes_local | hermes_local |
| model | grok-4.5 | grok-4.5 |
| desiredSkills | [] | [] |
| maxConcurrentRuns | 1 | 1 (`runtime_config.heartbeat`) |
| wakeOnDemand | true | true |
| heartbeat.enabled | false | false |
| reports_to | RecruitmentManager `8ea6b227-…` | match |
| trustPreset | low_trust_review | match |
| canCreateAgents/Skills | false | false |
| customerFacing / paidPrimary | false | false (metadata) |
| instructions AGENTS.md sha256 | `fd189e4b…c7bf` | **match** (byte-identical to work-products R2 file) |

Snapshot: `work-products/TSR-4704/post-hire-agent-config.json`

## Dev-suite validation (unchanged; gate already PASS)

| Lane | run_id | n | meanQ |
|---|---|---:|---:|
| Incumbent bare | `probe-20260730-040556` | 30 | 0.8974 |
| R2 + grok-4.5 hermes-clean | `probe-20260730-094016` | 30 | **1.0000** |

Suite sha256 `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`. See `validation-evidence.md` + TSR-4723.

## Post-hire smoke (instruction file + model path)

- Dir: `work-products/TSR-4704/post-hire-smoke-20260731T165000Z/`
- Task: `cv-clean-calibration` (suite task)
- Agent file sha: `fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf`
- Model request: `grok-4.5` via hermes CLI (`xai-oauth`), skills none
- Result: **PASS** — JSON parsed, `recommendation=advance`, concerns=[], rc=0, wall≈24.7s
- Artifact: `result.json`

Note: smoke proves the **hired instruction bytes + grok-4.5 path**. Full n=30 meanQ remains the ladder probe above (not re-run this heartbeat).

## Non-changes

- No paid CV-polish routing flip
- No intake/delivery SOP stage edits
- Skill packs remain DROP
