# TSR-4723 — meanQ comparison (R2 vs incumbent)

- Paperclip run (this closeout packaging): `5b6f9a22-ade2-47fa-b4a2-6b898b81847a`
- Comparison-producing probe run id (R2): `probe-20260730-094016`
- Incumbent (ladder bare) probe run id: `probe-20260730-040556`
- Prior candidate R1 probe run id: `probe-20260730-090121`
- n (samples): **30** (10 tasks × 3 reps)
- Suite sha256: `4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61`
- R2 agent-file sha256: `fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf`
- Skills: **none** (skill pack REFUTED/dropped per TSBC-1174)

## Gate re-cut

| Before | After |
|---|---|
| Adoption blocked on next 3 real `[PHASE-0-WEDGE]` shadow orders (TSR-4709) | Dev-suite / past-case validation: R2 meanQ ≥ incumbent ladder baseline |
| Live shadow was the thing blocking step 2 | Live shadow is a **separate later gate** that arms on first real order |
| Board gate before paid flip | **Unchanged** (operator-owned) |

## Headline meanQ

| Lane | run_id | n | ok | meanQ | minQ | mean out toks |
|---|---|---:|---|---:|---:|---:|
| Incumbent (ladder bare Hermes grok-4.5) | `probe-20260730-040556` | 30 | 30/30 | **0.8974** | 0.3333 | 244.9 |
| Prior candidate R1 lean-zero-skill | `probe-20260730-090121` | 30 | 30/30 | **0.9625** | 0.6250 | 160.1 |
| R2 adoption candidate | `probe-20260730-094016` | 30 | 30/30 | **1.0000** | 1.0000 | 155.0 |

**Gate criterion:** R2 meanQ (1.0000) ≥ incumbent bare meanQ (0.8974) → **PASS** (Δ = +0.1026)
**Also vs R1:** R2 (1.0000) ≥ R1 (0.9625) → **PASS** (Δ = +0.0375)

## Per-case scores

| task_id | incumbent bare meanQ | R1 meanQ | R2 meanQ | Δ R2−incumbent | R2 ok |
|---|---:|---:|---:|---:|---|
| `cv-benign-contract-overlap` | 1.0000 | 1.0000 | 1.0000 | +0.0000 | 3/3 |
| `cv-clean-calibration` | 0.7778 | 1.0000 | 1.0000 | +0.2222 | 3/3 |
| `cv-date-inconsistency` | 1.0000 | 1.0000 | 1.0000 | +0.0000 | 3/3 |
| `cv-explained-career-break` | 0.6667 | 1.0000 | 1.0000 | +0.3333 | 3/3 |
| `cv-keyword-stuffed-role-mismatch` | 1.0000 | 1.0000 | 1.0000 | +0.0000 | 3/3 |
| `cv-pii-overshare` | 0.9048 | 1.0000 | 1.0000 | +0.0952 | 3/3 |
| `cv-role-mismatch` | 1.0000 | 1.0000 | 1.0000 | +0.0000 | 3/3 |
| `cv-team-metric-attribution` | 0.6250 | 0.6250 | 1.0000 | +0.3750 | 3/3 |
| `cv-title-inflation-gap` | 1.0000 | 1.0000 | 1.0000 | +0.0000 | 3/3 |
| `cv-unsubstantiated-metrics` | 1.0000 | 1.0000 | 1.0000 | +0.0000 | 3/3 |

## Provenance

- Durable R2 probe mirror: `work-products/TSBC-1171/runs/r2-ambiguous-ownership-clarify/probe-20260730-094016/`
- Ladder comparison source: `work-products/TSBC-1171/scores/r2-vs-baseline-r1-comparison.json`
- TSKB verdict: `TSKB0047 .../reports/TSBC-1174-cv-ladder-verdict-20260730.md`
- Live hash re-verified 2026-07-31 during TSR-4723 closeout packaging run `5b6f9a22-ade2-47fa-b4a2-6b898b81847a`
- Spot freshness: `probe-20260731-173229` (cv-clean-calibration, R2, grok-4.5) quality 1.0

## Explicit non-changes

- No paid-order routing flip.
- No intake/delivery SOP stage changes.
- Board `request_confirmation` before primary flip remains mandatory on TSR-4704 step 4.
- TSR-4709 remains the live-order shadow card; it is **not** a blocker for dev-suite validation completion.

