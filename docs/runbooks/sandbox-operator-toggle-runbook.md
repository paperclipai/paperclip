# Sandbox operator-toggle runbook (Layer 4)

**Owner:** EAOS Release Manager + on-call operator
**Layer:** 4 of 5 in the S3 §5 sandbox kill-switch model
**Source of truth:** [LET-369](/LET/issues/LET-369), [LET-367](/LET/issues/LET-367), S3 doc §5 on [LET-362](/LET/issues/LET-362)

This runbook is the **human-in-the-loop** procedure for Layer 4 of the
managed-sandbox kill-switch: the audited operator toggle. Operators use it to
pause or resume the managed sandbox provider (currently E2B) without waiting
for a billing-cap breach or a code change.

It does **not** cover:

- automatic kill-switch flips on day/month hard-cap breach
  (Layer 3 — see [`sandbox-billing-cap-re-enable-runbook.md`](./sandbox-billing-cap-re-enable-runbook.md))
- production deploy or service restart (not in scope for any kill-switch layer)

## When to use

Flip the operator toggle when:

- the on-call operator needs to immediately pause the managed sandbox provider
  ahead of a billing-cap breach (e.g. mid-incident traffic spike, unexpected
  agent loop)
- a vendor-side anomaly is suspected (auth/latency/quotas) and the safer move
  is to stop using the provider until a vendor-status check completes
- a control-plane change is being rolled out and the provider should be paused
  for the cutover window

If a hard-cap auto-disable has already fired, **use the billing-cap re-enable
runbook instead** — this runbook does not lift the monthly hard-cap lock.

## Where to flip it

1. Open the EAOS Command Center at `/eaos`. The sandbox kill-switch panel
   lives under the **Sandbox / Managed providers** section.
2. The panel reads from `GET /api/companies/{companyId}/sandbox/billing-cap/status`.
   You should see the current Layer 4 state in the kill-switch layer list:
   - `operator-toggle: enabled` — provider is allowed to acquire leases
     (subject to Layers 1, 2, 3, 5).
   - `operator-toggle: disabled` — provider returns `PROVIDER_DISABLED` on
     every `acquireLease`.
3. The **Flip operator toggle** button is only shown when `canOperate=true`
   in the status payload. Non-board accounts, viewer-role memberships, and
   agents see a read-only view (the route 403s on POST attempts).

## Reason text conventions

The admin-API route requires a non-empty `reason` (HTTP 422 if missing). Keep
the reason short, action-oriented, and traceable:

- prefix with the trigger: `incident:`, `cutover:`, `vendor-status:`, `manual:`
- include the incident or PR id when available
- keep under 140 chars; this lands in `sandbox_billing_cap_events.reason`

Examples:

```
incident: I-2026-05-18 — pausing E2B during runaway-loop triage
cutover: deploy 4A-S4 B5 canary; resume after smoke
vendor-status: api.e2b.app 5xx burst, see grafana.internal/d/api-latency
manual: post-mortem sandbox bake; resume EOD
```

## Audit trail

Every flip writes:

1. An immutable row in `sandbox_billing_cap_events` with
   `kind = 'operator_toggle_flipped'`, `actor_label`, `reason`, and
   `occurred_at`. The most recent 20 rows surface on the kill-switch panel.
2. A row in `activity_log` with `action = 'sandbox.kill_switch.flipped'` so
   the operator activity stream picks up the flip alongside other platform
   activity. The `entity_id` is the cap-event id.
3. A monitor notifier call (`tone = warning|info`) that fans out through the
   configured notifier composite (LogCapNotifier in dev, plus Slack/PagerDuty
   adapters when configured).

Auditors filtering for sandbox kill-switch activity should use:

```sql
SELECT occurred_at, actor_label, reason, metadata
  FROM sandbox_billing_cap_events
 WHERE company_id = :company_id
   AND provider   = 'e2b'
   AND kind = 'operator_toggle_flipped'
 ORDER BY occurred_at DESC;
```

For activity_log:

```sql
SELECT created_at, actor_id, details
  FROM activity_log
 WHERE company_id = :company_id
   AND action = 'sandbox.kill_switch.flipped'
 ORDER BY created_at DESC;
```

## Direct admin-API call (fallback)

If the `/eaos` UI is unavailable, the flip can be issued directly. **Board
role required** — non-board callers get HTTP 403 and the flip is not
recorded.

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/sandbox/billing-cap/operator-toggle" \
  -H "Authorization: Bearer $PAPERCLIP_BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "enable": false,
        "reason": "incident: I-2026-05-18 — pausing E2B during runaway-loop triage"
      }'
```

Expected responses:

- `200 { ok: true, currentlyEnabled: false|true }` — flip succeeded.
- `409 { error: { ... currentlyEnabled } }` — already in the requested state.
- `409 { error: { kind: 'reenable_refused' } }` — re-enable blocked by an
  active monthly hard-cap breach. Switch to the **billing-cap re-enable
  runbook**.
- `422` — the `reason` field is missing or empty.
- `403` — the caller is not a board operator (viewer or agent).

The flip is **immediate**: subsequent `acquireLease` calls fail closed with
`PROVIDER_DISABLED` and the live transport is never constructed. Existing
sandbox leases continue until their existing state machine completes — Layer
4 controls *new* acquisitions only.

## Escalation if the flip fails

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `403 Forbidden` on POST | Caller lacks board role / has viewer membership | Re-authenticate with a board-role API key. Do NOT escalate to a service account. |
| `422 Unprocessable Entity` | Empty/missing `reason` | Supply a real reason; never paste `"test"` into production. |
| `409 reenable_refused` | Monthly hard-cap breach on record | Switch to [`sandbox-billing-cap-re-enable-runbook.md`](./sandbox-billing-cap-re-enable-runbook.md). |
| Route returns 5xx | Server-side persistence error | Check the server logs for `sandbox billing-cap operator toggle flipped` lines; if absent, the request didn't reach the route. Capture trace + page on-call backend. |
| Flip succeeds but provider still serves leases | Stale in-process `isProviderEnabled` cache | Bounce the affected server. The persisted state is the source of truth; restart re-reads it. |
| Cannot reach `/eaos` UI at all | Control-plane outage | Use the curl form above against the API URL recorded in [LET-365](/LET/issues/LET-365). If the API is also down, page Andrii — production deploy/restart is **not** a Layer 4 operator action. |

If any step above is blocked or ambiguous, page Andrii. Layer 4 is the
operator-facing layer; Andrii is the only escalation path that can authorize
production deploy/restart actions.

## Re-enabling after a manual pause

A pause put in place by this runbook is cleared by the same route with
`{ enable: true, reason: ... }`. If the system has *also* recorded a monthly
hard-cap breach in the meantime, the re-enable will be refused with the
`reenable_refused` code and you must follow the billing-cap re-enable runbook
to clear the breach lock first.

## See also

- [`sandbox-billing-cap-re-enable-runbook.md`](./sandbox-billing-cap-re-enable-runbook.md) — Layer 3 re-enable procedure (Andrii confirmation required)
- [LET-369](/LET/issues/LET-369) — five-layer kill-switch test suite + runbook deliverables
- [LET-367](/LET/issues/LET-367) — billing-cap monitor + auto-disable implementation
- [LET-362](/LET/issues/LET-362) §5 — kill-switch layer model
