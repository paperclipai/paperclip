# TSBC-1546 Report - Grok 4.3 runnable-cell sweep excluding TSBC-1484

Source issue: [TSBC-1546](/TSBC/issues/TSBC-1546)  
Parent issue: [TSBC-1543](/TSBC/issues/TSBC-1543)  
PDF filename: `TSBC-1546-report.pdf`  
Report generated: `2026-07-30T16:50:31Z`  
Brand pack: `stack-lab`  
Hypothesis verdict: `CONFIRMED`  
Dispatched follow-up key: `locked_except_TSBC-1484`

## Hypothesis

The non-[TSBC-1484](/TSBC/issues/TSBC-1484) Grok 4.3 text-benchmark cells can be reconciled to decision grade from existing artifacts without rerunning, using console/API keys, duplicating [TSBC-1542](/TSBC/issues/TSBC-1542), publishing, or changing live routing. If every runnable non-[TSBC-1484](/TSBC/issues/TSBC-1484) gap is already covered, close this issue with `locked_except_TSBC-1484`.

## Method

1. Used the scoped wake payload for [TSBC-1546](/TSBC/issues/TSBC-1546): `reason=issue_status_changed`, `fallbackFetchNeeded=false`, `0` new comments, and harness-held checkout.
2. Did not start a Grok CLI run. No console/API key was used or requested, and no live routing or publishing change was made.
3. Checked the active power file `/Users/glad0s/paperclip/benchmark/.tsbc-power.json`; because this was reconciliation-only, the lane ran at `0` new concurrent runs.
4. Reconciled [TSBC-1269](/TSBC/issues/TSBC-1269), [TSBC-1270](/TSBC/issues/TSBC-1270), and local [TSBC-1394](/TSBC/issues/TSBC-1394) evidence through issue comments, work products, downloaded attachments, PDF text, and raw JSON rows.
5. Preserved this issue's source plus render under `work-products/TSBC-1543/TSBC-1546/`.

## Data

| Source | Cell | Records | Served model evidence | MeanQ | MinQ | Decision |
| --- | --- | ---: | --- | ---: | ---: | --- |
| [TSBC-1269](/TSBC/issues/TSBC-1269) | R1 bare auditor x10 full suite | `120/120` ok | uploaded `runs.json`, summary JSON, runner log, PDF; served models `grok-4.3` | `0.968` | `0.592` | decision-grade |
| [TSBC-1270](/TSBC/issues/TSBC-1270) | R1 bare ops x10 full suite | `100/100` ok | uploaded PDF and closeout comment; PDF records fresh per-sample Hermes controls and served model `grok-4.3` | `0.960` | `0.714` | decision-grade |
| [TSBC-1394](/TSBC/issues/TSBC-1394) | corrected mixed Spark rerun | `21/21` ok | local raw JSON rows with `servedModelVerified=true`, `servedModelMismatch=false`, `servedModel=grok-4.3` | `0.957` | `0.613` | decision-grade supplemental |

Total reconciled non-carve-out Grok 4.3 rows in this sweep: `241`.

## Surface Coverage

| Surface | Evidence | Reconciled rows | Result |
| --- | --- | ---: | --- |
| Auditor | [TSBC-1269](/TSBC/issues/TSBC-1269) full x10 suite | `120` | no supplemental run useful |
| Ops | [TSBC-1270](/TSBC/issues/TSBC-1270) full x10 suite plus [TSBC-1394](/TSBC/issues/TSBC-1394) recency rows | `103` | no supplemental run useful |
| CV-review | [TSBC-1394](/TSBC/issues/TSBC-1394) corrected mixed rerun, two CV bands | `12` | no supplemental run useful for this 4.3 sweep |
| Engineer/summarize supplemental recency | [TSBC-1394](/TSBC/issues/TSBC-1394) mixed rows | `6` | covered as supplemental context |
| Paperclip fixture route | [TSBC-1484](/TSBC/issues/TSBC-1484) / [TSBC-1475](/TSBC/issues/TSBC-1475) chain | `0` new rows here | explicit carve-out |

## Carve-Out

The only missing cell remains the [TSBC-1484](/TSBC/issues/TSBC-1484) fixture route. I did not try to solve, substitute, or rerun that blocked cell. Per the parent instruction, [TSBC-1475](/TSBC/issues/TSBC-1475) R1 `paperclip` full cell remains the carve-out candidate until the parent performs the post-20:00 local check.

## Ledger Reconciliation

[TSBC-1546](/TSBC/issues/TSBC-1546) created no new benchmark run, no Grok CLI calls, and no shared-ledger rows. The shared ledger did advance during the heartbeat due to other burn lanes, so this issue records a reconciliation note instead of claiming a ledger delta.

## Artifacts

| Artifact | Path |
| --- | --- |
| Human reconciliation source | `work-products/TSBC-1543/TSBC-1546/reconciliation-TSBC-1546.md` |
| Raw/session evidence manifest | `work-products/TSBC-1543/TSBC-1546/raw-row-manifest.json` |
| Ledger reconciliation note | `work-products/TSBC-1543/TSBC-1546/ledger-reconciliation.json` |
| Machine-readable verdict | `work-products/TSBC-1543/TSBC-1546/verdict.json` |
| Evidence bundle | `work-products/TSBC-1543/TSBC-1546/TSBC-1546-raw-session-evidence.zip` |
| PDF render | `work-products/TSBC-1543/TSBC-1546/TSBC-1546-report.pdf` |

## Verdict

`CONFIRMED`.

All runnable non-[TSBC-1484](/TSBC/issues/TSBC-1484) Grok 4.3 gaps named in this issue are decision-grade from existing evidence. Close disposition: `locked_except_TSBC-1484`.

## TSKB Delta

None. This heartbeat applied existing TSBC artifact and closeout rules; it did not create reusable new process knowledge.

## Render Command

```sh
~/scripts/brand-suite/brandsuite pdf --brand stack-lab -- \
  --input work-products/TSBC-1543/TSBC-1546/TSBC-1546-report.md \
  --out work-products/TSBC-1543/TSBC-1546/TSBC-1546-report.pdf \
  --title "TSBC-1546 Report - Grok 4.3 runnable-cell sweep"
```
