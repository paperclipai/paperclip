# Phase 62: Resident Tray and Global Shortcut - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 62-resident-tray-and-global-shortcut
**Areas discussed:** Implementation depth, Tray and menubar status contract, Global shortcut lifecycle, Capture handoff and approval boundary, Operator evidence and blockers, Documentation and downstream gate integration

---

## Implementation Depth

| Option | Description | Selected |
|--------|-------------|----------|
| Evidence-first resident surface gate | Follow Phase 60/61 and validate tray/shortcut readiness through a deterministic manifest gate before adding native dependencies. | ✓ |
| Full Tauri desktop scaffold now | Add `apps/desktop`, Tauri plugins, Cargo files, and native wiring in this phase. | |
| Documentation only | Describe tray/shortcut behavior without executable evidence. | |

**User's choice:** `[auto] Evidence-first resident surface gate`
**Notes:** Prior phases intentionally kept native distribution work dependency-light. The repo has no Tauri scaffold yet, and Phase 61 explicitly says Phase 62 can use installed channel/build identity and update state without broad native dependency churn.

---

## Tray And Menubar Status Contract

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse Phase 61 installed/update state | Tray status surfaces quick capture, queue, auth/company, build identity, release channel, update state, and failure reason using Phase 61 vocabulary. | ✓ |
| Define a separate tray state model | Create a new independent status vocabulary for tray behavior. | |
| Show only quick capture availability | Keep tray evidence minimal and ignore build/channel/update state. | |

**User's choice:** `[auto] Reuse Phase 61 installed/update state`
**Notes:** RES-01 explicitly requires build identity and release channel. Phase 61 already created the installed/update state contract.

---

## Global Shortcut Lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| Fail-closed registration evidence | Track accelerator, platform, registration, conflict, permission, focus, privacy, unregister, and change state with stable blockers. | ✓ |
| Treat registration as a boolean | Only record whether a shortcut is registered. | |
| Let native plugin errors pass through raw | Defer conflict and permission interpretation to native logs only. | |

**User's choice:** `[auto] Fail-closed registration evidence`
**Notes:** RES-02 requires conflict, permission, focus, and privacy state. Raw native errors are not enough for an operator-readable release gate.

---

## Capture Handoff And Approval Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Route through existing persistent draft review | Tray/shortcut capture uses source `native`, entry-specific channels, existing inbound draft API, and never promotes directly. | ✓ |
| Create a separate native capture store | Add a new native-specific queue and review model. | |
| Allow shortcut to create tasks directly | Convert capture text into tasks without board review. | |

**User's choice:** `[auto] Route through existing persistent draft review`
**Notes:** RES-03 and Phase 59 require native capture to enter persistent drafts and board review only. Existing quick-capture queue and inbound draft route are already suitable integration points.

---

## Operator Evidence And Blockers

| Option | Description | Selected |
|--------|-------------|----------|
| Add resident surface gate with blocker report | Create `rt2-resident-surface-gate` script/test, output `summary.json` and `report.md`, and fail closed on missing tray/shortcut/capture/privacy evidence. | ✓ |
| Fold into release channel gate | Extend Phase 61 updater/channel gate with tray/shortcut checks. | |
| Leave evidence to manual QA | Document manual tray/shortcut checks without machine-readable output. | |

**User's choice:** `[auto] Add resident surface gate with blocker report`
**Notes:** Separate gate keeps Phase 62 consumable by Phase 64 and avoids overloading the updater/channel validator.

---

## Documentation And Downstream Gate Integration

| Option | Description | Selected |
|--------|-------------|----------|
| Update native foundation and release-host docs | Add Phase 62 manifest/runbook and keep Phase 64 able to consume the summary. | ✓ |
| Add only planning artifacts | Leave operator docs unchanged. | |
| Update runtime confidence now as required | Force runtime confidence aggregation into Phase 62. | |

**User's choice:** `[auto] Update native foundation and release-host docs`
**Notes:** Runtime confidence aggregation can be implemented if small, but Phase 64 is the natural all-up distribution gate owner.

---

## the agent's Discretion

- Exact manifest field names, report table layout, and blocker code names.
- Whether the resident surface gate manifest uses one combined `tray` and `shortcut` object or separate files.
- Whether runtime-confidence aggregation is updated now or deferred to Phase 64, provided Phase 62 writes a stable summary.

## Deferred Ideas

- Full `apps/desktop` Tauri scaffold unless planning proves it is narrowly required.
- Mobile/Web Push/APNs loop for Phase 63.
- Final all-up distribution gate for Phase 64.
- Public store listing, marketplace, federation, and autonomous apply behavior outside v3.0 distribution readiness.
