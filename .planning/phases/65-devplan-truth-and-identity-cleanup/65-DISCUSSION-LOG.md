# Phase 65: DevPlan Truth and Identity Cleanup - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-05-01
**Phase:** 65-devplan-truth-and-identity-cleanup
**Mode:** auto
**Areas discussed:** DevPlan Alignment Matrix, Completion Claim Evidence Rule, Product-Facing Identity Scan, Compatibility Naming Boundary, Verification And Handoff

---

## DevPlan Alignment Matrix

| Option | Description | Selected |
|--------|-------------|----------|
| Evidence-backed matrix | Create a conservative row-level matrix with status, requirement IDs, evidence paths, gaps, and owner phases. | yes |
| Prose-only audit update | Update `.planning/DEVPLAN-ALIGNMENT.md` narrative without a machine-readable contract. | |
| UI-only cleanup | Fix only `PlanAlignmentPage.tsx` labels and leave planning evidence as-is. | |

**Auto-selected choice:** Evidence-backed matrix.
**Notes:** Phase 65 starts from the current 64% v3.1 baseline. Older 94% text is historical and must be recalculated before reuse.

---

## Completion Claim Evidence Rule

| Option | Description | Selected |
|--------|-------------|----------|
| Complete requires evidence | `complete` is allowed only when code, route/schema, UI, test, generated evidence, validation, or verification anchors exist. | yes |
| Planning text is enough | Requirements can be marked complete when planning docs say a prior phase shipped. | |
| Human judgment only | Let milestone authors decide status without stable rule or blocker codes. | |

**Auto-selected choice:** Complete requires evidence.
**Notes:** Engine parity claims need stronger source-specific evidence. Multica/wikiLLM/Graphify inspired concepts are not the same as reference-engine parity.

---

## Product-Facing Identity Scan

| Option | Description | Selected |
|--------|-------------|----------|
| Extend focused identity gate | Expand `scripts/rt2-identity-gate.mjs` to classify UI, app metadata, product docs, operator docs, and server-facing operator copy. | yes |
| Whole-repo ban | Fail every Paperclip/Paper Company/Multica occurrence anywhere in the repo. | |
| Manual rg only | Keep identity verification as ad hoc search commands. | |

**Auto-selected choice:** Extend focused identity gate.
**Notes:** The current gate already has the right low-noise pattern. Phase 65 should add target classes and tests, not ban internal compatibility identifiers.

---

## Compatibility Naming Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Document compatibility layer | Keep `@paperclipai/*`, `PAPERCLIP_*`, CLI compatibility, adapter, MCP, and internal names where appropriate, but document the boundary. | yes |
| Rename all internals | Attempt a full package/env/API rename away from Paperclip. | |
| Ignore remaining names | Leave product and compatibility naming ambiguous. | |

**Auto-selected choice:** Document compatibility layer.
**Notes:** Product-facing identity is RealTycoon2. Paperclip remains the inherited control-plane/runtime compatibility layer.

---

## Verification And Handoff

| Option | Description | Selected |
|--------|-------------|----------|
| Focused gates plus typecheck | Verify the alignment gate, identity gate, and typecheck; attempt broad tests only if practical. | yes |
| E2E by default | Run `pnpm test:e2e` as the default Phase 65 gate. | |
| Planning-only closure | Update planning docs without executable verification. | |

**Auto-selected choice:** Focused gates plus typecheck.
**Notes:** `pnpm test:e2e` remains separate. Broad `pnpm test` timeout debt must be recorded honestly if encountered.

---

## the agent's Discretion

- Exact score formula and weights.
- Exact generated matrix file names and report table layout.
- Whether `PlanAlignmentPage.tsx` consumes generated static data or receives a conservative embedded update.
- Exact identity gate allowlist structure.

## Deferred Ideas

- Daily cockpit, Multica runtime, wikiLLM living memory, Graphify v3 sidecar, economy loop, and final score delta remain Phase 66-71.
- Full internal package rename away from `@paperclipai/*` remains future scope.
