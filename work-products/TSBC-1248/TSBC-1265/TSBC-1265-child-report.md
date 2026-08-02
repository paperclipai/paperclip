# TSBC-1265 child report — R1 bare ceo/ops/content (grok-4.5)

- Parent: TSBC-1248
- Run: `run-20260725-215009`
- Status: complete — 0/32 failed
- Model: grok-4.5 via hermes_local / xAI OAuth
- Judge: claude-opus
- Bare: agent_file_sha256=none, skills_bundle_sha256=none
- HERMES_HOME: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1265/hermes-clean-profile/.hermes`
- Flags: HERMES_IGNORE_RULES=1, --ignore-user-config --ignore-rules

## Role summary

| role | n_tasks | mean_quality | min | max | mean_wall_ms | suite_sha256 |
|------|---------|--------------|-----|-----|--------------|--------------|
| ceo | 11 | 0.9888 | 0.975 | 1.0 | 9437.1818 | `7b79fdf5d2ce8057…` |
| content | 11 | 0.9268 | 0.8675 | 0.97 | 13085.8182 | `033a0a832aabf012…` |
| ops | 10 | 0.9707 | 0.7758 | 1.0 | 14586.3 | `af81fcc8c8acf9b4…` |

## Comparison vs prior bare grok (judge=claude-opus)

| role | grok-4.5 | grok-4.3 | grok-4.20 | note |
|------|----------|----------|-----------|------|
| ceo | 0.9888 | None | None | grok-4.5 q=0.9888 (n=11) vs 4.3 q=None (n/a), vs 4.20 q=None (n/a) |
| ops | 0.9707 | 0.9936 | 0.9549 | grok-4.5 q=0.9707 (n=10) vs 4.3 q=0.9936 (loses), vs 4.20 q=0.9549 (beats) |
| content | 0.9268 | 0.9219 | 0.8878 | grok-4.5 q=0.9268 (n=11) vs 4.3 q=0.9219 (matches), vs 4.20 q=0.8878 (beats) |

## Ledger rows written
- `ceo` n=11 quality=0.9888 successRate=1.0 run_id=run-20260725-215009
- `content` n=11 quality=0.9268 successRate=1.0 run_id=run-20260725-215009
- `ops` n=10 quality=0.9707 successRate=1.0 run_id=run-20260725-215009

## Evidence
- Machine report: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1265/TSBC-1265-child-report.json`
- Bench report: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1265/evidence/report.md`
- Raw cells: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1265/evidence/raw` (32 files)
- Full run copy: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1265/runs/run-20260725-215009`
- Bench log: `/Users/glad0s/paperclip/work-products/TSBC-1248/TSBC-1265/evidence/bench-ceo-ops-content.log`

## Notes
- Full immutable suites used (ceo=11, ops=10, content=11); meets n>=10 samples/cell.
- No Grok 403/quota/auth failures.
- Clean profile seed required models_dev_cache.json in addition to credential plumbing (credential-only home fails provider init).
- Parent pre-run run-20260725-214141 ops on non-clean proven home is superseded for decision use by this clean-control run.
- No canonical TSKB delta; process note stays in this child report only.

