# Phase 43: Validation Debt and Milestone Gate Closure - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 43 closes historical validation debt and adds a release-time milestone artifact gate so missing summaries, verification files, validation artifacts, requirement checkboxes, traceability, and summary frontmatter are detected before milestone close.

This phase is primarily evidence and guardrail work. It should not add new product behavior for connectors, native capture, Jarvis autonomy, knowledge search, or economy flows. It may add or update planning/validation artifacts, deterministic planning-health checks, and scripts/tests that verify planning artifact completeness.

</domain>

<decisions>
## Implementation Decisions

### Historical Validation Debt
- **D-01:** Treat Phase 19-24 strict `*-VALIDATION.md` debt as the main historical artifact closure target. Create or update validation artifacts for Phase 19, Phase 20, Phase 21, Phase 22, Phase 23, and Phase 24 using existing behavior, summaries, verification files, route tests, and audit records as evidence.
- **D-02:** Do not rewrite shipped v2.3 product behavior while closing validation debt. If evidence is insufficient for a phase, record `partial` or explicit residual risk in that phase's validation artifact instead of inventing coverage.
- **D-03:** Preserve `.planning/milestones/v2.3-MILESTONE-AUDIT.md` as the historical audit snapshot. Phase 43 should add closure evidence and, if needed, a new v2.6/v2.3 validation-debt closure note rather than editing the old audit result into something it was not at the time.

### Legacy UAT Unknowns
- **D-04:** Reclassify the two legacy UAT unknowns explicitly: `.planning/phases/01-rt2-shell-and-product-truth/01-UAT.md` is already checked and can be recorded as reverified/closed; `.planning/phases/m1-6-daily-report/m1-6-UAT.md` contains unchecked legacy scenario boxes and must be classified with evidence as future scope, obsolete, or superseded by later RT2 daily cockpit phases.
- **D-05:** Legacy UAT closure should produce a durable planning artifact or section that lists each UAT file, current checkbox state, downstream superseding evidence, final classification, and reason. Do not leave `unknown` as an unqualified status.
- **D-06:** If a legacy UAT scenario maps to current implemented RT2 behavior, cite current phase summaries/verification files and mark it reverified. If it represents old milestone scope that has been superseded, mark it obsolete or future scope with the replacement phase reference.

### Milestone Artifact Gate
- **D-07:** Add a deterministic milestone health gate that checks phase directories for required planning artifacts before release: `*-SUMMARY.md`, `*-VERIFICATION.md`, `*-VALIDATION.md`, requirement checkbox state, traceability rows, and YAML/frontmatter fields such as phase, plan, status, requirements addressed/completed, commits, and verification results.
- **D-08:** The gate should fail with explicit reason codes and file paths, not a generic failed status. It must identify exactly which phase or requirement is missing summary, verification, validation, checkbox, traceability, or frontmatter evidence.
- **D-09:** Prefer extending the existing GSD/planning tooling path under `C:\Users\고상진\.codex\get-shit-done\bin\gsd-tools.cjs` or adding a repo-local script that can be run deterministically from this repository. The implementation must not depend on live providers, external network, or long-running browser suites.
- **D-10:** The gate should be usable before milestone archive and as a focused verification command in Phase 43. It should complement, not replace, `pnpm typecheck` and `pnpm test`.

### v2.6 Traceability Closure
- **D-11:** Phase 43 should close `VAL-01`, `VAL-02`, and `VAL-03` in `.planning/REQUIREMENTS.md` only after validation debt artifacts, UAT classification, and milestone gate evidence exist.
- **D-12:** v2.6 milestone traceability should end at 12/12 with Phase 39-43 mapped and checked. If Phase 40-42 planning state drift remains in `.planning/ROADMAP.md` or `.planning/STATE.md`, update through safe tooling when available or document the drift explicitly in Phase 43 verification.
- **D-13:** Final verification target remains `pnpm typecheck && pnpm test`. Given recent Windows host behavior, targeted planning-gate tests may pass while full `pnpm test` times out; if that occurs, record the timeout as residual risk and include the strongest completed targeted command evidence.

### the agent's Discretion
- Exact artifact template wording and table structure for Phase 19-24 validation files.
- Whether the milestone gate is implemented as a GSD tool command, a repo-local Node script, or both, provided it is deterministic, path-specific, and covered by tests.
- Exact UAT classification labels, provided they distinguish reverified, future scope, obsolete, and superseded instead of preserving vague `unknown`.

</decisions>

<specifics>
## Specific Ideas

- Use Phase 38 as the closest precedent: close audit-listed blockers with verification/validation/frontmatter/requirements traceability artifacts without expanding product scope.
- Use Phase 24 as the v2.3 precedent: keep historical audit files as snapshots and add closure evidence separately.
- The milestone health gate should answer: "Can this milestone be archived without discovering missing artifact evidence after the fact?"
- The current local tooling note matters: the installed `gsd-sdk` does not expose the workflow-documented `query` subcommand, while `gsd-tools.cjs` exposes `verify-summary`, `frontmatter`, `verify phase-completeness`, `verify references`, and related primitives that can be reused or wrapped.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - RT2-first identity, v2.6 hardening goal, validation closure context, and deterministic local verification constraint.
- `.planning/REQUIREMENTS.md` - `VAL-01`, `VAL-02`, and `VAL-03` requirements and v2.6 traceability table.
- `.planning/ROADMAP.md` - Phase 43 goal and success criteria.
- `.planning/STATE.md` - Deferred validation debt and legacy UAT unknowns.
- `.planning/NEXT-SESSION.md` - Current handoff noting Phase 42 completion, Phase 43 start, full-suite timeout caveat, and `gsd-sdk query` tooling mismatch.

### Historical Audit And Closure Evidence
- `.planning/milestones/v2.3-MILESTONE-AUDIT.md` - Source of Phase 19-24 strict Nyquist validation debt.
- `.planning/phases/24-phase19-verification-artifact-closure/24-CONTEXT.md` - Prior v2.3 verification artifact closure decisions.
- `.planning/phases/24-phase19-verification-artifact-closure/24-VERIFICATION.md` - Prior closure evidence for Phase 19 verification blocker.
- `.planning/phases/38-semantic-knowledge-artifact-closure/38-CONTEXT.md` - Recent artifact closure pattern for missing verification, validation, summary frontmatter, and requirements traceability.
- `.planning/milestones/v2.5-MILESTONE-REAUDIT.md` - Example final passed audit after artifact closure.

### Phase 19-24 Evidence
- `.planning/phases/19-validation-and-route-test-hardening/19-01-SUMMARY.md` - Phase 19 delivered behavior and command evidence.
- `.planning/phases/19-validation-and-route-test-hardening/19-VERIFICATION.md` - Phase 19 requirement verification.
- `.planning/phases/20-enterprise-rollout-connectors/20-01-SUMMARY.md` - Phase 20 delivered behavior and command evidence.
- `.planning/phases/20-enterprise-rollout-connectors/20-VERIFICATION.md` - Phase 20 requirement verification.
- `.planning/phases/21-obsidian-bidirectional-knowledge-sync/21-01-SUMMARY.md` - Phase 21 delivered behavior and command evidence.
- `.planning/phases/21-obsidian-bidirectional-knowledge-sync/21-VERIFICATION.md` - Phase 21 requirement verification.
- `.planning/phases/22-settlement-governance-and-anti-gaming/22-01-SUMMARY.md` - Phase 22 delivered behavior and command evidence.
- `.planning/phases/22-settlement-governance-and-anti-gaming/22-VERIFICATION.md` - Phase 22 requirement verification.
- `.planning/phases/23-advanced-work-board-and-native-capture/23-01-SUMMARY.md` - Phase 23 delivered behavior and command evidence.
- `.planning/phases/23-advanced-work-board-and-native-capture/23-VERIFICATION.md` - Phase 23 requirement verification.
- `.planning/phases/24-phase19-verification-artifact-closure/24-01-SUMMARY.md` - Phase 24 delivered closure summary.

### Legacy UAT Evidence
- `.planning/phases/01-rt2-shell-and-product-truth/01-UAT.md` - Historical UAT file whose checklist is currently fully checked.
- `.planning/phases/m1-6-daily-report/m1-6-UAT.md` - Historical UAT file whose unchecked boxes must be classified as reverified, obsolete, superseded, or future scope.
- `.planning/phases/10-daily-report-and-okr-kpi-cockpit/10-01-SUMMARY.md` - Later RT2 daily report cockpit evidence likely relevant to superseding m1-6 daily report UAT items.
- `.planning/phases/14-daily-kanban-trello-parity/14-VALIDATION.md` - Later daily Kanban validation evidence relevant to superseding old daily report board/layout checks.

### Tooling And Verification Primitives
- `C:\Users\고상진\.codex\get-shit-done\bin\gsd-tools.cjs` - Existing GSD tool entrypoint exposing `verify-summary`, `frontmatter`, and `verify` subcommands.
- `package.json` - Default verification scripts: `pnpm typecheck`, `pnpm test`, and related test commands.
- `scripts/run-vitest-stable.mjs` - Stable Vitest runner behind `pnpm test`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `gsd-tools.cjs` already exposes artifact-adjacent commands including `verify-summary`, `frontmatter get/set/merge/validate`, `verify phase-completeness`, `verify references`, `verify artifacts`, and `verify key-links`.
- Phase 38 artifacts show a proven closure pattern for creating missing verification/validation files and repairing requirements checkbox/frontmatter traceability.
- Phase 24 artifacts show a proven closure pattern for preserving a failed historical audit while adding later closure evidence.
- Existing `package.json` scripts make `pnpm typecheck` and `pnpm test` the project-level verification gate.

### Established Patterns
- Verification artifacts use concise requirement-to-evidence tables and command evidence.
- Validation artifacts can be audit-oriented, citing requirement coverage, behavior evidence, tests, residual risk, and pass/partial status.
- Summary artifacts increasingly use YAML frontmatter with phase, plan, status, completed requirements, commits, and verification fields.
- Windows embedded Postgres and full-suite timeout caveats are recorded explicitly instead of hidden.
- Historical audit files are preserved as snapshots; later closure is documented in new phase artifacts or re-audit files.

### Integration Points
- Add Phase 19-24 validation artifacts in their existing phase directories.
- Add a Phase 43 closure artifact for legacy UAT classification.
- Add or extend a deterministic milestone health gate in GSD tooling or repo-local scripts, with tests if production repository files are touched.
- Update `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, and Phase 43 verification only after evidence exists.

</code_context>

<deferred>
## Deferred Ideas

- Product feature changes for connector apply, trusted local bridge, native/mobile capture, Jarvis rewrite proposals, semantic knowledge search, and economy flows are outside Phase 43 unless required only as evidence citations.
- Live provider-backed validation, browser E2E, or external network-dependent verification should remain outside the default milestone gate.
- Full native mobile app distribution and automatic Jarvis rewrite apply remain future milestone scope.

</deferred>

---

*Phase: 43-validation-debt-and-milestone-gate-closure*
*Context gathered: 2026-04-29*
