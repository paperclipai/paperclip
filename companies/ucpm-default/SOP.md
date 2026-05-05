---
schema: ucpm-sop/v1
version: 1.0.0
company: ucpm-default
status: canonical-default
inherited_by: every per-property UCPM-Paperclip company unless overridden
---

# UCPM Default Property-Management SOP (v1)

This SOP is read by the per-property agent loop on every iteration. Four personas execute it:

- `property-orchestrator` — router. Reads inbound events, selects the procedure below, dispatches to the right persona, enforces escalation gates.
- `property-manager` — strategic / owner-facing. Owns the daily owner digest, lease decisions, anything the operator (Matt) approves.
- `assistant-property-manager` — operational. Owns tenant comms, maintenance dispatch, vendor follow-up.
- `property-accountant` — ledger. Owns rent invoicing, payment matching, statements, vendor invoices, distributions.

**v1 scope:** tenant-comm triage, maintenance dispatch, accounting basics, owner digest, lease awareness (read-only), vendor lifecycle.
**Out of scope (v1):** leasing/tours, eviction filings, capital projects > $500, physical access changes, anything legal/judicial. Anything out of scope falls through to **P-09 Default escalation**.

## Global invariants

- **Human gate.** No outbound message to a tenant, owner, vendor, or third party is sent without operator (Matt) approval, except (a) automated rent invoices on schedule, (b) work-order acknowledgement to tenant in the form fixed in P-02, (c) vendor dispatch in the form fixed in P-02. Everything else is **drafted-and-queued** to `outbox/pending_approval/` and surfaced in the owner digest.
- **Spend gate.** Any committed spend > $500 (single PO or aggregated work order) requires operator approval before vendor dispatch, regardless of urgency. For life-safety emergencies see P-02 emergency branch.
- **Legal gate.** Any communication that names a statute, threatens a remedy, references a lease default, or originates a notice (3-day, cure-or-quit, NSF, etc.) is drafted-and-queued. Never auto-sent.
- **Lease-change gate.** No procedure mutates lease terms. Any inbound request to modify a lease (rent, term, occupants, pets, alterations) routes to P-09.
- **Novel-situation gate.** If an inbound event does not match any procedure trigger below, route to P-09 with the full event payload.
- **Audit log.** Every procedure step writes one row to BigQuery `ucpm.audit_log` with: `ts, property_id, procedure_id, step, persona, inputs_hash, action, output_ref, escalated_bool, operator_review_state`. No silent actions.
- **Idempotency.** Every action carries an idempotency key of `sha256(property_id|procedure_id|trigger_event_id)`. Replays must not double-act.

## State stores

- BigQuery `ucpm.*` — properties, units, leases, tenants, vendors, work_orders, ledger, comms, audit_log, owner_digests.
- Object storage `ucpm-docs/<property_id>/` — leases, COIs, W-9s, invoices, photos.
- Comms inbox: shared mailbox per property, IMAP-readable; outbound through draft queue.
- Draft queue: `outbox/pending_approval/<property_id>/<draft_id>.yml` — operator approves/rejects/edits in the daily digest UI.

---

## P-01 — Inbound tenant comm intake

**Trigger.** New email or SMS arrives in the property's shared inbox; webhook fires `comm.inbound` event with `comm_id`, `property_id`, `from`, `subject`, `body`, `attachments[]`.

**Inputs.**
- `ucpm.tenants` filtered by `property_id` and `from` (sender match by email/phone).
- `ucpm.leases` for the matched tenant (status, end date, current balance).
- Last 30 days of `ucpm.comms` for this thread (`thread_id` if present, else fuzzy match on subject + sender).
- Lease document at `ucpm-docs/<property_id>/leases/<lease_id>.pdf` (referenced, not re-read; abstract fields live in `ucpm.leases`).

**Decision criteria.** Classify the comm into exactly one `intent` using these rules in order; first match wins:

1. `intent=maintenance` — body or subject mentions any of: leak, water, flood, gas, smell, smoke, fire, no heat, no AC, broken, won't, not working, clogged, stuck, mold, pest, roach, rodent, electrical, outlet, breaker, lock, door, window, appliance, toilet, shower, sink, ceiling, floor, wall, roof.
2. `intent=payment` — mentions rent, payment, balance, autopay, ACH, check, late fee, receipt, statement.
3. `intent=lease_change` — mentions renew, extend, terminate, break lease, move out, sublease, transfer, add occupant, pet, alteration, paint, install.
4. `intent=notice_required` — mentions notice (move-out notice, intent to vacate), or matches lease-required notice keywords.
5. `intent=complaint_neighbor` — mentions noise, smoke (cigarette/cannabis context), parking, common area, another unit, neighbor.
6. `intent=admin` — mentions COI, insurance certificate, key, parking permit, emergency contact, address change.
7. `intent=legal` — mentions attorney, lawsuit, court, ADA, discrimination, fair housing, harassment, retaliation, statute citation.
8. `intent=unclassified` — none of the above.

**Action.**
- Persist `ucpm.comms` row with `intent`, `urgency_hint` (see P-02 if maintenance), `thread_id`.
- Route by intent:
  - `maintenance` → P-02.
  - `payment` → P-04 (payment branch).
  - `lease_change` or `notice_required` or `legal` → P-09 (lease-change gate / legal gate).
  - `complaint_neighbor` → draft acknowledgement (template `ack_neighbor_complaint`) into draft queue, log to `ucpm.comms`, surface in owner digest. No outbound action without approval.
  - `admin` → if request is COI submission or W-9 (vendor mistakenly using tenant inbox) → store in `ucpm-docs/`, draft confirmation. If key/permit request → draft confirmation, route to P-09 because this involves physical access (out of v1 scope).
  - `unclassified` → P-09.
- Auto-acknowledge only `maintenance` (handled in P-02) and `payment` receipt-of-receipt confirmations (P-04). All others draft-and-queue.

**Output / log.** `ucpm.comms` row, `ucpm.audit_log` entry with `procedure_id=P-01`, draft file in `outbox/pending_approval/` if applicable.

**Escalation.** Any `intent=legal`, `intent=lease_change`, `intent=notice_required`, or `intent=unclassified` → P-09 with full thread, sender, lease summary, and proposed-action=null.

---

## P-02 — Maintenance request triage

**Trigger.** P-01 routes a comm with `intent=maintenance`, OR a recurring inspection task fires, OR a vendor reports a follow-on issue.

**Inputs.**
- The comm body (or inspection note).
- `ucpm.units` for the tenant's unit (last 5 work orders, recurring-issue flag).
- `ucpm.vendors` filtered by `property_id`, trade tag, COI valid, W-9 on file, SLA-status=active.
- `ucpm.leases` for who pays (tenant-caused damage vs landlord obligation per lease — abstract field `repair_responsibility_matrix`).

**Decision criteria — urgency.** Classify in order; first match wins.

1. `urgency=emergency` — keywords: gas, smoke, fire, flood (active water flow), sewage backup, no heat AND outdoor temp < 40F, no AC AND outdoor temp > 90F AND tenant medical note on file, electrical sparking/burning smell, broken exterior lock/door, ceiling collapse, carbon monoxide.
2. `urgency=high` — affects habitability but not life-safety: no hot water, single-zone HVAC down, refrigerator dead, single inoperative toilet in 1-bath unit, active leak (slow), broken window, broken interior lock, infestation actively observed.
3. `urgency=normal` — does not affect habitability: cosmetic, slow drain, single burner out, loose handle, paint, scuff, light bulb, appliance quirk that still functions.
4. `urgency=scheduled` — not broken; tenant requesting routine work (filter change, recaulk).

**Decision criteria — vendor selection.**
- Filter `ucpm.vendors` by `trade ∈ {issue.trade_tags}`, `coi_valid=true`, `w9_on_file=true`, `sla_status=active`, `property_id ∈ vendor.coverage`.
- Rank by: (1) prior performance score on this property (descending), (2) median response time for `urgency` tier (ascending), (3) last-used recency (round-robin tiebreak).
- If no qualifying vendor → P-08 onboarding branch + P-09 if urgency in {emergency, high}.

**Decision criteria — payer.**
- Default landlord-paid unless `repair_responsibility_matrix` assigns to tenant for this category, OR the comm body or unit history indicates tenant-caused damage. If ambiguous → assume landlord-paid for v1, flag for operator review in digest.

**Decision criteria — spend gate.**
- If estimated cost (vendor rate-card × estimated hours, +parts allowance) > $500 → require operator approval before dispatch.
- Exception: `urgency=emergency` may dispatch immediately up to $2,000 to mitigate; operator notified within 15 minutes via push to digest channel; full approval still required for any work beyond mitigation.

**Action.**
- Create `ucpm.work_orders` row: `wo_id`, `property_id`, `unit_id`, `tenant_id`, `urgency`, `trade`, `description`, `payer`, `estimated_cost`, `vendor_id` (proposed), `status=pending_dispatch` (or `dispatched` for emergency).
- Tenant acknowledgement: send fixed-template ack within 1 hour for `urgency in {emergency, high}`, within 4 hours for `normal`, within 1 business day for `scheduled`. Template includes WO id, expected response window, and "we will follow up when scheduled". This is one of the three pre-approved auto-sends.
- Vendor dispatch: send fixed-template dispatch (WO id, address, unit, tenant contact, scope, estimated cap, urgency). Pre-approved auto-send if spend gate clears and vendor is in approved list.
- Calendar invite for scheduled-urgency items goes to draft queue (involves tenant scheduling).

**Output / log.** `ucpm.work_orders` row, `ucpm.audit_log` entry, outbound comm rows for ack and dispatch.

**Escalation.**
- `urgency=emergency` → operator notification within 15 minutes regardless of dispatch state.
- Spend > $500 → halt at `pending_dispatch`, surface in digest top-of-list.
- No qualifying vendor → P-08 + P-09.
- Any signal of tenant injury, displacement, or legal threat in body → P-09 immediately (legal gate).

---

## P-03 — Maintenance follow-up

**Trigger.** Cron every 6 hours, plus webhook on vendor reply or invoice receipt.

**Inputs.** All `ucpm.work_orders` with `status ∉ {closed, cancelled}` for the property.

**Decision criteria — per work order, evaluate state and apply rule:**

1. `status=pending_dispatch` and `urgency=emergency` and `dispatched_at IS NULL` and now − created_at > 30 min → P-09 (emergency dispatch failure).
2. `status=dispatched` and vendor has not acknowledged within SLA window for urgency tier (emergency 1h, high 4h, normal 1 business day, scheduled 3 business days) → re-dispatch to next-ranked vendor; log original vendor SLA miss to `ucpm.vendors.sla_misses`. Second SLA miss in same WO → P-09.
3. `status=acknowledged` and not scheduled within (emergency same-day, high 48h, normal 5 business days) → ping vendor; if no response in 24h → re-dispatch.
4. `status=scheduled` and scheduled date is in future → no action, monitor.
5. `status=scheduled` and scheduled date is past and no completion confirmation → ping vendor; if no response in 24h → P-09.
6. `status=completed` and no invoice received within 14 days → ping vendor for invoice; after 30 days → log to digest, do not auto-close.
7. `status=completed` and invoice received → P-05 vendor-invoice branch for coding and approval; on payment, set `status=closed`.
8. Any WO open > 60 days → P-09 (stuck WO).

**Action.** Per the rule above: re-dispatch (new vendor selection per P-02 ranking), ping vendor (templated email referencing WO id), or escalate.

**Tenant follow-up.**
- On `status=scheduled` → draft tenant notification with date/window, send (pre-approved auto-send class).
- On `status=completed` → send tenant satisfaction prompt (pre-approved auto-send) 24h after completion. Reply triggers P-01 with `intent=maintenance` if dissatisfied (re-opens loop).

**Output / log.** Updated WO row, `ucpm.audit_log` entries, outbound comms, vendor SLA counters.

**Escalation.** Per rules above; all escalations flow through P-09.

---

## P-04 — Rent billing cycle

**Trigger.** Cron daily at 03:00 local property tz. Logical events:
- Day −5 of due date → invoice generation.
- Due date → invoice issuance (already sent on day −5; this fires payment-matching window).
- Due date + grace_period_days (lease field, default 5) → late-fee logic.
- Due date + 10 → delinquency draft.
- Tenant payment events from bank/processor webhook.

**Inputs.**
- `ucpm.leases` (rent_amount, due_day, grace_period_days, late_fee_rule, autopay_status).
- `ucpm.ledger` (current balance, prior-month status).
- Bank/processor `ucpm.transactions_inbound` (last 7 days).

**Decision criteria.**

- **Invoice generation (day −5).** If `lease.status=active` and `lease.autopay=false` and no invoice for this period yet → generate invoice with line items: base rent, recurring add-ons (parking, storage, pet rent), prior-balance carry, credits. Total = sum.
- **Invoice issuance.** Pre-approved auto-send class — automatic email + ledger entry. No human gate. Format fixed.
- **Payment matching.** For each inbound bank transaction: match by `tenant_id` (memo, sender name, account fingerprint). Match confidence ≥ 0.95 → auto-post to ledger, send receipt (pre-approved auto-send). 0.70–0.95 → draft post for operator review. < 0.70 → hold in `ucpm.transactions_unmatched`, surface in digest.
- **Late-fee logic.** On day = due_date + grace_period_days, if balance > 0 and no payment posted: apply late fee per `lease.late_fee_rule` (flat or percent, capped at lease maximum or state cap, whichever lower). Post to ledger. Notify tenant via templated late-fee notice — **drafted and queued, not auto-sent** (legal gate touches state notice rules).
- **Delinquency draft.** On day = due_date + 10, if balance still > 0: draft a delinquency notice (template per state, plain language, no statute citations) and queue. Operator approves → sends. Operator declines or edits → resend through queue.
- **NSF / chargeback.** Inbound webhook with reversal → reverse ledger post, restore prior balance, draft NSF notice (legal gate — queue, do not send).

**Action.** Ledger writes, invoice email send (auto class), late-fee posting, queued drafts.

**Output / log.** `ucpm.ledger` rows, `ucpm.invoices`, outbound comms, draft files.

**Escalation.**
- Two consecutive months delinquent → P-09 with full ledger and comm history; operator decides whether to begin formal-notice flow (out of v1 scope).
- Any tenant reply to a delinquency draft mentioning hardship, dispute, or legal → P-09 (legal gate).
- Unmatched payment older than 14 days → P-09.

---

## P-05 — Accounting close

**Trigger.** Cron daily at 04:00 local tz (daily reconciliation). Cron monthly on 1st at 06:00 (monthly statement). Cron monthly on owner-distribution day per `ucpm.properties.distribution_day` (default 10th).

**Inputs.**
- All `ucpm.ledger` rows for the period.
- `ucpm.transactions_inbound` and `ucpm.transactions_outbound`.
- `ucpm.work_orders` with vendor invoices in period.
- `ucpm.properties.operating_account_balance` (banking webhook).
- Owner reserve / minimum-balance setting.

**Decision criteria.**

- **Daily reconciliation.** For each ledger row in last 24h: confirm matching bank transaction (≥ 0.95 confidence) or flag. Compute end-of-day balance, compare to bank, log delta. Delta > $1 → P-09.
- **Monthly statement (1st).** Generate per-tenant statements (rolled from invoices + payments + adjustments) and per-property P&L (income = collected rent + fees; expenses = vendor invoices paid + utilities + management fee + reserves).
- **Vendor invoice coding.** From P-03 hand-off, code invoice to GL category by trade tag (HVAC → 6210-Repairs HVAC, etc., per chart of accounts). Match to WO. > $500 or no matching WO → operator approval before payment. ≤ $500 with matching WO and vendor in good standing → queue for payment per `ucpm.properties.payment_terms` (default Net 15).
- **Owner distribution.** On distribution_day: distribution = operating_balance − reserve_floor − next-30-day forecasted expenses. If distribution > 0 → draft distribution memo + ACH instruction, queue for operator approval. If ≤ 0 → draft "no distribution this period" line for digest.

**Action.** Reconciliation logs, statements written to `ucpm-docs/<property_id>/statements/`, vendor payments queued or auto-released per gate, distribution drafted.

**Output / log.** `ucpm.audit_log` entries, statement PDFs, queued payment files, distribution draft.

**Escalation.**
- Daily reconciliation delta > $1 → P-09.
- Monthly P&L variance > 25% vs trailing-3-month average on any line → P-09 with diff.
- Operating balance projected to fall below reserve floor in next 30 days → P-09 (cash-call needed).
- Any vendor invoice > $500 without matching WO → P-09 (possible fraud / unrecorded work).

---

## P-06 — Owner daily digest

**Trigger.** Cron daily at 07:00 local tz. Composed by `property-manager` persona.

**Inputs.** Last 24 hours from `ucpm.audit_log`, `ucpm.work_orders`, `ucpm.ledger`, `ucpm.comms`, `outbox/pending_approval/`, `ucpm.transactions_unmatched`, plus 30-day forward look at lease lifecycle (P-07).

**Decision criteria — sections, in this order:**

1. **Action required from operator** — every item in `outbox/pending_approval/` plus every escalation from yesterday in P-09 holding state. Items sorted by gate severity: emergency dispatch > spend > $500 > legal > lease-change > novel > delinquency > all other drafts. Each item has a single click-equivalent: approve / edit / reject.
2. **Move-ins / move-outs (next 30 days)** — from P-07.
3. **Maintenance status** — counts by status, list of any WO open > 14 days, list of any urgency=emergency from yesterday.
4. **Financials** — yesterday's collections, MTD collections vs MTD expected, current AR aging buckets, operating balance, projected distribution this month.
5. **Vendor / SLA flags** — any vendor with new SLA miss, any vendor approaching COI/W-9 expiry within 30 days, any vendor suspended.
6. **Lease awareness** — any lease ending in next 90 days, any tenant who has communicated intent (P-01 `intent=lease_change` or `notice_required` in last 30 days).
7. **Anomalies** — any digest-level alert from any procedure (variance, unmatched payment, novel comm).

**Tone.** Direct, scannable, no hedging. Bullets and tables, not paragraphs. Lead with what the operator must decide today; everything else is supporting context.

**Decision criteria — escalation inside the digest itself.** Any of these items, if present, render at the top of section 1 with a red badge and a "needs decision today" tag:

- Spend gate request > $500.
- Any legal-gate or lease-change-gate item more than 24h old.
- Any unmatched payment more than 7 days old.
- Cash-call alert.
- Any emergency-tier WO from previous day not closed.

**Action.** Digest written to `outbox/owner_digest/<property_id>/<YYYY-MM-DD>.md`, delivered to operator via configured channel (email + dashboard).

**Output / log.** `ucpm.owner_digests` row, `ucpm.audit_log` entry.

**Escalation.** Digest itself is the escalation surface; if digest generation fails (template error, query failure) → P-09 with operator paged out-of-band.

---

## P-07 — Lease lifecycle awareness (read-only)

**Trigger.** Cron daily at 02:00 local tz, plus on any P-01 comm with `intent ∈ {lease_change, notice_required}`.

**Inputs.** `ucpm.leases` filtered by `property_id` and `status=active`.

**Decision criteria.**

- For each active lease, compute `days_to_end`.
- Bucket: `T-90`, `T-60`, `T-30`, `T-14`, `T-0`, `expired`.
- For each bucket transition since last run → emit alert.
- If tenant has communicated intent (P-01) → mark lease `tenant_signal_received=true`, surface alongside countdown.
- If lease has auto-renewal clause and `T-30` reached and no tenant intent → alert "auto-renewal will trigger; confirm or override".

**Action.** Write `ucpm.lease_alerts` row. Surface in P-06 digest section 6. **Do not draft renewal terms, do not contact tenant.** v1 is read-only awareness.

**Output / log.** `ucpm.lease_alerts`, audit_log entry.

**Escalation.** Every alert flows into the digest. Any tenant intent + lease change request → P-09 (lease-change gate). Auto-renewal trigger reached without operator decision → P-09.

---

## P-08 — Vendor lifecycle

**Trigger.**
- Inbound: vendor onboarding email matching subject patterns (`onboard`, `W-9`, `COI`, `rate sheet`), or operator-initiated invitation.
- Cron weekly (Mon 05:00) — performance + document expiry sweep.
- P-02/P-03 events — performance signal (SLA miss, callback, dispute).

**Inputs.** `ucpm.vendors`, `ucpm-docs/<property_id>/vendors/<vendor_id>/`, last 90 days of `ucpm.work_orders` per vendor.

**Decision criteria.**

- **Onboarding.** A vendor is `status=active` only when all of: W-9 on file (legible PDF, TIN format-valid), COI on file (valid through ≥ 30 days from today, names property entity as additional insured, GL ≥ lease minimum or $1M default, WC if state-required), rate sheet on file, trade tags assigned. Any missing item → `status=pending_docs`, draft request email queued.
- **Performance.** Compute per vendor over trailing 90 days: SLA hit rate (acknowledge within tier), completion rate, callback rate (same WO re-opened within 30 days), invoice-accuracy rate (invoice ≤ estimate + 10%).
- **Suspension rules** (any one triggers `status=suspended`, vendor not selected in P-02 until reinstated):
  - SLA hit rate < 80% on ≥ 5 WOs in 90 days.
  - Callback rate > 20% on ≥ 5 WOs in 90 days.
  - Two consecutive invoice disputes in 90 days.
  - COI lapsed and not cured within 7 days of expiry.
  - Any safety incident reported.
- **Document expiry.** COI expiry < 60 days → draft renewal request, queue. < 30 days → escalate to digest. < 0 (lapsed) → set `status=suspended`, P-09.

**Action.** Vendor row updates, draft document-request emails, suspension state transitions, removal from P-02 selection pool.

**Output / log.** `ucpm.vendors`, `ucpm.audit_log`, draft files.

**Escalation.**
- Suspension during an open WO → P-09 immediately (need to re-dispatch live work).
- Safety incident → P-09 immediately + legal gate.
- No vendor available for a trade after suspension → P-09 (gap in vendor pool).

---

## P-09 — Default escalation

**Trigger.** Any procedure step that bails per its own escalation rule, OR any inbound event that does not match a procedure trigger, OR any gate (spend, legal, lease, novel) tripped.

**Inputs.** Whatever the bailing step holds, gathered into a structured ticket.

**Decision criteria.** None — this procedure does not decide; it packages and pauses.

**Action — every escalation produces this exact bundle:**

```
escalation_id: <uuid>
created_at: <iso8601>
property_id: <id>
source_procedure: <P-NN>
source_step: <step name>
gate_tripped: <spend | legal | lease | novel | sla | cash | safety | reconcile | other>
event_payload: <full original event, attachments by ref>
state_snapshot:
  related_work_orders: [...]
  related_ledger_rows: [...]
  related_comms_thread: <thread_id or null>
  related_lease: <lease_id or null>
  related_vendor: <vendor_id or null>
proposed_action: <agent's best-guess proposal, or "none — needs operator judgment">
options_considered: [...]
hold_state: agent will not act on the underlying matter until escalation_id is resolved
operator_notification:
  channel: digest (always) + push (if gate in {spend, legal, safety, emergency, cash})
  age_at_notification: <seconds>
```

- Bundle written to `outbox/pending_approval/<property_id>/<escalation_id>.yml`.
- The originating procedure step writes its `ucpm.audit_log` row with `escalated_bool=true` and `output_ref=<escalation_id>`, then exits without further action on this matter.
- Any subsequent event on the same matter (new comm, new vendor reply, etc.) **appends** to the same escalation bundle rather than starting a new one (correlated by `thread_id` + `procedure_id` + `subject_match`).
- Operator response in the digest UI sets `operator_review_state ∈ {approved, edited, rejected, deferred}`; on `approved` or `edited` the originating procedure resumes from the held step with the operator's decision as input.

**Output / log.** Escalation bundle file, `ucpm.audit_log` entries, owner digest insertion.

**Escalation.** P-09 is the terminal procedure; it does not escalate further. If operator does not respond within 48h on a non-emergency or 1h on an emergency item, the next digest re-surfaces it at the top of section 1 with an `aging` flag. No autonomous action is taken in the absence of operator response.

---

## Appendix A — Pre-approved auto-send classes (the only outbound that bypasses draft queue)

1. Maintenance acknowledgement (P-02, fixed template, includes WO id and response window).
2. Vendor dispatch (P-02, fixed template, includes WO id, scope, cap, urgency, contact).
3. Rent invoice (P-04, fixed template, scheduled day −5).
4. Payment receipt (P-04, fixed template, on auto-matched payment ≥ 0.95 confidence).
5. Maintenance scheduled-notification (P-03, fixed template, on vendor scheduling).
6. Maintenance completion satisfaction prompt (P-03, fixed template, 24h post-completion).
7. Vendor SLA-ping (P-03, fixed template, internal-tone vendor reminder).

Anything not in this list is drafted and queued.

## Appendix B — Templates

Templates live at `companies/ucpm-default/templates/<template_id>.md` (to be added in v1.1; v1 ships with English-only, US-default placeholders inline in the procedure descriptions above). Per-property companies may override any template by placing a same-named file in `companies/<property_id>/templates/`.

## Appendix C — Override semantics

Per-property companies inherit this SOP unmodified. To override, place a file at `companies/<property_id>/SOP.overrides.yml` listing procedures and values to replace, e.g.:

```yaml
overrides:
  P-04:
    grace_period_days: 3
    late_fee_rule: { type: percent, value: 0.05, cap_usd: 75 }
  P-08:
    coi_min_gl_usd: 2000000
```

Override loading is done by the runtime, not by this SOP. Anything not overridden is inherited verbatim. Procedures themselves cannot be deleted by override; they can only have parameters replaced.
