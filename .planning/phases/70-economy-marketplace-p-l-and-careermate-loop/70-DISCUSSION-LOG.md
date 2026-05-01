# Phase 70: Economy, Marketplace, P&L, and CareerMate Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-01T15:08:12+09:00
**Phase:** 70-economy-marketplace-p-l-and-careermate-loop
**Areas discussed:** Primary navigation and cockpit entry, Economy source of truth and rollups, Marketplace evidence and pricing boundary, CareerMate/avatar/reputation progression, Governance and verification
**Mode:** `--auto`

---

## Primary Navigation And Cockpit Entry

| Option | Description | Selected |
|--------|-------------|----------|
| Connect existing routes and daily cockpit | Keep P&L/Marketplace as first-class routes and add compact economy evidence/deep links to the Phase 66 cockpit. | yes |
| New standalone economy dashboard | Create a separate economy hub parallel to Daily Work, P&L, and Marketplace. | |
| Planning discretion only | Leave exact product entry points unspecified until implementation. | |

**User's choice:** `[auto]` Selected existing routes plus daily cockpit integration.
**Notes:** Phase 66 locked `DailyWorkPage`/`Rt2DailyBoard` as the first operating surface, and Phase 70 depends on that cockpit.

---

## Economy Source Of Truth And Rollups

| Option | Description | Selected |
|--------|-------------|----------|
| Settlement plus atomic ledger evidence | Derive P&L and amoeba rollups from approved/rejected settlements, quality rows, ledger entries, deliverables, and task participants. | yes |
| Manual P&L rows as source | Treat manual income/expense endpoints as the primary proof. | |
| New economy schema | Create a new amoeba accounting model before reusing existing P&L/settlement assets. | |

**User's choice:** `[auto]` Selected settlement plus atomic ledger evidence.
**Notes:** Phase 7, 22, and 27 already locked ledger-backed economy and settlement governance as the trustworthy path.

---

## Marketplace Evidence And Pricing Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Trusted marketplace with live evidence | Keep company-scoped marketplace and strengthen listing quality with deliverable, quality, settlement, gold, reputation, and usage evidence. | yes |
| Public marketplace launch | Expand into public/open company marketplace and payment operations. | |
| Catalog-only marketplace | Keep listings mostly descriptive, with limited evidence. | |

**User's choice:** `[auto]` Selected trusted marketplace with live evidence.
**Notes:** Public/open marketplace and real billing are repeatedly deferred in PROJECT/REQUIREMENTS/STATE.

---

## CareerMate, Avatar, And Reputation Progression

| Option | Description | Selected |
|--------|-------------|----------|
| Derived progression from ledger and quality evidence | Compute level/tier/avatar/reputation from approved deliverables, quality, settlement, ledger, XP, achievements, and reputation rows. | yes |
| Manual profile stats | Continue relying on editable CareerMate profile stats and placeholder averages. | |
| Gamification-only progression | Use XP/achievement state without connecting settlement/ledger/quality evidence. | |

**User's choice:** `[auto]` Selected derived progression from ledger and quality evidence.
**Notes:** `ECON-03` explicitly says CareerMate/avatar/reputation progression must not be placeholder-only.

---

## Governance And Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Evidence gate with focused tests | Update DevPlan gate only after navigation, rollups, marketplace evidence, CareerMate progression, and focused tests exist. | yes |
| Completion by UI copy | Mark economy complete once labels and pages exist. | |
| Full e2e as default | Require Playwright e2e as the normal Phase 70 gate. | |

**User's choice:** `[auto]` Selected evidence gate with focused tests.
**Notes:** The repo default remains `pnpm typecheck && pnpm test`; `pnpm test:e2e` is not the default gate.

---

## the agent's Discretion

- Exact route additions and response field names.
- Exact UI placement for compact economy evidence inside `Rt2DailyBoard`.
- Exact deterministic formula for CareerMate level/tier/reputation, as long as tests prove it is evidence-backed.
- Whether project-level amoeba rollup lives in `rt2PersonalPnLService` or a small dedicated economy loop service.

## Deferred Ideas

- Public/open marketplace launch.
- Real billing, payroll export, and external payment settlement.
- Automatic penalty, reputation demotion, and fraud case workflow.
- Native/mobile-specific economy surfaces beyond links to existing web surfaces.
