# TSR-4704 — validation evidence (step 2)

## Gate
Challenger meanQ ≥ same-frame incumbent baseline (dev-suite / past-case). Live-order shadow is a later gate (TSR-4709).

## Measurement (frozen CV-review suite)

| Lane | run_id | n | meanQ | agent_file_sha256 | skills |
|---|---|---:|---:|---|---|
| Incumbent bare Hermes grok-4.5 | `probe-20260730-040556` | 30 (10×3) | **0.8974** | none | none |
| R2 agent file + grok-4.5-hermes-clean | `probe-20260730-094016` | 30 (10×3) | **1.0000** | `fd189e4b…c7bf` | none |

- Δ R2 − bare = **+0.1026** → gate **PASS**
- Suite sha256: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`
- Ledger: `/Users/glad0s/paperclip/benchmark/ledger/results.jsonl`
- Packaging / re-cut closeout: TSR-4723; TSKB report `TSKB0047/…/TSR-4723-r2-validation-gate-recut-20260731.md`
- Ladder verdict: TSBC-1174

## Post-hire live path (2026-07-31)

- Agent: CV-Review-Grok-R2 `e73544da-2ff4-4370-8510-79bcefc24ffd`
- Config + instruction SHA verified (see `post-hire-verification.md`)
- Smoke `cv-clean-calibration` with hired AGENTS.md + grok-4.5: **PASS** (`recommendation=advance`)
  - `post-hire-smoke-20260731T165000Z/result.json`

## Context vs production primary
TSBC-1639 (2026-07-31) holds **Gemini** as CV-review production primary (`primary_stands`, meanQ 0.980 n=5 current:all). R2 meanQ 1.0000 still ≥ that spot check, but paid flip remains board-gated and deferred until TSR-4709 shadows complete. This adoption card does **not** flip paid routing.

## Non-changes
- No SOP stage edits
- No customer-facing routing change
- Skill packs remain DROP
