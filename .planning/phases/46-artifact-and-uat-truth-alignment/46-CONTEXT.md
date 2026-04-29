# Phase 46: Artifact and UAT Truth Alignment - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 46 aligns artifact truth for v2.7 so phase validation frontmatter, legacy UAT closure, milestone artifact gate output, and requirement traceability report the same completion state. The phase should make stale metadata fail deterministically, make legacy UAT status stop appearing as both `unknown` and closed, and ensure every v2.7 requirement maps to exactly one phase and one verification artifact before milestone close.

This phase is planning/tooling/artifact integrity work. It should not add a runtime confidence dashboard or report surface beyond the artifact gate output; that belongs to Phase 47. It should not change release-host test execution or embedded Postgres runtime behavior beyond consuming the evidence created in Phase 44 and Phase 45.

</domain>

<decisions>
## Implementation Decisions

### Milestone Artifact Gate Scope
- **D-01:** Extend the repo-local `scripts/rt2-milestone-artifact-gate.mjs` path instead of creating a second gate. Phase 43 already established this as the deterministic milestone artifact gate, and Phase 44/45 followed the repo-local `.mjs` script plus fixture test pattern.
- **D-02:** Update the gate's phase model from the v2.6-only Phase 39-43 list to the active v2.7 scope: Phase 44, Phase 45, Phase 46, and Phase 47. The gate may still check historical closure artifacts where they remain canonical evidence, but v2.7 requirement completion must be evaluated against the active `.planning/REQUIREMENTS.md`.
- **D-03:** Preserve explicit issue codes and file paths. New failures should use precise codes such as `VALIDATION_FRONTMATTER_STALE`, `LEGACY_UAT_STATUS_CONFLICT`, `REQUIREMENT_TRACEABILITY_DUPLICATE`, and `REQUIREMENT_VERIFICATION_MISSING`, rather than a generic failed gate.
- **D-04:** Keep the gate deterministic and local. It must not depend on network, live providers, browser E2E, external Postgres, or long-running release-host execution.

### Validation Frontmatter Truth
- **D-05:** Treat `*-VALIDATION.md` frontmatter as a machine-readable completion contract for current milestone phases. For completed phases, validation status must agree with execution evidence from `*-SUMMARY.md` and `*-VERIFICATION.md`.
- **D-06:** For Phase 44 and Phase 45, the gate should fail if summary/verification say complete or passed while validation metadata is missing, stale, draft, or not passed. Phase 39 stale metadata remains the motivating historical debt, but Phase 46 should solve the active rule rather than only patch one old file.
- **D-07:** Add or normalize YAML frontmatter on relevant v2.7 `*-VALIDATION.md` files as part of the phase evidence. At minimum, use fields for `phase`, `status`, `validated_at`, and `requirements_validated`.
- **D-08:** Do not infer pass solely from prose headings. The gate should parse frontmatter first and only use body text as supporting human-readable evidence.

### Legacy UAT Closure Truth
- **D-09:** Keep `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-LEGACY-UAT-CLOSURE.md` as the canonical legacy UAT closure artifact. Do not re-open the old UAT files or edit historical checkboxes to manufacture completion.
- **D-10:** Make the artifact gate and milestone audit language consume the same closure classifications from the Phase 43 artifact: Phase 01 is `reverified`; `m1-6-daily-report` is `superseded/obsolete with one replacement-verification item`; neither should appear as plain `unknown`.
- **D-11:** If parsing the Markdown closure table is too brittle, introduce a small structured closure summary or frontmatter block adjacent to the Phase 43 artifact, but keep the human-readable artifact as the source operators inspect.
- **D-12:** Milestone docs should describe legacy UAT as acknowledged and classified, not as active pending UAT. Any future daily-report work must be tracked against current RT2 requirements, not the old M1.6 file.

### Requirement Traceability
- **D-13:** Enforce one-to-one traceability for v2.7 requirements: each requirement in `.planning/REQUIREMENTS.md` must map to exactly one phase in the traceability table and exactly one phase verification artifact.
- **D-14:** Verification artifacts are the completion anchor. `SUMMARY.md` and `VALIDATION.md` support the audit, but ART/REL/PG/CONF completion must be proven by the corresponding `*-VERIFICATION.md` requirement table.
- **D-15:** Phase 46 should update `ART-01`, `ART-02`, and `ART-03` only after the gate rejects stale validation metadata, legacy UAT status is unified, and v2.7 traceability has deterministic checks.
- **D-16:** Phase 47 requirements should remain pending until Phase 47 executes. The Phase 46 gate can recognize planned Phase 47 rows without forcing them complete during Phase 46.

### Verification
- **D-17:** Add focused fixture tests for the artifact gate rather than invoking full `pnpm test` inside the script test. The tests should cover stale validation frontmatter, legacy UAT conflict, duplicate/missing requirement traceability, and a passing v2.7 fixture.
- **D-18:** Phase verification should include `pnpm test:milestone-gate`, `pnpm typecheck`, and the updated `pnpm rt2:milestone-gate` output. Run `pnpm test` if feasible under the normal project workflow; if it fails for an unrelated host/runtime reason, record it explicitly rather than hiding the artifact-gate result.
- **D-19:** Update the Phase 46 verification and validation artifacts with the same frontmatter contract the gate now checks, so Phase 46 proves its own rule.

### the agent's Discretion
- Exact frontmatter field names beyond `phase`, `status`, `validated_at`, and requirement list, provided the gate and artifacts use the same schema.
- Whether the legacy UAT structured classification is represented as frontmatter, an embedded JSON-ish block, or a small exported parser, provided downstream output no longer conflicts.
- Exact wording of milestone audit/report tables, provided statuses distinguish blocker, accepted classified legacy closure, pending future phase, and complete.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.7 focus on artifact metadata consistency and RT2 release confidence constraints.
- `.planning/REQUIREMENTS.md` - `ART-01`, `ART-02`, and `ART-03` Phase 46 requirements plus active v2.7 traceability table.
- `.planning/ROADMAP.md` - Phase 46 goal and success criteria.
- `.planning/STATE.md` - Current handoff, deferred legacy UAT status conflict, and stale Phase 39 validation metadata debt.
- `.planning/MILESTONES.md` - v2.7 milestone scope and current record of legacy UAT/artifact metadata debt.

### Prior Artifact Gate And Closure Evidence
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-CONTEXT.md` - Prior decisions for deterministic artifact gate, legacy UAT classification, and explicit reason codes.
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-LEGACY-UAT-CLOSURE.md` - Canonical legacy UAT closure classifications.
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-MILESTONE-GATE.md` - Human-facing artifact gate report precedent.
- `.planning/milestones/v2.6-MILESTONE-AUDIT.md` - Source evidence for stale Phase 39 validation metadata and legacy UAT truth conflict.
- `.planning/RETROSPECTIVE.md` - Lessons that traceability and phase close metadata must be updated at phase close, not reconstructed later.

### v2.7 Phase Evidence
- `.planning/phases/44-release-host-verification-harness/44-CONTEXT.md` - Release-host gate decisions and explicit Phase 46 deferral.
- `.planning/phases/44-release-host-verification-harness/44-VERIFICATION.md` - `REL-01` through `REL-03` completion anchor.
- `.planning/phases/44-release-host-verification-harness/44-VALIDATION.md` - Existing validation artifact to normalize under the new frontmatter rule.
- `.planning/phases/45-embedded-postgres-runtime-coverage/45-CONTEXT.md` - Embedded Postgres accepted-debt classification decisions and explicit Phase 46 deferral.
- `.planning/phases/45-embedded-postgres-runtime-coverage/45-VERIFICATION.md` - `PG-01` through `PG-03` completion anchor.
- `.planning/phases/45-embedded-postgres-runtime-coverage/45-VALIDATION.md` - Existing validation artifact to normalize under the new frontmatter rule.

### Tooling
- `package.json` - Existing `rt2:milestone-gate`, `test:milestone-gate`, `rt2:release-host-verify`, and default verification scripts.
- `scripts/rt2-milestone-artifact-gate.mjs` - Artifact gate implementation to extend.
- `scripts/rt2-milestone-artifact-gate.test.mjs` - Fixture test pattern to extend.
- `scripts/rt2-release-host-verify.mjs` - Release-host evidence and accepted-debt taxonomy that Phase 47 will later surface.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/rt2-milestone-artifact-gate.mjs` already provides a deterministic Node CLI, text/JSON output, explicit issue codes, file-path reporting, phase artifact checks, requirements checkbox checks, and traceability checks.
- `scripts/rt2-milestone-artifact-gate.test.mjs` already builds isolated `.planning` fixtures with temporary directories and direct function assertions.
- Phase 43's `43-LEGACY-UAT-CLOSURE.md` already contains the classifications needed to replace vague `unknown` legacy UAT status.
- Phase 44 and Phase 45 verification artifacts already provide the requirement-to-evidence tables that should become v2.7 completion anchors.

### Established Patterns
- Repo-local release/milestone tools live under `scripts/*.mjs`, are exposed via `package.json`, and have focused script tests.
- Planning artifact gates should fail with exact issue codes and paths.
- Historical audit files remain snapshots; later closure evidence is added separately instead of rewriting old audit history.
- Full browser E2E and live-provider checks stay outside default artifact gates.
- Completion claims are only credible when `SUMMARY.md`, `VERIFICATION.md`, `VALIDATION.md`, and `.planning/REQUIREMENTS.md` agree.

### Integration Points
- Extend `scripts/rt2-milestone-artifact-gate.mjs` with v2.7 phase definitions, validation frontmatter parsing, legacy UAT closure status checks, and one-to-one requirement verification checks.
- Extend `scripts/rt2-milestone-artifact-gate.test.mjs` with fixtures for the new failure modes.
- Normalize frontmatter in `.planning/phases/44-release-host-verification-harness/44-VALIDATION.md`, `.planning/phases/45-embedded-postgres-runtime-coverage/45-VALIDATION.md`, and Phase 46's own validation artifact during execution.
- Update `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, and v2.7 milestone notes only after the gate and verification evidence exist.

</code_context>

<specifics>
## Specific Ideas

- The operator question for this phase is: "If artifact metadata says complete, can the milestone gate prove the same truth from validation, verification, UAT closure, and requirement traceability?"
- The Phase 39 stale validation metadata is a historical example, but the implementation should define a reusable active-milestone rule.
- Legacy UAT files should be classified, not edited into looking current.
- Phase 46 should make Phase 47 easier by producing trustworthy artifact/confidence inputs, but should not build the Phase 47 operations surface.

</specifics>

<deferred>
## Deferred Ideas

- Operator-facing runtime confidence surface or generated consolidated report belongs to Phase 47.
- Changes to release-host slice execution, timeout handling, or embedded Postgres host-ready runtime behavior are out of scope unless only consumed as existing evidence.
- Native distribution, cross-company federation, provider-backed eval mandates, and autonomous Jarvis apply behavior remain future milestone scope.

</deferred>

---

*Phase: 46-artifact-and-uat-truth-alignment*
*Context gathered: 2026-04-30*
