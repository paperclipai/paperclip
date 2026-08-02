Blocked: VA1 live matrix preflight failed closed.

Wake payload had `fallbackFetchNeeded=false` and scoped this heartbeat to [TSBC-1577](/TSBC/issues/TSBC-1577), so I used the inline issue contract and ran the registered command instead of fetching unrelated work.

What happened:

- Ran: `python3 run_va1_compliance.py --models grok-4.3,codex-gpt-5.4,claude-sonnet-5 --reps 3`
- Harness wrote preflight run `va1-20260730-203722`, then exited `2` before creating fixture issues.
- Blocker 1: TSBC power gate is still `heavyTasksAllowed=false` (`mode=low`, reason `ThinkStack Capital sprint 13-23; ThinkStack Media sprint 09-03`).
- Blocker 2: `Bench-claude-sonnet-5` is still `paused` with pause reason `manual`.
- Live cells created: `0/36`; no approved `DEVIATION` exists, so I did not narrow or substitute the 4 probe cells x 3 model rows x 3 reps matrix.
- `ledger/results.jsonl` received no `va1_compliance` rows for `va1-20260730-203722`, which is correct for this blocked preflight and leaves the acceptance criterion unmet.

Evidence banked:

- Governed packet root: `/Users/glad0s/paperclip/benchmark/work-products/TSBC-1577/`
- Company custody mirror: `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1577/`
- Parent mirror for [TSBC-1573](/TSBC/issues/TSBC-1573): `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1573/TSBC-1577/`
- PDF: `work-products/TSBC-1577/TSBC-1577-report.pdf` (`sha256 84b72e1331ccc0098a29dde7b52d7a60fe3329308e285fe0a86e326697b002c0`)
- Source: `work-products/TSBC-1577/TSBC-1577-report.md`
- Evidence bundle: `work-products/TSBC-1577/TSBC-1577-evidence.zip` (`sha256 afa6321ea2de0c8be4d74c544d3a5120641585944326cd90fb45f4fcce042f47`)
- Hash inventory: `work-products/TSBC-1577/sha256-inventory.txt`

Attachment/work-product API note:

- Attachment upload to the current issue returned HTTP `500` twice, including a direct multipart retry, so I stopped retrying that control-plane write for this heartbeat.
- Issue work-product create/read also returned HTTP `500`; the governed local packet and company custody mirror are the durable fallback evidence until the attachment route is healthy.

Verification:

- `jq empty` passed for `preflight.json`, `summary.json`, `recommendations.json`, `runs.json`, and `records.json`.
- `pdfinfo` opened `TSBC-1577-report.pdf`: 4 pages, A4, 144179 bytes.
- `pdftotext` confirmed `INCONCLUSIVE`, `heavyTasksAllowed=false`, `Bench-claude-sonnet-5`, `0/36`, and `TSBC-1573-VA1-LIVE-RUN`.
- `unzip -t TSBC-1577-evidence.zip` passed with no compressed-data errors.
- `rg "va1_compliance|va1-20260730-203722" ledger/results.jsonl` found no ledger rows for the blocked preflight run.

Unblock owner/action:

- TSBC power controller/operator: clear the sprint power gate so `/Users/glad0s/paperclip/benchmark/.tsbc-power.json` reports `heavyTasksAllowed=true`.
- Operator/bench owner: unpause `Bench-claude-sonnet-5` or provide another approved, unpaused Claude bench agent id for the `claude-sonnet-5` row.
- Bench-Manager: rerun the exact registered command after both gates are clear.

Reusable TSKB delta: none. This heartbeat produced issue-specific benchmark preflight evidence only.

Never-again gates checked: G2, G4, G5, G7, G8, G9. Evidence: governed packet and mirrors listed above. Unsatisfied gates: live run and attachment-backed Paperclip artifact are blocked by the owner/actions above.
