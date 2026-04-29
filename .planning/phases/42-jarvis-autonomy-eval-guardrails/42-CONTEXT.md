# Phase 42: Jarvis Autonomy Eval Guardrails - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 42 constrains Jarvis knowledge rewrite behavior to approval-first, eval-backed proposals with production monitoring. It covers proposed diffs with evidence/risk/approval routes, provider-backed and deterministic fallback evaluations using one rubric schema, comparison states for provider unavailable/disagreement/low-confidence cases, production monitoring for grounding/citation freshness/contradictions/rewrite proposal quality, and audit linkage to contradiction review plus activity log.

This phase does not allow automatic knowledge rewrite apply, does not make a live provider mandatory for local or CI verification, does not replace contradiction review, and does not create a broad autonomous agent runtime beyond the Jarvis knowledge proposal/evaluation guardrail.

</domain>

<decisions>
## Implementation Decisions

### Rewrite Proposal Boundary
- **D-01:** Jarvis knowledge rewrite output must be stored and surfaced as a proposal, never as an applied mutation. The proposal includes proposed diff, affected knowledge target, source citations, freshness, contradiction status, risk level, eval summary, and approval route.
- **D-02:** There must be no route/service helper that applies a Jarvis rewrite directly from generation. Any accept path must go through an explicit approval or contradiction-review decision and then use existing approved import/conflict/application contracts where possible.
- **D-03:** Proposal generation should extend the existing grounded Jarvis/semantic/contradiction services rather than creating a separate autonomy subsystem. The proposal should reuse `rt2HybridSearchService`, Jarvis grounding citations, contradiction candidate evidence, and company-scoped activity logging.
- **D-04:** High-risk proposals include any unresolved contradiction, stale citation, missing citation, low eval confidence, provider/fallback disagreement, or rewrite touching RT2 canonical wiki/graph/work evidence. Those must route to human review and remain non-final until approved.

### Eval Rubric And Provider Fallback
- **D-05:** Provider-backed eval and deterministic fallback eval must write the same typed rubric schema. The schema should include rubric version, dimensions, per-dimension score, rationale, evidence IDs, confidence, provider mode, provider status, fallback result, disagreement flag, and final recommendation.
- **D-06:** Deterministic fallback eval is first-class, not a test-only stub. It should be good enough to verify local/CI behavior and should produce stable results from citation coverage, freshness, contradiction warnings, diff size, and evidence density.
- **D-07:** Provider eval is optional/injected. If unavailable, timed out, or invalid, the system records `provider_unavailable` or equivalent status and continues with deterministic fallback rather than failing the whole workflow.
- **D-08:** Disagreement and low confidence are operator-visible states. They should not collapse into a generic failed eval; UI/API/tests must preserve whether the issue was provider unavailable, provider/fallback disagreement, or low confidence.

### Approval, Audit, And Contradiction Linkage
- **D-09:** Approval/rejection events for rewrite proposals should connect to existing approval/governance and activity log patterns. Use a Jarvis-specific approval type or payload only if the current shared governance contract cannot represent the proposal clearly.
- **D-10:** Contradiction review remains the canonical place for conflict decisions. If a rewrite proposal addresses or creates a contradiction, it should link to `rt2V33ContradictionCandidates`/resolutions and preserve candidate IDs in proposal, approval, and activity log details.
- **D-11:** Activity log actions should distinguish proposal created, eval completed, approval requested, proposal approved, proposal rejected, and proposal blocked. Details should include proposal ID, target type/key, risk level, eval status, citation IDs, contradiction IDs, approval ID, and actor.
- **D-12:** Company boundary is mandatory for proposal, eval, approval, monitoring, and audit routes. All persistence must be company-scoped, migration-backed, and covered by route/service tests.

### Monitoring Surface
- **D-13:** Extend the existing Knowledge Operations/Jarvis/Governance surfaces rather than adding a standalone autonomy dashboard. Operators should be able to see grounding health, citation freshness, contradiction warning count, proposal quality distribution, blocked proposals, approval latency, and recent audit events.
- **D-14:** The monitoring API should extend `rt2KnowledgeOperationsService` or a nearby Jarvis operations service so Phase 37 health semantics remain intact. New reason codes should make autonomy risks explicit, such as rewrite proposals blocked, eval disagreement, low confidence, stale citation, or provider unavailable.
- **D-15:** UI should stay dense and evidence-forward: compact status cards, proposal rows, risk/eval badges, citation chips, contradiction links, and approval/rejection controls. Do not hide fallback mode, stale evidence, or unresolved contradiction warnings behind generic success states.

### Verification
- **D-16:** Add deterministic service/route tests for proposal creation, no direct apply path, provider unavailable fallback, provider/fallback disagreement, low confidence, approval request linkage, rejection audit, contradiction linkage, and monitoring reason codes.
- **D-17:** Add UI tests for proposal/eval/monitoring rendering where practical, including provider unavailable, disagreement, low-confidence, stale citation, and unresolved contradiction states.
- **D-18:** Preserve default verification with `pnpm typecheck && pnpm test`. Live LLM/provider calls, external network, and nondeterministic embeddings must not be required for local or CI success.

### the agent's Discretion
- Exact table names, route names, enum labels, and UI tab placement, provided they are typed in shared contracts, company-scoped, migration-backed, audit-linked, and visible to operators.
- Exact provider abstraction and timeout behavior, provided fallback eval is deterministic and provider failures are stored as evidence.
- Exact rubric scoring thresholds, provided high-risk/blocked states include unresolved contradiction, stale/missing citation, provider disagreement, and low confidence.

</decisions>

<specifics>
## Specific Ideas

- Treat Phase 42 as the safety continuation of Phase 36 and Phase 37: Jarvis can ground answers and operations can report health, but rewrite behavior must become proposal-only with eval and approval evidence.
- Treat Phase 42 as related to Phase 35 contradiction review, not a replacement for it. Rewrite proposals should help operators resolve knowledge conflicts, not silently rewrite the knowledge base.
- The operator question this phase should answer is: "Can Jarvis suggest a knowledge rewrite safely, and can we see why it should or should not be approved?"
- Provider-backed eval improves quality, but deterministic fallback is the contract that keeps development, CI, and degraded production behavior auditable.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product And Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, v2.6 autonomy/evals hardening goal, product safety constraints, and deterministic local development constraint.
- `.planning/REQUIREMENTS.md` - `AUTO-01`, `AUTO-02`, and `AUTO-03` requirements for autonomy/eval hardening.
- `.planning/ROADMAP.md` - Phase 42 goal and success criteria.
- `.planning/STATE.md` - Current v2.6 state and deferred boundary for automatic knowledge rewrites without approval.

### Prior Phase Context
- `.planning/phases/36-jarvis-grounded-answers/36-CONTEXT.md` - Existing Jarvis grounded answer, citation, stale evidence, and contradiction warning decisions.
- `.planning/phases/36-jarvis-grounded-answers/36-01-SUMMARY.md` - Delivered Jarvis grounding behavior and tests if present in this repo.
- `.planning/phases/37-knowledge-intelligence-operations/37-CONTEXT.md` - Existing knowledge operations health gate and Jarvis grounding monitoring decisions.
- `.planning/phases/37-knowledge-intelligence-operations/37-01-SUMMARY.md` - Delivered operations health behavior and verification evidence.
- `.planning/phases/35-contradiction-review-workflow/35-CONTEXT.md` - Contradiction candidate and resolution workflow decisions.
- `.planning/phases/35-contradiction-review-workflow/35-01-SUMMARY.md` - Delivered contradiction review behavior and tests if present in this repo.
- `.planning/phases/41-native-and-mobile-capture-hardening/41-CONTEXT.md` - Recent v2.6 pattern for evidence-forward queue, deterministic fallback, route/service/UI tests, and source/audit continuity.

### Existing Code Evidence
- `server/src/services/rt2-jarvis.ts` - Existing grounded Jarvis advice, citations, stale evidence warnings, unresolved contradiction warnings, and search integration.
- `server/src/routes/rt2-jarvis.ts` - Existing company-scoped Jarvis task advice, breakdown, and insights routes.
- `server/src/services/rt2-auto-evaluation.ts` - Existing shadow/copilot/auto quality eval policy, manager review queue, and decision service.
- `server/src/routes/rt2-auto-evaluation.ts` - Existing auto-evaluate, quality review, approval/rejection, and auto-policy routes.
- `packages/shared/src/types/rt2-governance.ts` - Existing Jarvis evaluation, quality review, approval, skill capability, and grounded citation shared types to extend.
- `packages/db/src/schema/rt2_quality_scores.ts` - Existing AI quality score persistence baseline for eval mode and manager decision fields.
- `packages/db/src/schema/approvals.ts` - Existing approval persistence contract.
- `packages/db/src/schema/activity_log.ts` - Existing activity log persistence contract.
- `server/src/services/rt2-contradiction-review.ts` - Existing contradiction candidate generation, resolution, and semantic freshness updates.
- `server/src/routes/rt2-contradiction-review.ts` - Existing company-scoped contradiction review routes.
- `packages/db/src/schema/rt2_v33_contradiction_review.ts` - Existing contradiction candidate/resolution schema to link proposal evidence.
- `server/src/services/rt2-knowledge-operations.ts` - Existing semantic index, contradiction, and Jarvis grounding health aggregation to extend for rewrite monitoring.
- `server/src/routes/rt2-knowledge-operations.ts` - Existing knowledge operations health route.
- `packages/shared/src/types/rt2-knowledge.ts` - Existing knowledge operations health shared contract and reason codes to extend.
- `ui/src/components/Rt2QualityPanel.tsx` - Existing Jarvis manager review UI surface.
- `ui/src/components/Rt2GovernancePanel.tsx` - Existing approval/activity/Jarvis runtime governance surface.
- `ui/src/api/rt2-jarvis-runtime.ts` - Existing Jarvis client API for task advice, quality reviews, auto policy, reverse-designed tasks, and skill capabilities.
- `server/src/__tests__/rt2-phase6-intelligence.test.ts` - Existing Jarvis grounding, auto evaluation, manager review, and runtime skill capability coverage.
- `server/src/__tests__/rt2-knowledge-operations.test.ts` - Existing knowledge operations health coverage for semantic, contradiction, and Jarvis grounding states.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2JarvisService.getTaskAdvice` already produces grounded citations, stale evidence warnings, unresolved contradiction blockers, and routable citation targets.
- `rt2HybridSearchService` already returns semantic plus lexical evidence with freshness, confidence, contradiction status, snippets, scores, and provenance.
- `rt2AutoEvaluationService` already models `shadow`, `copilot`, and `auto` modes, manager review queue, policy decision, and approve/reject decision handling.
- `Rt2QualityPanel` already renders Jarvis manager review rows with mode, score, expected delta, policy reason, rationale, and approve/reject controls.
- `Rt2GovernancePanel` already renders approval queue, activity log, and Jarvis runtime capability evidence.
- `rt2KnowledgeOperationsService.getHealth` already aggregates semantic index health, contradiction review health, Jarvis grounding health, reason codes, and flow links.
- `rt2ContradictionReviewService` already creates candidates, resolves them, and marks semantic freshness stale/fresh.

### Established Patterns
- RT2 routes are company-scoped under `/companies/:companyId/rt2/...` and use `assertCompanyAccess`.
- Shared contracts live under `packages/shared/src/types/*` and `packages/shared/src/validators/*`, with server and UI consuming the same types.
- Persistence additions use Drizzle schema plus numbered SQL migrations.
- Activity log and approval queue are the accepted audit and human decision mechanisms.
- Local/CI verification must stay deterministic and cannot depend on live providers, live network, or nondeterministic AI output.
- Product-facing UI should use RealTycoon2/Jarvis terminology and dense operator workflows.

### Integration Points
- Add a Jarvis rewrite proposal/eval persistence model near `rt2_quality_scores` or a new Jarvis autonomy schema, then export it from `packages/db/src/schema/index.ts`.
- Extend shared governance or Jarvis types with proposal, diff, rubric, eval comparison, provider/fallback status, approval route, and monitoring summary contracts.
- Add service methods near `rt2-jarvis.ts` for proposal creation and grounded evidence collection, and near `rt2-auto-evaluation.ts` or a new service for rubric eval recording/comparison.
- Add routes under `server/src/routes/rt2-jarvis.ts` or a sibling route for proposal create/list/evaluate/request-approval/decision status, without adding direct apply.
- Extend `rt2KnowledgeOperationsService` and `Rt2KnowledgeOperationsHealth` with rewrite proposal quality and eval risk monitoring.
- Extend `Rt2QualityPanel`, `Rt2GovernancePanel`, or the existing Jarvis runtime surface to show proposal/eval/approval evidence.
- Extend embedded Postgres tests where persistence matters and fallback route-contract tests where host support is unreliable.

</code_context>

<deferred>
## Deferred Ideas

- Fully autonomous knowledge rewrite apply without approval remains out of scope.
- Mandatory live provider dependency remains out of scope; provider-backed eval must degrade to deterministic fallback.
- Broad autonomous agent runtime changes beyond Jarvis knowledge rewrite proposal guardrails remain future scope.
- Cross-company knowledge federation remains outside the trusted company ecosystem.

</deferred>

---

*Phase: 42-jarvis-autonomy-eval-guardrails*
*Context gathered: 2026-04-29*
