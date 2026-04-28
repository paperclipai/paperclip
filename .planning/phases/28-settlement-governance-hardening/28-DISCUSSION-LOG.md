# Phase 28: Settlement Governance Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-28T00:00:00+09:00
**Phase:** 28-settlement-governance-hardening
**Areas discussed:** Double materialization guard, Ledger evidence on approval, Anti-gaming signals, Company threshold settings

---

## Double Materialization Guard

| Option | Description | Selected |
|--------|-------------|----------|
| Database unique constraint | Enforce `(company_id, work_product_id)` uniqueness and make service writes conflict-safe. | yes |
| Service-only existence check | Keep current pre-insert lookup without database enforcement. | |
| Broader owner-scoped uniqueness | Allow one settlement per owner/work product pair. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Roadmap and `SETTLE-01` explicitly require `(companyId, workProductId)` uniqueness, so the database constraint is locked.

---

## Ledger Evidence on Approval

| Option | Description | Selected |
|--------|-------------|----------|
| Inline ledger evidence | Return and display ledger amount, transaction type, period, and `balanceAfter` on each settlement card. | yes |
| Drilldown-only evidence | Require the operator to inspect actor ledger drilldown separately. | |
| ID-only evidence | Show only `ledgerEntryId`. | |

**User's choice:** Auto-selected recommended default.
**Notes:** `SETTLE-03` requires settlement approval to show linked ledger entry and `balanceAfter`; inline evidence is the shortest operator path.

---

## Anti-Gaming Signals

| Option | Description | Selected |
|--------|-------------|----------|
| Keep three decision-support signals | Display `repeated_self_review`, `abnormal_gold_farming`, and `quality_score_bias` with evidence and severity. | yes |
| Add penalty automation | Trigger penalties/reputation changes from signals. | |
| Hide signals behind summary counts | Show only aggregate risk level. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Prior Phase 22 context says anti-gaming is decision support, not punishment automation.

---

## Company Threshold Settings

| Option | Description | Selected |
|--------|-------------|----------|
| Company-scoped threshold table plus P&L UI editor | Persist threshold settings per company and edit them inside the settlement governance section. | yes |
| Hardcoded thresholds only | Keep current service constants. | |
| Separate company settings page | Move all threshold configuration away from the settlement review surface. | |

**User's choice:** Auto-selected recommended default.
**Notes:** `SETTLE-04` requires configurable thresholds per company; the existing settlement section is already where approvers review signals.

---

## the agent's Discretion

- Exact migration filename and constraint/index names.
- Compact UI layout details for threshold editing.
- Whether threshold settings are returned in the settlement overview payload or fetched separately, as long as the UI can load and save them.

## Deferred Ideas

- Automatic penalty execution, reputation demotion, and appeal workflow.
- External HR/payroll export.
- Full fraud case workflow.
