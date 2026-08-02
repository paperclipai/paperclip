# TSBC-1266 child report — R1 bare grok-4.5 (hermes/xai-oauth)

- Parent: TSBC-1248
- Run ID: `run-20260725-214841`
- Model: grok-4.5 via hermes + xAI OAuth
- Judge: claude-opus
- Rung: 1 bare (`agent_file_sha256=none`, `skills_bundle_sha256=none`)
- Isolation home: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1248/hermes-r1-1266-current-clean/.hermes`
- Finished: 2026-07-25T21:01:39+00:00
- Auth/quota failures: 0

## Per-role results

| Role | n | ok | mean q | min q | q/1k-out | suite_sha256 |
|---|---:|---:|---:|---:|---:|---|
| cto | 12 | 12 | 0.9748 | 0.9187 | 14.3881 | `9178417ea741…` |
| cv-review | 10 | 10 | 0.8637 | 0.5375 | 3.6476 | `4a12f7840060…` |
| ledger | 12 | 12 | 0.9921 | 0.925 | 24.0992 | `22a4d94c7840…` |

## Ledger
- `cto` n=12 q=0.9748 adapter=hermes af=none sk=none judge=claude-opus
- `cv-review` n=10 q=0.8638 adapter=hermes af=none sk=none judge=claude-opus
- `ledger` n=12 q=0.9921 adapter=hermes af=none sk=none judge=claude-opus

## Evidence paths
- `/Users/glad0s/paperclip/work-products/TSBC-1248/evidence/TSBC-1266`
- `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1248/TSBC-1266`
- `/Users/glad0s/paperclip/benchmark/results/run-20260725-214841`

## Controls verification
- Full immutable suites (no max-tasks subset)
- n_tasks >=10 per cell: cto=12, ledger=12, cv-review=10
- Stop-on-403: no auth/quota failures observed
- No paperclip suite; no rung 2-5
- KB checked: TSKB0003; clean profile TSBC-1153 manifest
