# TSBC-1267 child report — R1 bare engineer/auditor/quant (grok-4.5)

- Parent: TSBC-1248
- Run: `run-20260725-220747`
- Status: complete — 0/36 failed
- Model: grok-4.5 via hermes_local / xAI OAuth
- Judge: claude-opus
- Bare: agent_file_sha256=none, skills_bundle_sha256=none
- HERMES_HOME: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1267/hermes-clean-profile/.hermes`
- Flags: HERMES_IGNORE_RULES=1, --ignore-user-config --ignore-rules

## Role summary

| role | n_tasks | mean_quality | min | max | mean_wall_ms | suite_sha256 |
|------|---------|--------------|-----|-----|--------------|--------------|
| auditor | 12 | 0.9821 | 0.95 | 1.0 | 11319.0833 | `2a04b6f827eda607…` |
| engineer | 12 | 0.9584 | 0.7971 | 1.0 | 16290.5833 | `b7373c2152d432ff…` |
| quant | 12 | 0.9904 | 0.975 | 1.0 | 9570.5 | `32b3563885d9e206…` |

## Comparison vs prior bare grok (judge=claude-opus)

| role | grok-4.5 | grok-4.3 | grok-4.20 | note |
|------|----------|----------|-----------|------|
| auditor | 0.9821 | 0.9783 | 0.9533 | grok-4.5 q=0.9821 (n=12); vs 4.3 q=0.9783 (matches; prior n=3); vs 4.20 q=0.9533 (beats; prior n=3) |
| engineer | 0.9584 | 0.9839 | 0.9793 | grok-4.5 q=0.9584 (n=12); vs 4.3 q=0.9839 (loses; prior n=7); vs 4.20 q=0.9793 (loses; prior n=7) |
| quant | 0.9904 | 0.9817 | 0.9817 | grok-4.5 q=0.9904 (n=12); vs 4.3 q=0.9817 (matches; prior n=3); vs 4.20 q=0.9817 (matches; prior n=3) |

Prior 4.3/4.20 n on these roles is smaller than full suite (directional only).

## Ledger rows written
- `auditor` n=12 quality=0.9821 successRate=1.0 run_id=run-20260725-220747
- `engineer` n=12 quality=0.9584 successRate=1.0 run_id=run-20260725-220747
- `quant` n=12 quality=0.9904 successRate=1.0 run_id=run-20260725-220747

## Evidence
- Machine report: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1267/TSBC-1267-child-report.json`
- Bench report: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1267/evidence/report.md`
- Raw cells: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1267/evidence/raw` (36 files)
- Full run copy: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1267/runs/run-20260725-220747`
- Ledger record log: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1267/evidence/ledger-record.txt`

## Notes
- Full immutable suites used (engineer=12, auditor=12, quant=12); meets n>=10 samples/cell.
- No Grok 403/quota/auth failures.
- Token counts flagged tokensEstimated=true on cells (session export fallback); quality/success unaffected.
- Bench auto-appended 3 bare model_eval ledger rows; manual re-record duplicate removed (backup .bak-tsbc-1267-dedupe).
- No paperclip suite; no rung 2-5.
- No canonical TSKB delta; process note stays in this child report only.
