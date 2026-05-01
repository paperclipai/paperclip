# Phase 65: DevPlan Truth and Identity Cleanup - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 65 starts v3.1 DevPlan Core Convergence by turning the current "about 64%" RealTycoon2 development-plan baseline into an evidence-backed truth matrix, and by tightening product-facing identity cleanup. The phase owns DevPlan chapter/axis status, evidence anchors for completion claims, regression scanning for product-facing Paperclip/Paper Company residue, and documentation of remaining `@paperclipai/*` / `PAPERCLIP_*` compatibility naming.

This phase must not implement the Phase 66 daily cockpit, Phase 67 Multica runtime lifecycle, Phase 68 wikiLLM export/update workflow, Phase 69 Graphify v3 corpus graph sidecar, Phase 70 economy loop, or Phase 71 final v3.1 acceptance score delta. It may create or update alignment artifacts, gate scripts, focused tests, product-facing copy/docs, and narrow planning truth needed to stop overstated completion claims.

</domain>

<decisions>
## Implementation Decisions

### DevPlan Alignment Matrix
- **D-01:** Build Phase 65 around an explicit DevPlan alignment matrix, not a broad prose-only audit. Each row should map a DevPlan chapter or core axis to status, requirement IDs, owning phase(s), evidence anchors, remaining gap, and whether the claim is user-visible product, engine/runtime, docs, or validation-only.
- **D-02:** Use a conservative status vocabulary: `complete`, `partial`, `missing`, `tech_debt`, and `deferred`. Do not keep using optimistic labels such as `shipped` or `validated` unless the row has concrete evidence anchors.
- **D-03:** Treat the current 64% baseline in `.planning/STATE.md`, `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `.planning/MILESTONES.md` as the starting truth. Do not resurrect the older `.planning/DEVPLAN-ALIGNMENT.md` 94% claim without recalculating it against current v3.1 evidence.
- **D-04:** Prefer a machine-readable summary plus human report pattern for the new matrix, following existing gate scripts. A likely shape is `scripts/rt2-devplan-alignment-gate.mjs` writing `.planning/devplan-alignment-runs/<timestamp>/summary.json` and `report.md`, with `.planning/DEVPLAN-ALIGNMENT.md` updated as the human baseline or index.
- **D-05:** `ui/src/pages/rt2/PlanAlignmentPage.tsx` should stop presenting stale hardcoded "development-plan reflection" claims if they conflict with the new evidence matrix. Either update it from the new matrix data or narrow its copy so it clearly reflects current v3.1 truth.

### Completion Claim Evidence Rule
- **D-06:** A row may be `complete` only when it links at least one concrete evidence anchor: code path, route/schema, UI surface, focused test, generated evidence summary, validation artifact, or verification artifact. Rows without evidence are `partial`, `missing`, or `tech_debt`.
- **D-07:** Engine parity claims need stronger evidence than product-concept presence. Multica, wikiLLM, and Graphify rows should distinguish "RT2-inspired product projection exists" from "reference engine parity exists." `ENGINE-REFERENCE-AUDIT.md` is the canonical boundary for this.
- **D-08:** Evidence anchors must be file paths and, where useful, commands. Avoid claims like "implemented in prior milestone" unless the row points to source, tests, summaries, or generated evidence that downstream agents can inspect.
- **D-09:** Phase 65 may define score calculation and baseline rows, but Phase 71 owns the final v3.1 acceptance gate and score delta after Phases 66-70 complete.

### Product-Facing Identity Scan
- **D-10:** Extend the existing focused identity gate rather than creating a repo-wide ban. Product-facing UI, app metadata, product docs, operator docs, and server-facing operator copy are in scope; package names, imports, adapter internals, MCP/server implementation names, developer-only docs, tests with explicit fixtures, and env var identifiers are allowed compatibility/internal surfaces.
- **D-11:** The identity scan should classify findings by surface and reason, such as `ui_product_copy`, `app_metadata`, `product_doc`, `operator_doc`, and `server_operator_copy`. Findings should print file, line, token, category, and remediation guidance.
- **D-12:** Product-facing forbidden tokens include visible `Paperclip`, `Paper Company`, and legacy English default copy where the operator should see RealTycoon2-first Korean UX. `Multica` is allowed only when a page or document explicitly describes engine reference or compatibility boundaries.
- **D-13:** Keep `scripts/check-forbidden-tokens.mjs` separate. It is a sensitive-token scanner, not an identity regression gate.

### Compatibility Naming Boundary
- **D-14:** Do not rename internal packages, env vars, CLI compatibility entry points, or adapter/MCP types just to satisfy product identity. `@paperclipai/*`, `PAPERCLIP_*`, `paperclipai`, and related source identifiers may remain when they are compatibility, infrastructure, or developer-facing.
- **D-15:** Document the compatibility boundary explicitly in product/developer docs so downstream phases do not treat every Paperclip string as a bug. The doc should explain that RealTycoon2 is the product identity and Paperclip is the inherited control-plane/runtime layer.
- **D-16:** Product-facing docs such as `doc/PRODUCT.md` and `doc/SPEC.md` currently open with Paperclip-first language. Phase 65 should either update them to RealTycoon2-first framing or clearly split "RealTycoon2 product" from "Paperclip control-plane compatibility reference."

### Verification And Handoff
- **D-17:** Add focused tests for any new alignment gate and identity gate expansion. Default verification should include the new gate test, `pnpm run test:identity-gate`, `pnpm run rt2:identity-gate`, and `pnpm typecheck`.
- **D-18:** Do not run `pnpm test:e2e` as a default Phase 65 check. Broad `pnpm test` may be attempted if practical, but Windows broad-suite timeout debt must be recorded honestly rather than converted into a hidden pass.
- **D-19:** Phase 65 should create normal planning closure artifacts after implementation: `65-VALIDATION.md`, `65-VERIFICATION.md`, and `65-01-SUMMARY.md`. These artifacts become key inputs for Phase 71.
- **D-20:** Reconcile `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/PROJECT.md`, and `.planning/MILESTONES.md` only after the matrix, identity scan, and focused verification evidence pass.

### the agent's Discretion
- Exact score formula and weights, provided unsupported `complete` claims are impossible and the 64% baseline remains conservative.
- Exact output filenames for the alignment run, provided downstream agents can find machine-readable `summary.json` plus a human `report.md`.
- Whether `PlanAlignmentPage.tsx` reads generated static data or is updated with a conservative embedded matrix in this phase, based on blast radius and existing frontend patterns.
- Exact identity gate allowlist implementation, provided it is explicit, test-covered, and does not weaken product-facing detection.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `AGENTS.md` - Korean-first workflow, RealTycoon2 terminology, verification command policy, and lockfile policy.
- `.planning/PROJECT.md` - v3.1 product context, 64% baseline, RealTycoon2-first identity rule, and compatibility-layer decisions.
- `.planning/REQUIREMENTS.md` - `ALIGN-01`, `ALIGN-02`, `ALIGN-03`, `IDENTITY-01`, `IDENTITY-02`, and `IDENTITY-03`.
- `.planning/ROADMAP.md` - Phase 65 goal, success criteria, v3.1 dependency chain, and fixed phase boundary.
- `.planning/STATE.md` - Current v3.1 starting point and 64% baseline statement.
- `.planning/MILESTONES.md` - Active v3.1 milestone scope and planned Phase 65-71 sequence.

### DevPlan And Engine Evidence
- `.planning/DEVPLAN-ALIGNMENT.md` - Older DevPlan alignment artifact; use as historical input only and correct stale 94% claims against current v3.1 evidence.
- `.planning/research/ENGINE-REFERENCE-AUDIT.md` - Canonical Multica and Graphify v3 reference boundary; must guide engine parity status.
- `.planning/research/ARCHITECTURE.md` - Project research architecture context for RT2 knowledge/economy/runtime alignment.
- `.planning/research/FEATURES.md` - Project research feature inventory that may inform DevPlan axis grouping.

### Prior Identity Decisions
- `.planning/phases/48-rt2-identity-and-korean-shell/48-CONTEXT.md` - Locked RealTycoon2-first Korean shell and product-facing/internal naming boundary.
- `.planning/phases/48-rt2-identity-and-korean-shell/48-VERIFICATION.md` - Prior focused identity evidence for shell surfaces.
- `.planning/phases/52-supporting-surfaces-and-identity-regression-gate/52-CONTEXT.md` - Existing identity gate decisions, product-facing scan scope, and allowed internal boundaries.
- `.planning/phases/52-supporting-surfaces-and-identity-regression-gate/52-01-SUMMARY.md` - Implementation summary for the current identity gate.
- `.planning/phases/55-native-and-mobile-quick-capture-entry/55-CONTEXT.md` - PWA/install metadata identity gate expansion and verification bundle.

### Existing Code And Gate Patterns
- `scripts/rt2-identity-gate.mjs` - Current focused RealTycoon2 identity regression scanner to extend.
- `scripts/rt2-identity-gate.test.mjs` - Current script-level identity gate tests.
- `scripts/rt2-milestone-artifact-gate.mjs` - Existing planning-artifact gate pattern and traceability checks.
- `scripts/rt2-runtime-confidence.mjs` - Existing generated evidence summary/report pattern and requirement evidence mapping.
- `scripts/rt2-distribution-gate.mjs` - Current final-gate pattern for manifest validation, stable blocker codes, `summary.json`, and `report.md`.
- `package.json` - Existing `rt2:*` and `test:*` scripts, workspace commands, and lockfile implications.
- `ui/src/pages/rt2/PlanAlignmentPage.tsx` - Existing product-facing development-plan alignment page with stale hardcoded statuses to reconcile.

### Product And Compatibility Docs
- `doc/PRODUCT.md` - Paperclip-first product definition that may need RealTycoon2-first framing or compatibility annotation.
- `doc/SPEC.md` - Paperclip control-plane technical spec that should be classified as compatibility/reference where product-facing identity matters.
- `doc/DEVELOPING.md` - Developer setup and command reference; useful for verification and compatibility naming context.
- `doc/DATABASE.md` - Schema guidance if the plan chooses to persist alignment rows rather than only generating evidence artifacts.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/rt2-identity-gate.mjs` already collects focused product-facing files, scans forbidden visible identity tokens, prints category/file/line/token/guidance, and has direct Node tests.
- `scripts/rt2-milestone-artifact-gate.mjs`, `scripts/rt2-runtime-confidence.mjs`, and `scripts/rt2-distribution-gate.mjs` provide the established pattern for deterministic repo-local gates, stable blocker codes, machine-readable summaries, human reports, and focused tests.
- `package.json` already exposes `rt2:identity-gate`, `test:identity-gate`, `rt2:runtime-confidence`, `test:runtime-confidence`, `rt2:distribution-gate`, and related focused scripts.
- `ui/src/pages/rt2/PlanAlignmentPage.tsx` already gives operators a visible development-plan alignment surface, but its current hardcoded rows and labels reflect older milestone assumptions.
- `.planning/DEVPLAN-ALIGNMENT.md` contains a detailed historical matrix and evidence list that can seed the v3.1 matrix, but its older 94% assessment must not be treated as current truth.

### Established Patterns
- Product-facing identity is RealTycoon2-first and Korean-first; internal package names, route segments, compatibility APIs, and developer/runtime references can remain Paperclip-oriented.
- Evidence gates in this repo are dependency-light, deterministic, and write timestamped summaries/reports under `.planning/*-runs/<timestamp>/`.
- Previous phases prefer focused script/component tests plus `pnpm typecheck` on this Windows host; `pnpm test:e2e` is separate.
- Completion truth is recorded in planning docs only after focused evidence passes. Planning doc edits are part of closure evidence, not substitutes for implementation or verification.
- Engine reference claims must distinguish RT2 product graph/runtime concepts from upstream Multica or Graphify parity.

### Integration Points
- Extend `scripts/rt2-identity-gate.mjs` with target classes for docs and server-facing operator copy, and update `scripts/rt2-identity-gate.test.mjs`.
- Add a new DevPlan alignment gate script and test if planning confirms this is the smallest reliable way to satisfy `ALIGN-01..03`.
- Update `ui/src/pages/rt2/PlanAlignmentPage.tsx` or its data source so the app no longer shows stale DevPlan truth.
- Update `doc/PRODUCT.md`, `doc/SPEC.md`, or a new compatibility note to explain RealTycoon2 product identity vs Paperclip control-plane naming.
- Create Phase 65 validation, verification, and summary artifacts after implementation and verification.
- Reconcile `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/PROJECT.md`, and `.planning/MILESTONES.md` after evidence passes.

</code_context>

<specifics>
## Specific Ideas

- A useful alignment row shape: `axis`, `devPlanExpectation`, `status`, `confidence`, `requirements`, `evidence[]`, `gaps[]`, `ownerPhase`, `claimAllowed`.
- Recommended complete-claim rule: `complete` requires at least one evidence item and no blocker gap; engine parity rows require reference-specific evidence from `ENGINE-REFERENCE-AUDIT.md`.
- Good stable blocker codes include `DEVPLAN_EVIDENCE_MISSING`, `DEVPLAN_COMPLETE_WITHOUT_EVIDENCE`, `DEVPLAN_ENGINE_PARITY_OVERCLAIM`, `IDENTITY_PRODUCT_COPY_LEGACY`, `IDENTITY_DOC_LEGACY`, `IDENTITY_SERVER_COPY_LEGACY`, and `COMPATIBILITY_BOUNDARY_MISSING`.
- The new matrix should make "RT2 has product graph projection" and "RT2 has Graphify v3 corpus graph sidecar parity" separate rows so Phase 69 has a clean target.
- For identity cleanup, a finding in `packages/mcp-server` or `@paperclipai/*` imports is likely internal compatibility; a finding in visible UI copy, app metadata, product docs, or operator-facing route text is likely a Phase 65 issue.

</specifics>

<deferred>
## Deferred Ideas

- Phase 66 owns the actual daily cockpit convergence and should consume the corrected Phase 65 identity/matrix baseline.
- Phase 67 owns Multica runtime queue/heartbeat/cancellation implementation.
- Phase 68 owns wikiLLM living memory export/update/citation workflow.
- Phase 69 owns Graphify v3 corpus graph sidecar implementation.
- Phase 70 owns Marketplace, P&L, amoeba economy, and CareerMate product loop.
- Phase 71 owns the final v3.1 score delta audit and acceptance gate.
- Full internal package rename away from `@paperclipai/*` remains out of scope unless a future compatibility-breaking milestone explicitly chooses it.

</deferred>

---

*Phase: 65-devplan-truth-and-identity-cleanup*
*Context gathered: 2026-05-01*
