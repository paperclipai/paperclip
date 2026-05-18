# Sandbox billing-cap re-enable runbook (Layer 3)

**Owner:** Andrii (board) + EAOS Release Manager
**Layer:** 3 of 5 in the S3 §5 sandbox kill-switch model
**Source of truth:** [LET-369](/LET/issues/LET-369), [LET-367](/LET/issues/LET-367), S3 doc §5 on [LET-362](/LET/issues/LET-362)

This runbook covers the **post-incident re-enable** procedure after the
managed-sandbox billing-cap monitor has auto-disabled the provider on a
day or month hard-cap breach. Re-enable is **gated by an explicit Andrii
`request_confirmation`** — the system refuses to re-enable autonomously
even at UTC day rollover while a monthly hard-cap breach is on record.

It does **not** cover:

- preventive operator pauses without a cap breach
  (Layer 4 — see [`sandbox-operator-toggle-runbook.md`](./sandbox-operator-toggle-runbook.md))
- production deploy or service restart
- raw vendor credential handling — only vendor names (e.g. E2B) and the
  console URL `https://e2b.dev/dashboard` are referenced

## When this runbook applies

You should be here when the kill-switch panel at `/eaos` shows one of:

- `provider-enable: disabled` with reason `day_hard_cap_breached`, **and**
  the day rollover has not yet cleared the day window, **or**
- `provider-enable: disabled` with reason `month_hard_cap_breached` —
  this requires Andrii confirmation regardless of day rollover.

Equivalently, the `sandbox_billing_cap_state` row shows:

- `provider_enable_layer_enabled = false`
- `month_hard_cap_breached_at IS NOT NULL` for the current UTC month

If `month_hard_cap_breached_at` is `NULL` and only `day_hard_cap_breached_at`
is set, the monitor auto-resumes at the next UTC day rollover and you do not
need this runbook — wait for the rollover or open a separate request to
operate Layer 4 instead.

## Required evidence package

Before requesting Andrii confirmation, assemble the following. The request
**will be rejected** if any item is missing or stale.

1. **Cost-cause note** — a short markdown comment on the incident issue
   describing what drove the breach. Include:
   - which company/run/issue triggered the runaway spend
   - the per-lease cost estimate at the time of breach (from the kill-switch
     panel's recent-lease table)
   - whether `Source A` (vendor) or `Source B` (internal-estimate) was the
     authoritative source for the breach decision
2. **Mitigation taken** — bullet list of:
   - the agent loop / config / policy that was tightened
   - the PR or config-change link that lands the fix
   - the new daily/monthly projection if the same workload re-runs
3. **Fresh projection** — re-run the projection AFTER the mitigation is
   merged. The projection should be below the soft-cap, not just below the
   hard-cap. Pull from `GET /api/companies/{companyId}/sandbox/billing-cap/status`
   or the rerun of `BillingCapMonitor.tick()` in dry-run mode.
4. **Incident issue link** — if a monthly hard-cap breach triggered an
   automatic incident issue (`sandbox.cost_breach.incident_opened`), include
   the issue identifier. The incident issue must be at status `done`,
   `in_review`, or `blocked` with a stated unblock owner before re-enable
   can be requested.

## Andrii `request_confirmation` payload

Open a confirmation interaction on the original incident issue. Use the
canonical idempotency key shape so retries are safe:

```
confirmation:sandbox-billing-cap-reenable:{companyId}:{incidentIssueId}:{utcMonth}
```

Where `{utcMonth}` is `YYYY-MM` of the breach's UTC month. Re-enable requests
in different months use different keys; a retry for the same month resolves
to the same prior decision.

Example request:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/$INCIDENT_ISSUE_ID/interactions" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -d '{
        "kind": "request_confirmation",
        "idempotencyKey": "confirmation:sandbox-billing-cap-reenable:'"$COMPANY_ID"':'"$INCIDENT_ISSUE_ID"':2026-05",
        "title": "Re-enable managed sandbox provider (E2B) after monthly hard-cap breach",
        "body": "Cost-cause: …\nMitigation: …\nFresh projection: …\nIncident issue: '"$INCIDENT_ISSUE_ID"'",
        "continuationPolicy": "wake_assignee"
      }'
```

Notes:

- `continuationPolicy: "wake_assignee"` ensures the EAOS Codex Executor
  (or whichever agent owns the re-enable work) is woken **only on acceptance**
  — rejection or no-response keeps the provider disabled.
- The body should reference the evidence package; large evidence (charts,
  query results) belongs in the incident issue's comments/documents, not in
  the confirmation body.
- Do **not** put raw E2B API keys, vendor session ids, or PII in the
  interaction payload. The vendor reference is the name "E2B" and the console
  URL `https://e2b.dev/dashboard` only.

## After Andrii accepts

Once Andrii accepts the `request_confirmation`:

1. The assignee wakes with `PAPERCLIP_APPROVAL_ID` / `PAPERCLIP_APPROVAL_STATUS=accepted`.
2. **Clear the monthly breach lock** with the admin-API call below. This is the
   only call that lifts the monthly lock; the operator-toggle route refuses
   re-enable while the lock is in place.

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/sandbox/billing-cap/operator-toggle" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "enable": true,
        "reason": "approved: Andrii confirmation '"$APPROVAL_ID"' — incident '"$INCIDENT_ISSUE_ID"' resolved, mitigation merged"
      }'
```

Expected responses:

- `200 { ok: true, currentlyEnabled: true }` — the toggle is back on, but
  Layer 3 may still need to clear (see step 3).
- `409 { error: { kind: 'reenable_refused' } }` — the monthly breach lock is
  still active. Do **not** retry; capture the response, attach it to the
  confirmation thread, and escalate.

3. **Reset the breach lock state row.** This is the only direct DB action in
   this runbook and is only performed via the audited service helper, never
   via raw SQL:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/sandbox/billing-cap/clear-breach" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "approvalId": "'"$APPROVAL_ID"'",
        "incidentIssueId": "'"$INCIDENT_ISSUE_ID"'",
        "scope": "monthly",
        "reason": "Andrii confirmation accepted; mitigation merged"
      }'
```

> **Note (preview-only surface):** at the time of LET-369 this clear-breach
> endpoint is part of the planned admin-API surface but is not yet wired in
> the server. Until it lands (tracked under the LET-367/LET-369 follow-up
> queue), Andrii must explicitly clear the breach in the same confirmation
> by writing a board comment and re-running the operator-toggle route with
> the canonical reason text above. Do not attempt a direct DB patch — the
> audit trail must run through the route.

4. Confirm the kill-switch panel now shows:
   - `provider-enable: enabled`
   - `operator-toggle: enabled`
   - the most recent event row is the `operator_toggle_flipped` with the
     approval reference in `reason`.

## Audit trail

Every step is recorded:

- `sandbox_billing_cap_events.kind` values relevant to this runbook:
  `hard_cap_breached`, `auto_disable_engaged`, `monthly_incident_opened`,
  `reenable_refused`, `operator_toggle_flipped`.
- `activity_log.action` values: `sandbox.cost_breach`,
  `sandbox.cost_breach.incident_opened`, `sandbox.kill_switch.flipped`,
  `sandbox.kill_switch.reenable_refused`.
- The `approval_id` in the operator-toggle reason links the activity row to
  the Andrii confirmation thread.

For an end-to-end review, filter on the same `company_id` + `provider='e2b'`
and order by `occurred_at` ascending; the sequence should read:

```
hard_cap_breached(month) → auto_disable_engaged(month)
  → monthly_incident_opened(incidentIssueId=…)
  → reenable_refused (×N attempts while locked)
  → operator_toggle_flipped(reason='approved: Andrii confirmation … resolved')
```

If any `operator_toggle_flipped` row in this sequence does **not** name the
approval id, treat it as a gap and re-open the incident issue. The board
audit policy requires the approval reference inline in the reason.

## What to do if the re-enable fails

| Symptom | Action |
| --- | --- |
| `409 reenable_refused` even after Andrii confirmation | Verify the confirmation `status=accepted`. If accepted, the breach lock is still on the row — escalate to Andrii with the response body; do NOT attempt a DB patch. |
| Kill-switch panel still shows `disabled` after a 200 from the toggle route | Bounce the affected server so the in-process cache re-reads the persisted state. Production deploy/restart is Andrii-only; if the bounce requires a deploy, page Andrii. |
| Cost projection in the evidence package is above soft cap | Do not request confirmation yet. Either tighten the mitigation further or reduce concurrency before requesting. |
| Vendor (E2B) console at `https://e2b.dev/dashboard` shows a different cost than the kill-switch panel | Note both numbers in the evidence package. Source A (vendor) is authoritative when available; Source B (internal estimate) is the fallback. |

## See also

- [`sandbox-operator-toggle-runbook.md`](./sandbox-operator-toggle-runbook.md) — Layer 4 preventive pause/resume (no Andrii required)
- [LET-369](/LET/issues/LET-369) — five-layer kill-switch test suite + runbook deliverables
- [LET-367](/LET/issues/LET-367) — billing-cap monitor + auto-disable implementation
- [LET-362](/LET/issues/LET-362) §5 — kill-switch layer model
