# Phase 47: Runtime Confidence Operations Surface - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 47 gives operators one reliable place to inspect current release confidence, accepted debt, blocker status, deferred future scope, and latest verification evidence before v2.7 close. The phase should consume the release-host evidence from Phase 44/45 and the artifact truth/taxonomy from Phase 46, then expose a consolidated generated report or operations surface that distinguishes actionable blockers from accepted debt and future scope.

This phase is an operations confidence reporting surface. It should not rewrite release-host execution, embedded Postgres host readiness, validation frontmatter rules, legacy UAT closure classification, or milestone artifact gate semantics. Those are already owned by Phase 44, 45, and 46. Phase 47 may add reporting helpers or small taxonomy-normalization adapters only where needed to present the same truth consistently.

</domain>

<decisions>
## Implementation Decisions

### Surface Shape
- **D-01:** Prefer a generated report/CLI operations surface over a new React dashboard unless the existing app already has a low-friction operations page to reuse. The phase requirement allows "앱 또는 generated report"; a report is the smallest reliable close path for release confidence and avoids UI scope creep.
- **D-02:** Add a repo-owned command exposed through `package.json`, likely `pnpm rt2:runtime-confidence`, that writes both machine-readable JSON and human-readable Markdown evidence.
- **D-03:** Store generated evidence under a deterministic local planning/evidence path, such as `.planning/runtime-confidence/<timestamp>/summary.json` and `report.md`, matching the release-host evidence pattern.
- **D-04:** The report should be safe to run locally and in release-host contexts: no network, no browser E2E, no live provider, and no external Postgres requirement.

### Evidence Inputs
- **D-05:** Treat `scripts/rt2-release-host-verify.mjs` summaries as the primary release confidence input. The report should discover the latest `.planning/release-host-runs/*/summary.json` by default and accept an explicit `--release-host-summary <path>` override.
- **D-06:** Treat `scripts/rt2-milestone-artifact-gate.mjs --json` output as the primary blocker/debt taxonomy input for planning artifacts and requirement traceability.
- **D-07:** Include latest phase verification/validation evidence for v2.7 phases 44-47 by reading each phase's `*-VERIFICATION.md`, `*-VALIDATION.md`, and summary artifact when present.
- **D-08:** Do not infer completion from roadmap prose alone. Requirement completion and phase confidence must be anchored in `.planning/REQUIREMENTS.md`, phase verification artifacts, release-host summaries, and milestone-gate output.

### Debt Taxonomy
- **D-09:** Normalize all status output into the same top-level categories: `blocker`, `accepted_debt`, `deferred_scope`, `passed`, and `pending`.
- **D-10:** A failed milestone artifact gate issue is a `blocker` unless it is explicitly classified as planned future scope or accepted debt by the phase evidence. Unknown/unclassified issue codes should default to blocker.
- **D-11:** Release-host `accepted_debt` attempts, especially `embedded-postgres-windows-default-skip`, remain accepted debt only when they include owner, reason code, and closure command. Missing closure command should become a blocker in the operations report.
- **D-12:** Phase 47 pending requirements (`CONF-01`, `CONF-02`) should appear as pending while planning/execution is underway, then as passed only after Phase 47 verification cites them.
- **D-13:** Deferred future scope should be displayed separately from accepted debt. Examples include native distribution, cross-company federation, provider-backed eval mandates, and autonomous Jarvis apply behavior from project/milestone context.

### Operator Report Content
- **D-14:** The Markdown report must show a concise executive status at the top: overall status, blockers count, accepted debt count, deferred scope count, latest release-host run path, and latest milestone-gate status.
- **D-15:** Include a table of release-host slices/attempts with status, owner, duration, retry recommendation, and log references.
- **D-16:** Include a table of milestone/artifact issues with code, category, file, owner if inferable, and operator action.
- **D-17:** Include a v2.7 requirement evidence table covering REL, PG, ART, and CONF requirements with phase, requirement status, verification artifact path, and validation status.
- **D-18:** Include "next command" guidance for accepted debt and blockers, but keep it factual: exact rerun/host-ready/gate commands, not general advice.

### Implementation Pattern
- **D-19:** Reuse the existing repo-local Node `.mjs` script pattern and fixture-style tests from `rt2-release-host-verify` and `rt2-milestone-artifact-gate`.
- **D-20:** Prefer extracting or exporting pure helpers from existing scripts only if needed for testable reuse. Avoid duplicating classification logic if a small shared helper is cleaner, but do not refactor unrelated release-host behavior.
- **D-21:** Keep report generation deterministic and tolerant of missing evidence. Missing latest release-host summary should produce a blocker with the exact command to generate it, not crash without a useful report.
- **D-22:** JSON output should be stable enough for future UI reuse. If a React operations dashboard is added later, it should consume this JSON rather than re-implementing evidence parsing.

### Verification
- **D-23:** Add focused fixture tests for the operations report script covering: all-passed state, accepted-debt state, milestone-gate blocker state, missing release-host evidence, and pending Phase 47 requirements.
- **D-24:** Phase verification should include `pnpm test:runtime-confidence` or equivalent focused script test, `pnpm typecheck`, `pnpm rt2:milestone-gate -- --json`, and a sample `pnpm rt2:runtime-confidence` run.
- **D-25:** Run full `pnpm test` if feasible under the repo workflow. If default Windows embedded Postgres skips remain, the operations report must surface that as accepted debt rather than letting the verification summary imply full runtime confidence.

### the agent's Discretion
- Exact command and output directory names, provided they are repo-owned, easy to invoke, and consistent with existing evidence paths.
- Exact owner inference for milestone-gate issue codes, provided unclassified issues remain blockers.
- Whether the first implementation is report-only or also adds a minimal app route. Report-only is preferred unless the codebase already exposes an obvious operations surface with low risk.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.7 milestone focus, RT2-first identity, accepted-debt history, and deterministic local verification constraints.
- `.planning/REQUIREMENTS.md` - `CONF-01` and `CONF-02` pending Phase 47 requirements plus v2.7 traceability table.
- `.planning/ROADMAP.md` - Phase 47 goal and success criteria.
- `.planning/MILESTONES.md` - v2.7 milestone scope and planned operations confidence outcome.
- `.planning/STATE.md` - Current release-host, embedded Postgres, artifact truth, and deferred-scope context.

### Upstream v2.7 Evidence Producers
- `.planning/phases/44-release-host-verification-harness/44-CONTEXT.md` - Release-host wrapper decisions, evidence layout, timeout/failure classification, and rerun behavior.
- `.planning/phases/44-release-host-verification-harness/44-VERIFICATION.md` - `REL-01` through `REL-03` completion anchor.
- `.planning/phases/45-embedded-postgres-runtime-coverage/45-CONTEXT.md` - Accepted-debt classification for Windows embedded Postgres default skips and host-ready closure command.
- `.planning/phases/45-embedded-postgres-runtime-coverage/45-VERIFICATION.md` - `PG-01` through `PG-03` completion anchor and accepted-debt verification.
- `.planning/phases/46-artifact-and-uat-truth-alignment/46-CONTEXT.md` - Artifact truth, legacy UAT classification, and v2.7 requirement traceability decisions.
- `.planning/phases/46-artifact-and-uat-truth-alignment/46-VERIFICATION.md` - `ART-01` through `ART-03` completion anchor and milestone gate evidence.
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-LEGACY-UAT-CLOSURE.md` - Canonical legacy UAT classification consumed by artifact gate and report taxonomy.

### Tooling And Documentation
- `package.json` - Existing release/milestone scripts and the place to expose the new runtime confidence command/test command.
- `scripts/rt2-release-host-verify.mjs` - Release-host summary/report schema and accepted-debt attempt shape.
- `scripts/rt2-release-host-verify.test.mjs` - Fixture-style script tests for release-host confidence behavior.
- `scripts/rt2-milestone-artifact-gate.mjs` - Artifact gate JSON output, v2.7 phase definitions, and issue-code taxonomy source.
- `scripts/rt2-milestone-artifact-gate.test.mjs` - Fixture-style script tests for artifact gate behavior.
- `doc/RELEASE-HOST-VERIFICATION.md` - Operator-facing release-host command, rerun, embedded Postgres accepted-debt, and evidence interpretation docs.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/rt2-release-host-verify.mjs` already writes `summary.json`, `report.md`, per-slice log references, status, owner, retry recommendation, and `accepted_debt` attempts with debt metadata.
- `scripts/rt2-milestone-artifact-gate.mjs` already exposes a pure `checkPlanningArtifacts(root)` function returning `passed`, issue counts, active milestone phases, and structured issues.
- `scripts/rt2-release-host-verify.test.mjs` and `scripts/rt2-milestone-artifact-gate.test.mjs` already demonstrate temporary fixture roots and pure function assertions.
- `doc/RELEASE-HOST-VERIFICATION.md` already explains where release-host evidence lives and how operators close embedded Postgres accepted debt.

### Established Patterns
- Release and planning confidence tooling lives in repo-local `scripts/*.mjs` files and is exposed through `package.json`.
- Evidence output uses a machine-readable JSON file plus a human-readable Markdown report.
- Default test/evidence commands avoid browser E2E and live providers.
- Statuses must not hide caveats: timeout, failed, accepted debt, pending future scope, and blocker are distinct operational states.
- Historical audit artifacts are snapshots; current truth is represented by later closure/verification artifacts and active gate output.

### Integration Points
- Add a runtime confidence script under `scripts/`, with exported pure helpers for tests.
- Add package scripts for the runtime confidence report and focused tests.
- Consume latest release-host summary from `.planning/release-host-runs/` or explicit CLI path.
- Consume milestone artifact gate results through exported `checkPlanningArtifacts(root)` rather than scraping CLI text.
- Read v2.7 verification/validation artifacts to build requirement evidence rows.
- Optionally update `doc/RELEASE-HOST-VERIFICATION.md` or add a short runtime-confidence doc section so operators know the command and output path.

</code_context>

<specifics>
## Specific Ideas

- The operator question for this phase is: "Can I see, in one place, what blocks release, what debt we knowingly accept, what is future scope, and what evidence supports that conclusion?"
- Phase 47 should make Phase 44/45/46 evidence usable, not create another independent source of truth.
- Report-only is the preferred default because it satisfies the phase with less risk than adding a new app UI surface.
- JSON-first output keeps a later app dashboard possible without duplicating parsing logic.

</specifics>

<deferred>
## Deferred Ideas

- A richer React operations dashboard can be a future phase if operators need in-app browsing after the generated report proves the data model.
- Browser E2E/release-smoke integration remains separate from the default runtime confidence report.
- Changing embedded Postgres Windows default test policy is future scope; Phase 47 should report accepted debt and closure commands, not alter runtime behavior.
- Native distribution, cross-company federation, provider-backed eval mandates, and autonomous Jarvis apply behavior remain outside v2.7 confidence closure.

</deferred>

---

*Phase: 47-runtime-confidence-operations-surface*
*Context gathered: 2026-04-30*
