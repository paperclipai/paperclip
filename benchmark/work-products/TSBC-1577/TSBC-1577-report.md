# TSBC-1577 Report - VA1 compliance live matrix preflight

Source issue: [TSBC-1577](/TSBC/issues/TSBC-1577)  
Parent issue: [TSBC-1573](/TSBC/issues/TSBC-1573)  
PDF filename: `TSBC-1577-report.pdf`  
Report generated: `2026-07-30T19:45:00Z`  
Brand pack: `stack-lab`  
Hypothesis verdict: `INCONCLUSIVE`  
Dispatched follow-up key: `TSBC-1573-VA1-LIVE-RUN`

## Hypothesis

The pre-registered Gate VA1 behavioral probe matrix can run live only after both prerequisites are clear:

1. TSBC power mode reports `heavyTasksAllowed=true`.
2. The `claude-sonnet-5` row has an operator-approved, unpaused Claude bench agent.

The intended live matrix remains: 4 probe cells x 3 model rows x 3 reps, with no approved deviation or narrowing.

## Method

1. Used the scoped wake payload for [TSBC-1577](/TSBC/issues/TSBC-1577): `reason=issue_assigned`, `fallbackFetchNeeded=false`, and harness-held checkout.
2. Ran the exact registered command from the issue:

```sh
cd /Users/glad0s/paperclip/benchmark
python3 run_va1_compliance.py --models grok-4.3,codex-gpt-5.4,claude-sonnet-5 --reps 3
```

3. Allowed the VA1 harness preflight to fail closed before creating fixture issues or invoking bench lanes.
4. Preserved the generated preflight run outputs under `work-products/TSBC-1577/` and prepared this PDF closeout artifact for the blocked heartbeat.

## Data

| Check | Observed value | Result |
| --- | --- | --- |
| TSBC power mode | `mode=low`, `heavyTasksAllowed=false`, reason `ThinkStack Capital sprint 13-23; ThinkStack Media sprint 09-03` | blocker |
| Claude bench agent | `Bench-claude-sonnet-5`, id `53a4e9d3-81b1-4d86-8f87-e19447412f0e`, status `paused`, pause reason `manual` | blocker |
| Grok bench row | `Bench-grok-4.3`, id `7fffa42f-467a-4f76-b802-4dc8bd552bd9`, status `idle` | admissible after power clears |
| Codex bench row | `Bench-codex-gpt-5.4`, id `5bcc7a94-6715-43eb-ad53-da7bd300ef79`, status `idle` | admissible after power clears |
| Live fixture cells created | `0/36` | not run because preflight blocked |
| VA1 ledger rows appended | `0` for run `va1-20260730-203722` | expected for blocked preflight |

Generated preflight run root:

`/Users/glad0s/paperclip/benchmark/results/va1-20260730-203722`

Suite source:

`/Users/glad0s/paperclip/benchmark/va1_compliance/suite.json`

Suite SHA-256:

`83a4dba5e21fe520a46be96a12aab68029dc7f5abd62140ebfb94c9ff5ddc01b`

## Acceptance Status

| Acceptance criterion | Status |
| --- | --- |
| Live run creates 4 probe cells x 3 model rows x 3 reps, unless approved deviation recorded | blocked; no approved deviation recorded |
| `ledger/results.jsonl` receives `va1_compliance` pass and aggregate rows | blocked; no live rows appended |
| Report adherence percent per P1/P2/P3/P4 and model family | blocked; sample count is `0`, adherence is not computed |
| Flag any lane/model below 75% | blocked; no lane/model samples exist |
| Attach run report/PDF/evidence back to parent [TSBC-1573](/TSBC/issues/TSBC-1573) | this preflight evidence packet is prepared for attachment |

## Verdict

`INCONCLUSIVE`.

The live VA1 compliance matrix did not run because both pre-registered blockers are still active. This is not a narrowed benchmark and not a substitute for the required 36-cell live run. The correct disposition is blocked until TSBC power mode reports `heavyTasksAllowed=true` and the Claude row has an operator-approved unpaused bench agent.

## Unblock Actions

1. TSBC power controller/operator: clear the sprint power gate so `/Users/glad0s/paperclip/benchmark/.tsbc-power.json` reports `heavyTasksAllowed=true`.
2. Operator/bench owner: unpause `Bench-claude-sonnet-5` or provide another approved unpaused Claude bench agent id for the `claude-sonnet-5` row.
3. Bench-Manager: rerun the exact registered command after both gates are clear.

## TSKB Delta

None. This heartbeat produced issue-specific benchmark preflight evidence only.

## Render Command

```sh
brandsuite pdf --brand stack-lab -- \
  --input work-products/TSBC-1577/TSBC-1577-report.md \
  --out work-products/TSBC-1577/TSBC-1577-report.pdf \
  --title "TSBC-1577 Report - VA1 compliance live matrix preflight"
```
