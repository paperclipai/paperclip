# Weekly Executive Operating Review MVP PRD/SPEC

Status: Draft for operator review; taxonomy, fixture, adapter, and model decisions locked
Date: 2026-05-21
Owner: Paperclip product and engineering
Scope: V1 control-plane MVP proof for a clean hybrid AI company

## 1. Summary

Paperclip's MVP proof should be an evidence-backed weekly executive operating review for a clean hybrid AI company. The review is generated from Paperclip-owned control-plane records, opens as a CEO decision dashboard, and lets the operator take governed actions directly from the review.

The product goal is not to create another report generator. The goal is to prove that Paperclip can run an AI company as an operational control plane: the CEO can understand company state, trust the evidence, find what is incomplete or risky, and act without leaving the system.

## 2. Interview Decisions

The approved product direction is:

- MVP proof: operational control plane for real work.
- Pilot data: clean demo company, not current Permisoria operational state.
- Demo company type: hybrid AI company.
- Golden path: weekly business operation.
- Final artifact: executive operating review.
- Primary operator: founder/CEO operator.
- Trust contract: truthfulness, completeness, and actionability.
- Evidence standard: strict citations required.
- Citation scope: broad material-claim standard.
- First screen: decision dashboard.
- CEO actions: core governance actions.
- MVP data source: core control-plane data only.
- Generation model: deterministic analysis first, LLM narration second.
- Narration rule: draft-only narration with validation.
- QA gate: acceptance-fixture driven.
- Security posture: company-scoped strict access.
- Storage model: hybrid live plus snapshot.
- Trigger model: manual generate/refresh first.
- UI shape: dedicated Weekly Review page.
- UI polish target: production-usable, restrained UI.
- Implementation priority: quality over speed with full vertical slices.
- Finding severity model: decision-impact severity.
- Critical finding definition: blocks or materially changes an executive decision, creates immediate company risk, or invalidates the review.
- High finding definition: needs CEO action this week, has material risk with clear mitigation, or represents an overdue governance item.
- Medium finding definition: important non-immediate follow-up, trend/early warning, or limited-blast-radius quality issue.
- Low finding definition: informational observation, positive outcome, or minor hygiene item.
- Dashboard grouping: by decision area, with severity badges and workstream metadata.
- MVP finding categories: `decision_blocker`, `action_required`, `evidence_gap`, `stale_item`, `budget_signal`, `quality_signal`, `win_context`.
- Recommended action model: structured command first, with optional explanatory text.
- Finding status model: `open`, `actioned`, `acknowledged`, `dismissed`, `stale`.
- Evidence quality model: strict gating.
- Positive outcomes: first-class low-severity `win_context` findings.
- Fixture finding count: exactly eight deterministic findings.
- Local adapter assurance scope: `claude_local`, `codex_local`, and `agy_local`.
- Adapter readiness surfaces: Agent setup/detail, Instance Settings runtime health, and Weekly Review readiness panel.
- Adapter readiness levels: `basic_ready`, `operational_ready`, and `fixture_ready`.
- Readiness execution gating: failed basic readiness blocks execution; operational gaps warn unless strict mode is enabled; fixture gaps block MVP/demo certification only.
- Northstar adapter mapping: Product Delivery uses `codex_local`, Research & Insights uses `agy_local`, and Operations/Governance uses `claude_local`.
- Northstar agent ownership: Engineering Lead uses `codex_local`; Research & Insights Lead uses `agy_local`; CEO and Support/Ops Lead use `claude_local`.
- Adapter fallback model: operator-visible recommendation, not automatic reassignment.
- Fallback mapping: capability-compatible suggestions, with operator approval before runtime changes.
- Adapter readiness finding model: default to `quality_signal`; escalate to `decision_blocker` or `evidence_gap` only when readiness blocks a decision or invalidates evidence.
- Adapter readiness fixture rule: not part of the exact eight locked business findings; represented as review metadata and readiness panel evidence.
- Readiness status vocabulary: UI status plus structured reason codes and level booleans.
- Readiness evidence source: timestamped runtime probe records, with heartbeat runs as secondary evidence when available.
- Model assurance scope: selected model readiness, role fit, policy/governance, and weekly-review evidence.
- Model assurance policy: both adapter-specific and role-specific.
- Google adapter migration: `agy_local` replaces `gemini_local` for new MVP readiness/model assurance because Google is transitioning consumer Gemini CLI workflows to Antigravity CLI.
- Google model policy: `agy_local` exposes exactly one MVP-certified model, `gemini-3.5-flash`; older Gemini model IDs are legacy migration data only and must not be certified for the Weekly Review MVP.
- Model change governance: no silent model/profile changes when cost, capability, evidence quality, or risk posture changes.
- Model evidence source: adapter model list, detect-model result when supported, readiness probe hello-run, model profile definitions, and in-period heartbeat runs.
- Northstar model policy: use each adapter's configured primary model for role-critical work and adapter-default cheap/utility profile only for bounded low-risk work.
- Observability minimum: structured generation and probe event records, with limited redacted debug metadata only for failures.
- Retention policy: keep ready review versions as auditable snapshots; bound failed debug metadata and runtime probe history.
- Rollout strategy: generic weekly-review foundation first, proven by Northstar fixture before broadening to arbitrary real companies.

## 3. Product Recommendations

1. Make strict evidence citations the central product invariant. A review that cannot cite material claims is not ready, even if the prose is polished.
2. Build the MVP around a seeded acceptance fixture. A clean demo company with known expected findings makes QA, security review, and demos repeatable.
3. Lead with CEO decisions, not narrative. The review's first screen should rank pending approvals, escalations, blockers, budget risks, stale work, and recommended follow-ups.
4. Store review versions as auditable snapshots and allow refresh drafts. This preserves history while still letting the operator regenerate with latest data.
5. Treat LLM output as presentation, not authority. The deterministic finding payload is the source of truth; narration is valid only when every material statement maps to validated findings and citations.
6. Keep MVP data inside Paperclip. External systems can follow only after citations, access control, and prompt-injection boundaries are proven internally.
7. Require activity logs for every review action. The CEO should be able to explain who acted, when, why, and which finding or recommendation caused the action.
8. Treat local adapter readiness as part of operating trust. `claude_local`, `codex_local`, and `agy_local` should be visible, probeable, and cited before they are used as evidence for MVP certification.
9. Treat AI model selection as governed runtime policy. The selected model must be available, runnable, suitable for the agent role, cost-aware, and visible in the weekly review evidence.
10. Make observability evidence audit-grade but bounded. Persist structured lifecycle events for generation, validation, probes, and actions; store redacted debug details only when they are needed to explain failure.
11. Roll out as generic product infrastructure with a deterministic fixture, not as a Northstar-only demo shortcut.

## 4. Goals

The MVP must prove:

- A CEO can generate a weekly operating review for one company.
- The review uses only Paperclip-owned data in MVP.
- Every material claim is backed by citations.
- The review surfaces progress, blockers, stale work, failed runs, missing owners, budget risk, agent performance, and missing next actions.
- The CEO can act from the review using governed controls.
- All actions are company-scoped and auditable.
- The feature is testable with a deterministic acceptance fixture.
- `claude_local`, `codex_local`, and `agy_local` have visible readiness checks.
- The Northstar fixture proves mixed local-adapter operations without adding adapter-readiness noise to the eight locked business findings.
- Source-agent model choices are visible, validated against adapter capabilities, and checked for role fit.
- Every review generation and readiness/model probe leaves a structured, company-scoped audit trail.
- Retention rules preserve ready review snapshots while bounding failed debug payloads and probe history.

## 5. Non-Goals

The MVP does not include:

- scheduled weekly generation
- email/slack delivery
- external sources such as GitHub, Linear, Sentry, Gmail, docs, or customer feedback
- public sharing links
- agent API-key access to review content
- bulk actions
- budget policy editing from the review
- agent configuration editing from the review
- automatic adapter fallback or silent reassignment
- automatic model upgrades, downgrades, or profile switches
- blocking ordinary local development on `operational_ready` or `fixture_ready` gaps
- external observability sinks, hosted telemetry pipelines, or third-party log ingestion
- full admin retention UI
- full enterprise RBAC beyond existing company/operator permissions
- asset/body extraction or work-product URL crawling for review evidence
- treating LLM narration as source of truth

## 6. Personas

### Founder/CEO Operator

The CEO operator needs to answer:

- What changed this week?
- What is blocked or stale?
- What is risky?
- What failed?
- What needs my decision?
- Which agents are performing, idle, blocked, or producing poor outcomes?
- What should happen next?
- What evidence supports each claim?

### QA/Release Reviewer

The QA reviewer needs deterministic fixtures and expected outputs to prove the review is complete, truthful, and actionable.

### Security Reviewer

The security reviewer needs clear company boundaries, citation access checks, action auditability, and narrow data ingestion rules.

## 7. MVP Demo Company

Create a clean seeded hybrid AI company that represents a small autonomous business. The seed should be realistic but intentionally bounded.

Final structure:

- Company: "Northstar Labs"
- Concept: hybrid AI product studio and AI research/insights firm.
- Company goal: "Operate a small AI product and research studio with reliable weekly delivery, support, and governance."
- Flagship product: AI inbox intelligence assistant.
- Adjacent products:
  - AI customer research brief generator.
  - AI operations copilot.
- Agents:
  - CEO: owns strategy and final decisions
  - Product Lead: owns roadmap and prioritization
  - Engineering Lead: owns delivery and technical risk
  - Research & Insights Lead: owns customer research quality and citation completeness
  - Support/Ops Lead: owns customer/support operations and runbooks
  - Finance/Ops Analyst: owns budget and operational health
- Projects:
  - Product Delivery
  - Research & Insights
  - Support Operations
  - Operational Reliability
- Adapter assignments:
  - CEO: `claude_local`
  - Product Lead: `claude_local` or inherited governance adapter unless the fixture needs a product-specific run
  - Engineering Lead: `codex_local`
  - Research & Insights Lead: `agy_local`
  - Support/Ops Lead: `claude_local`
  - Finance/Ops Analyst: `claude_local`
- Model policy:
  - CEO: configured `claude_local` primary model for governance decisions and board-ready writing.
  - Product Lead: configured `claude_local` primary model for prioritization and concise planning.
  - Engineering Lead: configured `codex_local` primary model for implementation; adapter-default cheap profile only for bounded cleanup, summarization, or low-risk utility work.
  - Research & Insights Lead: configured `agy_local` primary model for research synthesis and citation validation; adapter-default cheap profile only for low-risk extraction, classification, or retry work.
  - Support/Ops Lead: configured `claude_local` primary model for runbook and handoff work; cheap profile only for routine summaries.
  - Finance/Ops Analyst: configured `claude_local` primary model or cheap profile depending on whether the work changes policy or only summarizes spend.
  - Any omitted model is allowed only when the adapter can detect or report the effective runtime model; otherwise readiness is `warning` with `model_unresolved`.
- Review period:
  - one active operating week with mixed but mostly successful outcomes
- Weekly objectives:
  - ship a cited weekly inbox digest prototype
  - complete customer research brief v1
  - run operational readiness review
- Success pattern:
  - Product Delivery succeeds but has pending approval before broader rollout.
  - Research & Insights succeeds but contains one citation/data gap.
  - Operations succeeds but discovers blocked support handoff caused by a missing owner.
- CEO decision:
  - approve limited pilot rollout
- Broad rollout blocker:
  - support handoff has no owner
- Failed run:
  - research summarization run failed validation
- Budget warning:
  - company-level budget warning caused by citation-validation retries and prototype implementation spend
- Stale items ranked by impact:
  - Operations runbook update is stale.
  - Research follow-up survey draft is stale.
  - Engineering cleanup task is stale.
- MVP demo CEO actions:
  - approve limited pilot rollout
  - assign Support/Ops Lead owner
  - create research citation-gap follow-up issue
  - leave budget policy review open as unresolved
- Seeded issues:
  - completed product task with successful run evidence
  - blocked support task with unresolved dependency
  - stale in-progress engineering task with no recent comments or runs
  - failed run requiring follow-up
  - unassigned operational risk
  - budget utilization warning
  - agent paused or pending approval
  - routine or recurring task with missing next action, if routines are included
- Seeded comments/activity:
  - progress comments with citations
  - blocker comments
  - review/approval activity
  - run events showing success and failure
  - cost/budget events

The fixture must include happy-path and negative-path data. The negative cases are not optional because completeness and truthfulness cannot be proven only with successful work.

The exact expected review output is defined in Section 16.1 and must be treated as the acceptance fixture contract.

## 8. Trust Contract

### 8.1 Truthfulness

Every material claim must cite at least one source record. Material claims include claims about:

- status
- progress
- blockers
- stale work
- ownership
- agent performance
- failures
- recovery
- cost or budget
- risk
- recommended CEO actions

Unsupported material claims must be represented as gaps, not hidden in prose.

### 8.2 Completeness

The review must evaluate the company for:

- completed work during the review period
- in-progress work with no recent activity
- blocked work
- unassigned work
- failed or cancelled runs
- queued/running work that appears stale
- budget or cost risk
- agents that are paused, pending approval, idle, or repeatedly failing
- issues missing a clear next action
- recommendations accepted or dismissed in prior versions

### 8.3 Actionability

The CEO must be able to act on review findings:

- approve or reject governed items
- assign or reassign work
- create a follow-up issue
- pause or resume an agent
- accept or dismiss a recommendation

Every action must write an activity log entry tied to the review version and the finding or recommendation that triggered it.

## 9. Information Architecture

Add a dedicated company-scoped Weekly Review page.

Recommended route:

- `/companies/:companyPrefix/weekly-review`

The page should include:

- header with company, review period, version, status, and refresh/generate action
- decision dashboard
- grouped findings by decision area:
  - Decision blockers
  - Actions needed
  - Evidence gaps
  - Operational signals
  - Wins/context
- severity badges on every finding
- workstream labels or filters for Product Delivery, Research & Insights, Operations, Budget, and Governance
- budget/cost section
- agent outcome and reliability summary without leaderboards
- evidence/citation drilldown
- action history
- narration/memo section after the decision dashboard

The company dashboard can show a compact "Latest weekly review" module, but the operating surface should be the dedicated page.

## 10. UX Requirements

The UI should be production-usable and restrained:

- dense, scannable layout
- tables and grouped findings over decorative cards
- severity badges for risk and completeness findings
- clear status states: no review, generating, draft, validation failed, ready, stale, archived
- citation affordances one click from every finding/recommendation
- inline action controls for core governance actions
- confirmation for high-impact actions such as pause/resume and rejection
- empty states that explain what data is needed
- failure states that show validation errors and unsupported claims
- keyboard-accessible controls
- no hidden silent failures

The first viewport should prioritize decisions and risks. Narrative summary should be below or beside the decision dashboard, not the lead surface.

## 11. Backend Requirements

### 11.1 Review Generation

The backend must support manual generation and refresh:

- generate first weekly review for a company and period
- refresh latest draft with current data
- persist a new version for each refresh
- preserve prior versions
- mark a version ready only after validation succeeds

Inputs:

- `companyId`
- `periodStart`
- `periodEnd`
- optional previous review version id for continuity

Outputs:

- review id
- version id
- status
- finding counts by category/severity
- recommendation counts by state
- validation result

### 11.2 Deterministic Finding Engine

The finding engine should compute findings from structured records before any LLM narration runs.

Finding categories:

- `decision_blocker`
- `action_required`
- `evidence_gap`
- `stale_item`
- `budget_signal`
- `quality_signal`
- `win_context`

Severity levels:

- `critical`
- `high`
- `medium`
- `low`

Severity rules:

- `critical`: blocks or materially changes an executive decision, creates immediate company risk, or invalidates the review.
- `high`: needs CEO action this week, has material risk with a clear mitigation path, or represents an overdue governance item.
- `medium`: important follow-up that is not CEO-immediate, trend/early warning, or limited-blast-radius quality issue.
- `low`: informational observation, cited positive outcome, or minor hygiene item.

Finding statuses:

- `open`
- `actioned`
- `acknowledged`
- `dismissed`
- `stale`

Each finding must include:

- company id
- review version id
- stable finding id
- category
- severity
- status
- title
- summary
- workstream
- evidence ids
- recommended action
- source entity type
- source entity id
- confidence
- detected timestamp
- validation status
- rules triggered
- actor id when the finding is attributable to a user or agent action
- UI call-to-action metadata
- computed reason codes
- recommendation link, when applicable

Recommended actions must be structured first:

- `type`
- `label`
- `targetEntity`
- `payload`
- optional explanatory text

Positive outcomes must use `win_context` and follow the same citation rules as negative or action-oriented findings.

### 11.3 Citation Validation

Each citation must reference a Paperclip-owned record:

- issue
- issue comment
- issue document
- heartbeat run
- heartbeat run event
- activity log entry
- approval
- budget policy
- budget incident
- cost event
- agent
- project
- routine, if included

Validation rules:

- citation company id must equal review company id
- referenced record must exist
- referenced record must be visible to the current operator under existing access rules
- citation type must match referenced record type
- material findings must have at least one citation
- recommendations must cite the finding and the underlying evidence
- unsupported material findings become `evidence_gap` findings
- critical evidence failure marks the review version `stale` or `validation_failed`, depending on when the failure is detected
- inaccessible or deleted citations are invalid and must not be silently ignored

### 11.4 LLM Narration

Narration is optional presentation text generated after deterministic findings pass validation.

Rules:

- LLM receives validated finding payloads, not broad raw database dumps
- LLM output is draft-only
- material statements in generated text must map back to validated findings or citations
- invalid narration does not block the structured review from being usable
- invalid narration is stored for debugging only or replaced with deterministic prose
- generated narration must not introduce new facts

### 11.5 Review Actions

Action APIs must support:

- approve/reject governed items
- assign/reassign issue
- create follow-up issue
- pause/resume agent
- accept/dismiss recommendation

Rules:

- action must be company-scoped
- action must require board/operator auth
- action must check existing permissions for the underlying mutation
- action must be idempotent where reasonable
- action must write an activity log entry
- action must record review id, version id, finding id, and recommendation id when present
- high-impact actions must require confirmation in the UI

### 11.6 Observability And Audit Evidence

The minimum observability contract is a structured event log for each weekly review lifecycle. This is the audit spine for proving what was generated, why it passed or failed validation, and what changed after operator action.

Required generation events:

- `generation_started`
- `source_snapshot_captured`
- `findings_computed`
- `citations_validated`
- `adapter_readiness_attached`
- `model_assurance_attached`
- `narration_generated`
- `narration_validation_failed`
- `version_ready`
- `version_validation_failed`
- `generation_failed`
- `version_marked_stale`
- `version_archived`

Every generation event must include:

- company id
- review id, when available
- version id, when available
- actor user id
- event type
- event status
- review period
- source window
- input snapshot counts by entity type
- finding counts by category/severity/status
- citation validation summary
- adapter readiness summary
- model assurance summary
- error code and redacted failure reason when applicable
- created timestamp

Debug metadata rules:

- Persist limited debug metadata only for validation or generation failures.
- Store counts, ids, rule names, validation errors, and redacted excerpts.
- Do not store raw prompts, full LLM responses, secrets, shell env, raw transcripts, signed URLs, blob content, or full work products.
- Failed narration debug records must be useful for diagnosis without becoming a second source of truth.

Probe events:

- adapter readiness probes and model assurance probes must write structured probe records.
- probe records must be company-scoped before a weekly review can cite them.
- instance-level runtime health can be shown live, but it is not review evidence until converted into a company-scoped probe record.

### 11.7 Retention Policy

Retention defaults for MVP:

- Ready weekly review versions are retained indefinitely until a user archives or deletes the company.
- Archived review versions remain readable unless the company is deleted.
- Citation excerpts are retained with the review snapshot and must stay short/redacted.
- Review action records and linked activity log entries are retained with normal activity-log retention.
- Failed generation and validation debug metadata is retained for 30 days.
- Adapter readiness and model assurance probe history is retained for 90 days or the latest 50 probes per agent, whichever keeps more recent useful evidence.
- Instance-level runtime health snapshots are ephemeral unless explicitly persisted as company-scoped probe records.
- Narration validation failure metadata follows the 30-day failed-debug retention rule.

Purge behavior:

- MVP does not need a full retention UI.
- A follow-up maintenance command may prune expired debug/probe records.
- Purge must never remove ready review versions, citations attached to ready versions, review actions, or activity log records.

### 11.8 Rollout Strategy

Implementation should build reusable weekly-review infrastructure and use Northstar as the acceptance fixture. It should not hardcode a Northstar-only path.

Rollout order:

1. Generic schema, shared contracts, and Northstar fixture.
2. Adapter/model readiness foundation.
3. Deterministic finding engine against generic company records.
4. Review generation/versioning/validation API.
5. Weekly Review read UI.
6. Governance actions.
7. Optional narration.
8. QA, security, docs, and release readiness.

Release gates:

- Northstar can seed and generate a ready review.
- The exact eight findings match.
- Adapter/model readiness metadata is visible without changing the eight-finding contract.
- Cross-company access and citation tests pass.
- Debug/probe retention rules are covered by unit tests.
- One CEO journey e2e passes.

## 12. Data Model Proposal

Use additive tables. Final names can follow existing schema conventions, but the model should preserve these concepts.

### `weekly_reviews`

- `id`
- `company_id`
- `period_start`
- `period_end`
- `status`: `draft | ready | archived`
- `latest_version_id`
- `created_by_user_id`
- `created_at`
- `updated_at`

### `weekly_review_versions`

- `id`
- `review_id`
- `company_id`
- `version_number`
- `status`: `generating | draft | validation_failed | ready | stale | archived`
- `generated_at`
- `generated_by_user_id`
- `source_window_start`
- `source_window_end`
- `summary_json`
- `validation_json`
- `narration_status`: `not_requested | generated | validation_failed`
- `narration_text`
- `created_at`
- `updated_at`

### `weekly_review_findings`

- `id`
- `review_id`
- `version_id`
- `company_id`
- `category`
- `severity`
- `status`
- `title`
- `summary`
- `workstream`
- `evidence_ids_json`
- `recommended_action_json`
- `recommendation_text`
- `reason_code`
- `source_entity_type`
- `source_entity_id`
- `confidence`
- `detected_at`
- `validation_status`
- `rules_triggered_json`
- `actor_id`
- `ui_cta_json`
- `metadata_json`
- `created_at`
- `updated_at`

### `weekly_review_citations`

- `id`
- `review_id`
- `version_id`
- `finding_id`
- `company_id`
- `citation_type`
- `entity_type`
- `entity_id`
- `field`
- `label`
- `excerpt`
- `metadata_json`
- `created_at`

`excerpt` must be short and should never store blob content, signed URLs, or raw work-product URLs.

### `weekly_review_recommendations`

- `id`
- `review_id`
- `version_id`
- `finding_id`
- `company_id`
- `kind`
- `severity`
- `state`: `open | accepted | dismissed | completed`
- `title`
- `rationale`
- `proposed_action_json`
- `created_at`
- `updated_at`

### `weekly_review_actions`

- `id`
- `review_id`
- `version_id`
- `finding_id`
- `recommendation_id`
- `company_id`
- `action_kind`
- `status`: `requested | completed | failed`
- `requested_by_user_id`
- `target_entity_type`
- `target_entity_id`
- `request_json`
- `result_json`
- `activity_log_id`
- `created_at`
- `updated_at`

### `weekly_review_events`

- `id`
- `review_id`
- `version_id`
- `company_id`
- `event_type`
- `status`: `started | completed | failed | skipped`
- `actor_user_id`
- `period_start`
- `period_end`
- `source_window_start`
- `source_window_end`
- `input_counts_json`
- `finding_counts_json`
- `citation_validation_json`
- `adapter_readiness_summary_json`
- `model_assurance_summary_json`
- `error_code`
- `failure_reason`
- `debug_metadata_json`
- `expires_at`
- `created_at`

### `adapter_readiness_probes`

Persisted readiness evidence used by weekly reviews must be company-scoped. Instance-wide runtime health can be computed live for settings screens, but it must not be cited by a review until represented as a company-scoped probe record.

- `id`
- `company_id`
- `agent_id`
- `adapter_type`: `claude_local | codex_local | agy_local`
- `status`: `ready | warning | blocked | unknown | not_applicable`
- `basic_ready`
- `operational_ready`
- `fixture_ready`
- `reason_codes_json`
- `cli_version`
- `auth_mode`
- `model`
- `resolved_model`
- `model_source`: `adapter_config | detected | cli_default | provider_default | unknown`
- `model_profile`
- `model_available`
- `model_runnable`
- `model_policy_status`: `approved_default | approved_primary | approved_cheap | approved_fallback | manual_allowed | warning | blocked | unknown`
- `role_fit`: `strong | acceptable | weak | blocked | unknown`
- `role_fit_reason`
- `model_reason_codes_json`
- `model_capabilities_json`
- `workspace_status`
- `quota_windows_json`
- `hello_run_status`
- `hello_run_metadata_json`
- `heartbeat_run_id`
- `fallback_recommendation_json`
- `strict_mode`
- `checked_by_user_id`
- `checked_at`
- `metadata_json`
- `created_at`

Model fields must be populated from the adapter's current model list and profile definitions where available. For adapters that allow manual or provider-default model ids, the probe must distinguish "known available", "manual allowed but not discovered", and "unresolved runtime default".

## 13. API Surface Proposal

All routes use `/api` and existing company access checks.

Read routes:

- `GET /companies/:companyId/weekly-reviews/latest`
- `GET /companies/:companyId/weekly-reviews/:reviewId`
- `GET /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId`
- `GET /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/findings`
- `GET /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/actions`
- `GET /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/adapter-readiness`
- `GET /companies/:companyId/agents/:agentId/adapter-readiness`
- `GET /companies/:companyId/agents/:agentId/model-assurance`
- `GET /runtime-health/local-adapters`

Mutation routes:

- `POST /companies/:companyId/weekly-reviews/generate`
- `POST /companies/:companyId/weekly-reviews/:reviewId/refresh`
- `POST /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/recommendations/:recommendationId/accept`
- `POST /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/recommendations/:recommendationId/dismiss`
- `POST /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/actions/create-follow-up`
- `POST /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/actions/assign-issue`
- `POST /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/actions/pause-agent`
- `POST /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/actions/resume-agent`
- `POST /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/actions/approve`
- `POST /companies/:companyId/weekly-reviews/:reviewId/versions/:versionId/actions/reject`
- `POST /companies/:companyId/agents/:agentId/adapter-readiness/probe`
- `POST /companies/:companyId/agents/:agentId/model-assurance/probe`
- `POST /runtime-health/local-adapters/probe`

API responses should use shared types and validators from `packages/shared`.

## 14. Security Requirements

Security invariants:

- every review table row includes `company_id`
- every route checks company access before reading or mutating
- no agent API-key access in MVP
- citation links enforce the same access checks as underlying records
- mutation routes enforce existing actor permissions
- cross-company citations are invalid
- review action writes are auditable
- LLM narration receives minimized, cited finding payloads
- generated prose cannot introduce uncited facts
- excerpts must not include secrets, signed URLs, raw blob content, or raw work-product URLs
- high-impact actions must be confirmed in UI and logged
- adapter readiness probe responses must not expose API keys, OAuth tokens, shell env secrets, private config files, or raw prompt bodies
- persisted readiness probe records used by reviews must be company-scoped
- runtime fallback recommendations must not mutate adapter configuration until a board/operator action approves the change
- model assurance responses must not expose provider account identifiers beyond safe display labels
- model/profile changes that increase cost, lower evidence quality, or change execution risk require board/operator approval and activity logging
- review event debug metadata must be redacted and bounded
- retention purge must not remove ready review snapshots, review citations, review actions, or linked activity log entries

Threats to explicitly test:

- cross-company citation injection
- stale version action replay
- unsupported generated claim
- action against an entity outside the review company
- agent API-key attempt to read reviews
- citation to deleted or inaccessible record
- recommendation action without matching finding
- cross-company adapter readiness probe citation
- readiness probe secret leakage
- automatic fallback without operator approval
- model downgrade or fallback without operator approval
- stale or unavailable model treated as ready
- debug metadata leaking prompt, transcript, env, credential, URL, or work-product contents
- retention purge deleting audit-critical records

## 15. Local Adapter Assurance

The MVP must treat `claude_local`, `codex_local`, and `agy_local` as first-class local runtime choices. Adapter assurance is part of review trust, but it must not expand the locked eight Northstar business findings.

`agy_local` is the canonical Google local adapter identity for new work. `gemini_local` may appear only as a legacy migration alias while existing saved agents are migrated; Weekly Review MVP certification, readiness probes, model assurance records, seeded Northstar agents, and new UI/API copy must use `agy_local`.

The `agy_local` adapter is backed by Antigravity CLI (`agy`). Its MVP model policy is intentionally narrow: all Google-backed Weekly Review source work resolves to `gemini-3.5-flash`. The MVP does not certify Gemini 2.x, Gemini 3.1, `auto`, or adapter-selected opaque defaults for executive review evidence.

### 15.1 Readiness Levels

`basic_ready` checks whether the adapter can execute at all:

- CLI binary found
- CLI version captured
- auth usable
- configured model available
- workspace/trust state valid
- hello-run succeeds

`operational_ready` checks whether the adapter is safe to use for normal company work:

- quota windows available when the adapter supports quota reporting
- model profiles available
- permission/sandbox mode understood
- session resume support verified when supported
- cancellation behavior verified

`fixture_ready` checks whether the adapter satisfies the Northstar MVP proof:

- at least one Northstar agent is bound to the adapter as specified in the fixture
- at least one successful in-period run exists for the adapter
- review metadata can cite a same-company readiness probe or heartbeat run for the adapter

### 15.2 Status And Reason Codes

UI status:

- `ready`
- `warning`
- `blocked`
- `unknown`
- `not_applicable`

Structured reason codes include:

- `binary_missing`
- `auth_failed`
- `model_missing`
- `workspace_invalid`
- `hello_failed`
- `quota_limited`
- `quota_unknown`
- `resume_unsupported`
- `cancel_unsupported`
- `fixture_binding_missing`
- `fixture_run_missing`

The API should expose both the UI status and booleans for `basicReady`, `operationalReady`, and `fixtureReady`.

### 15.3 Model Assurance

Model assurance verifies that the selected AI model is available, runnable, suitable for the role, and governed. It is evaluated alongside adapter readiness because a valid CLI with an invalid or unsuitable model is not operationally ready.

Model assurance is both adapter-specific and role-specific:

- Adapter-specific: the model must be known by the adapter model list, discovered by the adapter, detected from local config, or explicitly allowed as a manual/provider-default model.
- Role-specific: the model/profile must match the agent's work type: coding, research, governance, operations, finance, summarization, or low-risk utility.

Model statuses:

- `approved_default`: adapter default is acceptable for this role.
- `approved_primary`: explicitly configured primary model is approved for this role.
- `approved_cheap`: cheap/utility profile is approved for bounded low-risk work.
- `approved_fallback`: fallback model is approved, but only after operator approval.
- `manual_allowed`: manual model id is allowed by the adapter but not discovered; readiness should warn unless a hello-run proves it.
- `warning`: model is runnable but role fit, cost, quota, or evidence quality needs attention.
- `blocked`: model is unavailable, cannot run, or is disallowed for the role.
- `unknown`: model cannot be resolved.

Model reason codes include:

- `model_unresolved`
- `model_not_listed`
- `model_detect_failed`
- `model_hello_failed`
- `model_quota_limited`
- `model_profile_missing`
- `cheap_profile_missing`
- `role_fit_weak`
- `cost_policy_warning`
- `cost_policy_blocked`
- `manual_model_unverified`
- `fallback_requires_approval`

Role-fit defaults:

- Coding and implementation work: prefer `codex_local` primary model; cheap profile only for bounded cleanup, summarization, or low-risk utility work.
- Research synthesis and citation validation: prefer `agy_local` with `gemini-3.5-flash`; cheap/utility Google model profiles are out of scope for MVP certification.
- Governance, operations, board-ready writing, and handoff work: prefer `claude_local` primary model; cheap profile only for routine summaries or non-governed low-risk drafting.
- Budget and finance summaries can use cheap profiles when they summarize already-computed values; policy changes, thresholds, or risk interpretation require primary model approval.

Weekly Review model evidence must include:

- selected model and resolved model when available
- model source (`adapter_config`, `detected`, `cli_default`, `provider_default`, or `unknown`)
- selected profile (`primary`, `cheap`, or named profile)
- policy status and role-fit status
- model change events during the review period
- model-related quota or availability warnings
- heartbeat run model metadata when available

Model assurance can appear as a `quality_signal` when it affects operating confidence. It escalates to `evidence_gap` when model evidence is missing for a material claim, and to `decision_blocker` when a model problem materially changes or blocks an executive decision.

### 15.4 Gating Rules

- Failed `basic_ready` blocks execution for that agent/adapter.
- Failed `operational_ready` warns by default and blocks only when strict mode is enabled.
- Failed `fixture_ready` blocks MVP/demo certification but does not block ordinary agent execution.
- If a local adapter is unavailable during Northstar setup, the fixture can still load; certification is partial and identifies the missing adapter.
- `blocked` model assurance blocks execution for that agent/model.
- `warning` model assurance allows execution but prevents MVP/demo certification when the warning affects a Northstar source agent.
- Cheap/utility model profiles must not be used for governed decisions, material citation validation, or final executive recommendations unless explicitly approved for that work type.

### 15.5 Product Surfaces

Agent setup and Agent detail pages show agent-specific readiness:

- current adapter status
- latest probe timestamp
- reason codes
- model/profile status
- model policy and role-fit status
- hello-run status
- action to rerun probe

Instance Settings / Runtime Health shows global local adapter health:

- installed CLI versions
- auth mode status
- quota availability
- runtime warnings
- last successful probe

Weekly Review shows a readiness panel:

- review-specific readiness for source agents
- readiness evidence used for review trust
- selected/resolved model and profile per source agent
- model policy warnings and model-change events
- stale or missing probe warnings
- fixture certification state

Adapter readiness can appear as a `quality_signal` when it affects operational trust. It escalates to `decision_blocker` if it blocks a CEO decision, or `evidence_gap` if readiness evidence is missing or invalid for a material claim.

### 15.6 Fallback Strategy

Fallback is advisory in MVP. Paperclip may recommend a compatible backup adapter or model, but must not silently change runtime behavior.

Initial fallback recommendations:

- `codex_local` can suggest `claude_local` for planning/docs and `agy_local` for research tasks.
- `agy_local` can suggest `claude_local` for synthesis/governance writing.
- `claude_local` can suggest `codex_local` for code-heavy tasks or `agy_local` for research-heavy tasks.

Every accepted fallback must be a board/operator action with an activity log entry.

Initial model fallback rules:

- Prefer same-adapter fallback first when a configured primary model is unavailable and the adapter exposes an approved fallback or cheap profile for the work type.
- Cross-adapter fallback follows the adapter fallback map and requires operator approval.
- Downgrades to cheaper/utility models are allowed only for low-risk work types or after explicit operator approval.
- Upgrades to higher-capability or higher-cost models require operator approval when they change budget posture.

## 16. QA And Acceptance Strategy

The MVP must be acceptance-fixture driven.

### 16.1 Fixture

Create a seeded clean hybrid AI company with deterministic records for:

- completed work
- stale work
- blocked work
- failed run
- budget risk
- missing owner
- missing next action
- pending approval
- dismissed recommendation
- unsupported claim/gap case

The fixture must produce exactly eight findings for the first ready weekly review version:

| Finding ID | Category | Severity | Status | Workstream | Title | Expected action |
|---|---|---|---|---|---|---|
| `NSR-F01` | `decision_blocker` | `critical` | `open` | Operations | Support handoff owner missing blocks broad rollout | Assign Support/Ops Lead owner before broad rollout |
| `NSR-F02` | `action_required` | `high` | `open` | Governance | Approve limited pilot rollout | Approve limited pilot rollout |
| `NSR-F03` | `action_required` | `high` | `open` | Operations | Assign Support/Ops Lead owner | Assign owner to support handoff issue |
| `NSR-F04` | `evidence_gap` | `high` | `open` | Research & Insights | Research brief has one unsupported customer-segment claim | Create research citation-gap follow-up issue |
| `NSR-F05` | `stale_item` | `medium` | `open` | Operations | Operations runbook update is stale and still blocks support handoff | Refresh runbook update or attach current owner/status |
| `NSR-F06` | `budget_signal` | `medium` | `open` | Budget | Budget warning from citation-validation retries and prototype implementation spend | Review budget policy after pilot decision |
| `NSR-F07` | `quality_signal` | `medium` | `open` | Research & Insights | Research summarization run failed validation | Inspect validation failure and rerun after evidence fix |
| `NSR-F08` | `win_context` | `low` | `open` | Product Delivery | Cited weekly inbox digest prototype is ready for limited pilot | Keep as cited context for pilot approval |

The fixture must also preserve lower-priority seeded stale items that do not become first-screen findings:

- Research follow-up survey draft is stale.
- Engineering cleanup task is stale.

These records are used to prove ranking and noise control. They may appear in evidence drilldowns or secondary diagnostics, but the MVP acceptance test expects exactly the eight findings above.

Expected CEO demo actions:

1. Approve limited pilot rollout from `NSR-F02`.
2. Assign Support/Ops Lead owner from `NSR-F03`.
3. Create research citation-gap follow-up issue from `NSR-F04`.
4. Leave the budget policy review from `NSR-F06` open.

Adapter and model readiness fixture requirements:

- Northstar fixture uses `codex_local`, `agy_local`, and `claude_local`.
- Adapter readiness is exposed in review metadata and the readiness panel.
- Adapter readiness does not add or replace any of the exact eight business findings.
- Missing adapter readiness marks fixture certification partial and identifies the failed adapter and reason code.
- Northstar fixture records selected model, resolved model when available, model profile, policy status, and role-fit status for each source agent.
- Model assurance is exposed in review metadata and the readiness panel.
- Model assurance does not add or replace any of the exact eight business findings.
- Missing or blocked model assurance marks fixture certification partial and identifies the agent, adapter, model, and reason code.

Memo requirements:

- The board-ready memo appears below the decision dashboard.
- Memo paragraphs reference validated finding ids rather than relying on exact prose snapshots.
- The memo is factual, restrained, and cannot introduce uncited facts.

### 16.2 Backend Tests

Required tests:

- finding engine computes expected findings from fixture
- first fixture review returns exactly `NSR-F01` through `NSR-F08`
- seeded lower-priority stale items do not create extra first-screen findings
- citations validate existing same-company records
- cross-company citations fail validation
- material findings without citations fail readiness
- generated review version preserves previous version
- refresh creates new version
- generation lifecycle events are recorded with source counts, validation summaries, and failure reasons
- failed generation/debug metadata is redacted and expires after 30 days
- readiness/model probe history retention keeps 90 days or latest 50 probes per agent
- retention purge does not remove ready review versions, citations, actions, or activity logs
- recommendation state transitions are audited
- action endpoints mutate underlying records and write activity logs
- agent API keys cannot access review routes
- adapter readiness probe records are company-scoped before they can be cited by reviews
- failed `basic_ready` blocks agent execution
- failed `operational_ready` warns unless strict mode is enabled
- failed `fixture_ready` blocks MVP/demo certification but not normal execution
- fallback recommendations do not mutate adapter config without operator approval
- model assurance validates adapter model list, selected model, resolved model when available, and role-fit policy
- blocked model assurance blocks execution
- warning model assurance blocks MVP/demo certification only when it affects a Northstar source agent
- model/profile fallback recommendations do not mutate adapter config without operator approval

### 16.3 Frontend Tests

Required tests:

- empty state when no review exists
- generate/refresh states
- ready review renders decision dashboard first
- findings are grouped by decision area with severity badges and workstream labels
- findings show severity/category/status
- citation drilldown renders linked evidence metadata
- validation failed state surfaces gaps
- accept/dismiss recommendation updates UI state
- high-impact action prompts confirmation
- Agent setup/detail readiness states render for `claude_local`, `codex_local`, and `agy_local`
- Agent setup/detail model policy and role-fit states render for source agents
- Instance Settings runtime health shows local adapter probe status
- Weekly Review readiness panel shows source-agent readiness and fixture certification state
- Weekly Review readiness panel shows selected/resolved models, profiles, policy status, and model warnings
- Weekly Review action history shows generation, validation, refresh, and stale/ready lifecycle events

### 16.4 End-to-End Smoke

One CEO journey smoke:

1. Load clean demo company.
2. Open Weekly Review page.
3. Generate review.
4. Confirm ready status.
5. Verify exactly the eight expected fixture findings.
6. Verify readiness panel shows `claude_local`, `codex_local`, and `agy_local` metadata without changing the eight-finding contract.
7. Verify readiness panel shows selected/resolved model and profile metadata for source agents without changing the eight-finding contract.
8. Open citation drilldown for one finding.
9. Create follow-up issue from recommendation.
10. Accept one recommendation.
11. Confirm activity log/action history reflects both actions.

## 17. MVP Acceptance Criteria

The MVP is functional when:

- A clean demo company can be seeded locally.
- A CEO operator can generate a weekly review manually.
- The generated review contains deterministic findings from the fixture.
- The Northstar Labs fixture produces exactly the eight locked findings defined in Section 16.1.
- The Northstar Labs fixture includes `claude_local`, `codex_local`, and `agy_local` readiness metadata without adding adapter-readiness findings.
- The Northstar Labs fixture includes source-agent model assurance metadata without adding model-assurance findings.
- Failed basic local adapter readiness blocks execution; failed operational readiness warns unless strict mode is enabled.
- Blocked model assurance blocks execution; warning model assurance affects certification only when it affects a Northstar source agent.
- Generation lifecycle events are persisted and visible enough to audit each review version.
- Failed debug metadata and probe history follow the retention rules without deleting audit-critical snapshots.
- Every material finding and recommendation has valid same-company citations.
- Unsupported material claims become gaps or validation failures.
- The dedicated Weekly Review page renders the review as a decision dashboard.
- CEO core governance actions work from the review page.
- Every review action writes an activity log and review action record.
- Prior versions remain accessible after refresh.
- `pnpm -r typecheck`, `pnpm test`, and `pnpm build` pass.
- One e2e CEO smoke passes.
- Documentation explains the demo company and weekly review workflow.

## 18. Implementation Waves

### Wave 0: PRD/SPEC And Fixture Contract

Deliverables:

- approve this plan
- treat the seed company shape in this PRD as final for MVP planning
- treat the expected finding list in Section 16.1 as the fixture contract
- treat local adapter readiness as part of fixture certification without adding to the exact eight business findings
- treat model assurance as part of fixture certification without adding to the exact eight business findings
- decide exact route placement and nav label during task-level planning only if existing route conventions require adjustment

Exit criteria:

- PRD/SPEC accepted
- fixture expectations written in test-friendly form

### Wave 1: Database, Shared Types, And Seed Fixture

Deliverables:

- Drizzle schema tables for reviews, versions, findings, citations, recommendations, and actions
- Drizzle schema table for weekly review lifecycle events
- Drizzle schema table for company-scoped adapter readiness probes
- migration
- shared types, validators, API path constants
- seed script or fixture helper for clean hybrid AI company

Exit criteria:

- migration applies locally
- fixture can create deterministic company data
- shared readiness types cover status, reason codes, readiness booleans, and fallback recommendation payloads
- shared model assurance types cover selected/resolved model, model source, model profile, policy status, role fit, and model reason codes
- shared event/retention types cover generation lifecycle events, redacted debug metadata, and expiration timestamps
- typecheck passes for db/shared

### Wave 2: Local Adapter And Model Readiness Foundation

Deliverables:

- readiness probe service for `claude_local`, `codex_local`, and `agy_local`
- model assurance evaluation for `claude_local`, `codex_local`, and `agy_local`
- agent-specific readiness read/probe endpoints
- agent-specific model assurance read/probe endpoints
- instance runtime-health read/probe endpoints
- company-scoped persisted probe records for review evidence
- severity-based execution gating for failed readiness
- advisory fallback recommendation payloads
- advisory model/profile fallback recommendation payloads

Exit criteria:

- failed `basic_ready` blocks execution in tests
- failed `operational_ready` warns unless strict mode is enabled
- failed `fixture_ready` blocks certification only
- blocked model assurance blocks execution in tests
- warning model assurance blocks certification only when it affects a Northstar source agent
- readiness probe responses redact secrets
- model assurance responses do not expose provider account identifiers beyond safe display labels

### Wave 3: Deterministic Finding Engine

Implementation status: implemented locally on May 21, 2026.

Implemented files:

- `server/src/services/weekly-review/finding-engine.ts`
- `server/src/__tests__/weekly-review-finding-engine.test.ts`

Implemented scope:

- pure deterministic snapshot engine for the locked Northstar fixture
- DB-backed company/period snapshot loader for agents, issues, comments, approvals, heartbeat runs, budget incidents, cost events, and adapter readiness probes
- finding drafts, citation drafts, recommendation drafts, citation validation, adapter readiness sidecar metadata, and model assurance sidecar metadata
- cross-company citation rejection and material-finding citation enforcement
- stale-noise suppression so lower-priority stale research/engineering items do not alter the first-screen Northstar finding contract

Deliverables:

- backend service that reads control-plane data for a company and period
- finding categories for decision blockers, actions required, evidence gaps, stale items, budget signals, quality signals, and wins/context
- citation creation
- unit tests against fixture
- review metadata includes local adapter readiness without changing exact fixture finding count
- review metadata includes model assurance without changing exact fixture finding count

Exit criteria:

- expected fixture findings match exactly: `NSR-F01` through `NSR-F08`
- every material finding has citations
- readiness metadata covers `claude_local`, `codex_local`, and `agy_local`
- model metadata covers source-agent selected/resolved models, profiles, policy status, and role fit

### Wave 4: Review Generation, Versioning, And Validation API

Implementation status: backend foundation implemented locally on May 21, 2026.

Implemented files:

- `server/src/services/weekly-review/generation.ts`
- `server/src/routes/weekly-reviews.ts`
- `server/src/__tests__/weekly-review-generation-service.test.ts`
- `server/src/__tests__/weekly-review-routes.test.ts`

Implemented scope:

- board-only generation and refresh API routes
- persisted review versions with ready and validation-failed states
- previous ready version preservation when refresh validation fails
- persisted findings, citations, and recommendations from the deterministic engine
- structured lifecycle events with source counts, validation summaries, and bounded redacted debug metadata for failures
- company-scoped list/detail/version/readiness read endpoints
- readiness read shape that includes adapter readiness, model assurance, and citation validation summaries from the latest ready version

Deliverables:

- generate endpoint
- refresh endpoint
- version persistence
- lifecycle event recording
- retention expiration fields for debug/probe records
- citation validation
- material-claim readiness validation
- read endpoints
- weekly review adapter-readiness read endpoint
- weekly review model-assurance read shape included in readiness response or adjacent endpoint

Exit criteria:

- manual generation produces a ready version for the fixture
- generation records structured lifecycle events
- invalid/cross-company citations fail
- refresh creates a new version without mutating previous versions
- retention tests prove purge candidates exclude audit-critical records

### Wave 5: Weekly Review UI Read Path

Implementation status: read path implemented locally on May 21, 2026.

Implemented scope:

- added the company-scoped `/weekly-review` route and sidebar entry
- added the UI weekly review API client and query keys for list, detail, version, readiness, generate, and refresh calls
- added the latest-review read path with loading, empty, generating, ready, and validation-failed states
- added dashboard metrics for open findings, critical findings, high findings, and evidence gaps
- added grouped finding sections for blockers, actions, gaps, stale items, budget signals, operational signals, and wins/context
- added finding-level citation drilldowns without changing the locked eight-finding generation contract
- added readiness and model-assurance side panels for `claude_local`, `codex_local`, and `agy_local` source evidence, including `gemini-3.5-flash`
- added manual generate and refresh entry points that invalidate weekly review queries after success

Implemented files:

- `ui/src/api/weeklyReviews.ts`
- `ui/src/api/weeklyReviews.test.ts`
- `ui/src/pages/WeeklyReview.tsx`
- `ui/src/pages/WeeklyReview.test.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/Sidebar.test.tsx`
- `ui/src/App.tsx`
- `ui/src/lib/queryKeys.ts`

Verification:

- `pnpm exec vitest run ui/src/api/weeklyReviews.test.ts`
- `pnpm exec vitest run ui/src/components/Sidebar.test.tsx`
- `pnpm exec vitest run ui/src/pages/WeeklyReview.test.tsx`
- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm build`
- `pnpm test`

Note: the first `pnpm test` attempt hit a transient `socket hang up` in `server/src/__tests__/issue-comment-reopen-routes.test.ts` on the active-run cancellation case. The isolated case and full file passed immediately afterward, and the full `pnpm test` rerun completed successfully.

Deliverables:

- company-scoped Weekly Review route and nav entry
- decision dashboard
- findings sections
- citation drilldowns
- review status states
- gaps and validation failure display
- readiness panel showing source-agent adapter readiness and fixture certification state
- model assurance display in the readiness panel

Exit criteria:

- UI tests cover empty, generating, ready, validation failed, and citation states
- dashboard first screen prioritizes decisions and risks
- readiness panel shows all three local adapters without changing the eight-finding contract
- readiness panel shows source-agent model assurance without changing the eight-finding contract

### Wave 6: CEO Governance Actions

Implementation status: first governance-action vertical slice implemented locally on May 21, 2026.

Implemented scope:

- added shared action-kind constants, validators, and exported types for weekly review recommendation actions
- added stricter shared validation for domain-backed governance actions so issue assignment, agent lifecycle, and approval decisions require explicit targets
- exposed weekly review action history on review detail and version read payloads
- added board-only `POST /weekly-review-recommendations/:recommendationId/actions` with company access checked before mutation
- persisted weekly review action records linked to company, review, version, finding, recommendation, target entity, actor, and activity log entry
- implemented recommendation accept and dismiss actions that update recommendation state
- implemented follow-up issue creation from a recommendation, creating a backlog issue and recording the target issue on the action
- implemented issue assignment/reassignment from a weekly review action through the existing issue domain service
- implemented agent pause/resume from a weekly review action through the existing agent domain service; pause also cancels active work through the heartbeat service
- implemented approval approve/reject actions through the existing approval service
- implemented operator fallback and model/profile fallback request recording without mutating adapter config; these actions are stored as approval-required requests
- hardened governance-action audit attribution: action history now stores `requestedByUserId` only for persisted auth users, preserves local implicit board actors in activity log actor fields, and emits action-specific activity names for issue assignment, agent pause/resume, approval decisions, and fallback requests
- added Weekly Review UI recommended-action controls and an action history panel
- hardened stale-queue test cleanup for late runtime skill materialization discovered during broad verification

Implemented files:

- `packages/shared/src/constants.ts`
- `packages/shared/src/types/weekly-review.ts`
- `packages/shared/src/validators/weekly-review.ts`
- `packages/shared/src/validators/weekly-review.test.ts`
- `packages/shared/src/index.ts`
- `server/src/services/weekly-review/actions.ts`
- `server/src/services/weekly-review/generation.ts`
- `server/src/routes/weekly-reviews.ts`
- `server/src/__tests__/weekly-review-actions-service.test.ts`
- `server/src/__tests__/weekly-review-routes.test.ts`
- `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`
- `ui/src/api/weeklyReviews.ts`
- `ui/src/api/weeklyReviews.test.ts`
- `ui/src/pages/WeeklyReview.tsx`
- `ui/src/pages/WeeklyReview.test.tsx`

Verification:

- `pnpm exec vitest run packages/shared/src/validators/weekly-review.test.ts server/src/__tests__/weekly-review-actions-service.test.ts`
- `pnpm exec vitest run packages/shared/src/validators/weekly-review.test.ts server/src/__tests__/weekly-review-routes.test.ts server/src/__tests__/weekly-review-actions-service.test.ts ui/src/api/weeklyReviews.test.ts ui/src/pages/WeeklyReview.test.tsx`
- `pnpm exec vitest run server/src/__tests__/weekly-review-routes.test.ts`
- `pnpm -r typecheck`
- `pnpm build`
- `pnpm exec vitest run server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts -t "does not block execution for fixture-only readiness warnings"`
- `pnpm exec vitest run server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`
- `pnpm exec vitest run server/src/__tests__/weekly-review-actions-service.test.ts`
- `pnpm test`

Note: the first broad `pnpm test` run exposed a stale-queue cleanup race where runtime skill materialization could create `company_skills` rows while a test company was being removed. The cleanup retry now handles that foreign-key race, the focused stale-queue suite passed, and the final full `pnpm test` rerun completed successfully.

Residual scope:

- Weekly Review UI controls for assign/reassign issue, pause/resume agent, and approve/reject governed item are not exposed yet; the backend action execution path is implemented.
- Fallback and model/profile fallback actions intentionally record approval-required requests only; they do not mutate adapter config from the review.
- Frontend audit follow-ups for watchdog decision inputs, recovery resolution notes, and force-release controls are intentionally out of this backend slice and may be handled separately by the Gemini/Antigravity frontend lane.

Deliverables:

- recommendation accept/dismiss
- create follow-up issue
- assign/reassign issue
- pause/resume agent
- approve/reject governed item integration where supported by existing approval APIs
- activity logging and action history
- operator-approved fallback action where supported by existing agent update services
- operator-approved model/profile fallback action where supported by existing agent update services

Exit criteria:

- action APIs enforce company scope and permissions
- UI action controls work and update state
- activity log records link back to review version/finding/recommendation
- fallback recommendations do not mutate adapter config without approval
- model/profile fallback recommendations do not mutate adapter config without approval

### Wave 7: LLM Narration Draft With Validation

Deliverables:

- optional narration generation from validated findings only
- narration validation against finding/citation map
- deterministic fallback prose when validation fails
- debugging metadata for failed narration

Exit criteria:

- generated narration cannot mark a review ready if it introduces uncited material facts
- structured review remains usable when narration fails

Implementation status: deterministic backend narration slice implemented locally on May 21, 2026.

Implemented scope:

- generated deterministic narration text for ready weekly review versions from validated findings with attached citations
- emitted `narration_generated` lifecycle events before `version_ready`
- blocked narration when material citations are invalid and persisted deterministic fallback prose with `narrationStatus: "validation_failed"`
- emitted redacted `narration_validation_failed` debug events for citation and narration failures
- kept invalid refreshes from replacing the previous ready review version, preserving structured review usability

Implemented files:

- `server/src/services/weekly-review/generation.ts`
- `server/src/__tests__/weekly-review-generation-service.test.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/weekly-review-generation-service.test.ts`
- `pnpm exec vitest run server/src/__tests__/weekly-review-routes.test.ts`
- `pnpm -r typecheck`
- `pnpm test`

Residual scope:

- no external LLM provider call is wired in this slice; narration is deterministic and validation-gated
- no frontend narration presentation changes were made to avoid overlapping with the Antigravity frontend lane

### Wave 8: QA, Security Hardening, And Release Readiness

Deliverables:

- e2e CEO smoke
- security tests for cross-company access and citation misuse
- security tests for readiness probe redaction and cross-company probe misuse
- security tests for model assurance redaction and unapproved model fallback
- retention tests for debug/probe expiry and audit-critical record preservation
- docs for demo setup and weekly review workflow
- release-readiness checklist entry

Exit criteria:

- full local verification passes
- smoke proves the CEO journey
- residual risks are documented

Implementation status: backend security hardening and CEO smoke slices implemented locally on May 21, 2026; citation/action company-boundary hardening, readiness/model latest-evidence scoping, and retention-expiry policy coverage completed on May 22, 2026.

Implemented scope:

- added explicit route tests proving unscoped weekly review detail, refresh, readiness, and version routes authorize against company context before loading full payloads or invoking mutations
- added minimal weekly review and version access-context reads so routes can check company access before returning detailed review/version records
- preserved existing company-scoped list/generate routes, agent-key rejection, and recommendation action company checks
- added an opt-in local/e2e Northstar fixture seed endpoint guarded by `PAPERCLIP_ENABLE_NORTHSTAR_FIXTURE_SEED=true`
- hardened the fixture seed route so tests can inject an explicit enabled flag while production/default route construction remains environment-gated and disabled by default
- wired the Playwright e2e server to enable the fixture seed only for the throwaway e2e instance
- seeded a clean Northstar demo company with `claude_local`, `codex_local`, and `agy_local` source agents, including `gemini-3.5-flash` model assurance evidence for the Antigravity-backed research agent
- hardened Northstar fixture follow-up issues so heartbeat cannot dispatch demo-only assigned work before review generation or during live demo idle time
- added a Playwright CEO smoke covering fixture seed, company-prefixed Weekly Review navigation, review generation, all eight locked `NSR-F01` through `NSR-F08` findings, readiness/model evidence, and recommendation action history
- added fixture route coverage proving disabled-by-default `404`, board-only access, no database writes for denied calls, and the `agy_local` / `gemini-3.5-flash` seed contract
- verified a fresh local `~/.paperclip` boot after runtime quarantine, seeded Northstar, generated a ready review, confirmed all eight findings, confirmed `agy_local` / `gemini-3.5-flash` readiness/model evidence, and recorded a completed recommendation action
- hardened weekly review/version payload reads so findings, citations, recommendations, and actions are filtered by both `versionId` and `companyId`, preventing malformed cross-company child rows from leaking through a valid parent review/version
- added malformed-data regression coverage proving review and version detail reads exclude foreign-company finding, citation, recommendation, and action rows even when they point at the same review/version ids
- added governance-action regression coverage proving direct issue assignment, agent pause/resume, and governed approval actions reject targets owned by another company and roll back without action-history writes
- hardened adapter readiness and model assurance latest-evidence reads so a company-scoped request must first prove the target agent belongs to that company before any non-expired probe/model row can be returned, preventing malformed cross-company probe rows from becoming readable evidence
- added explicit retention-expiry policy helpers and unit coverage proving only expired weekly review debug events and adapter readiness probes are purge-eligible, audit-critical review snapshots/citations/actions/activity logs remain excluded, and expired probe rows still retain the latest 50 probes per agent

Implemented files:

- `server/src/routes/weekly-reviews.ts`
- `server/src/routes/weekly-review-fixtures.ts`
- `server/src/services/weekly-review/generation.ts`
- `server/src/__tests__/weekly-review-actions-service.test.ts`
- `server/src/__tests__/weekly-review-fixtures-routes.test.ts`
- `server/src/__tests__/weekly-review-generation-service.test.ts`
- `server/src/__tests__/weekly-review-routes.test.ts`
- `server/src/services/adapter-readiness/index.ts`
- `server/src/services/model-assurance/index.ts`
- `server/src/services/weekly-review/retention.ts`
- `server/src/__tests__/adapter-readiness-service.test.ts`
- `server/src/__tests__/model-assurance-service.test.ts`
- `server/src/__tests__/weekly-review-retention.test.ts`
- `server/src/app.ts`
- `server/src/routes/index.ts`
- `tests/e2e/playwright.config.ts`
- `tests/e2e/weekly-review.spec.ts`

Verification:

- `pnpm exec vitest run server/src/__tests__/weekly-review-generation-service.test.ts server/src/__tests__/weekly-review-actions-service.test.ts server/src/__tests__/weekly-review-routes.test.ts`
- `pnpm exec vitest run server/src/__tests__/weekly-review-fixtures-routes.test.ts`
- `pnpm exec vitest run server/src/__tests__/weekly-review-routes.test.ts`
- `pnpm -r typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm test:run`
- `pnpm exec playwright install chromium`
- `pnpm exec playwright test tests/e2e/weekly-review.spec.ts --config tests/e2e/playwright.config.ts`
- `pnpm exec vitest run server/src/__tests__/adapter-readiness-service.test.ts server/src/__tests__/model-assurance-service.test.ts`
- `pnpm exec vitest run server/src/__tests__/weekly-review-retention.test.ts`
- `pnpm -r typecheck`

Clean runtime evidence captured on May 21, 2026:

- legacy runtime remained preserved at `/Users/giovannytorresadrovet/.paperclip.bak-20260522`
- partial verification homes were preserved at `/Users/giovannytorresadrovet/.paperclip.verify-failed-20260522-2159` and `/Users/giovannytorresadrovet/.paperclip.verify-partial-20260522-2202`
- final fresh `~/.paperclip` boot applied 86 migrations, served `GET /api/health`, and returned an empty company list before fixture seeding
- final seeded company: `Northstar Labs 05d367c7` (`eb4693fd-80f6-45ca-8f4e-e22dcd701e8c`, prefix `NS05D3`)
- final ready review: `b8d46227-fe80-43ad-97d4-e4a01dd44a8a`, latest version `b7a6d056-4ce2-4953-9019-a2f0e007a00b`
- final finding set: `NSR-F01,NSR-F02,NSR-F03,NSR-F04,NSR-F05,NSR-F06,NSR-F07,NSR-F08`
- final action evidence: `accept_recommendation` completed by `local-board`
- final adapter/model evidence: `agy_local` ready with `gemini-3.5-flash`, `codex_local` ready with `gpt-5.3-codex`, and `claude_local` ready with `claude-sonnet-4.5`
- post-heartbeat log check found no `Process adapter missing command`, `heartbeat execution failed`, or demo issue dispatch warnings after the final hardened seed

Clean runtime demo setup:

1. Confirm the legacy runtime remains quarantined at `/Users/giovannytorresadrovet/.paperclip.bak-20260522` and that `~/.paperclip` does not already contain restored legacy state.
2. Confirm Paperclip supervisor cron entries remain commented out before starting the demo runtime.
3. Start the app from this repository with the normal dev command, leaving `DATABASE_URL` unset so the embedded dev database bootstraps into the fresh `~/.paperclip` home.
4. Verify `GET /api/health` and `GET /api/companies` return successfully before seeding the fixture.
5. Seed Northstar only through the opt-in fixture path by starting the e2e/dev process with `PAPERCLIP_ENABLE_NORTHSTAR_FIXTURE_SEED=true`; the route must remain disabled in ordinary runtime startup.
6. Generate the Weekly Review for the seeded Northstar company from the board UI.
7. Confirm all eight locked findings `NSR-F01` through `NSR-F08`, adapter readiness evidence for `claude_local`, `codex_local`, and `agy_local`, and `gemini-3.5-flash` model assurance evidence are visible.
8. Execute one recommendation action from the review and confirm action history updates without leaving the page.

Release-readiness checklist:

- Runtime reset evidence recorded: Antigravity report `paperclip_runtime_quarantine_report.md` confirms crontab supervisors were disabled, Paperclip processes were stopped, and the 62 GB legacy `~/.paperclip` home was moved to `/Users/giovannytorresadrovet/.paperclip.bak-20260522`.
- Clean-start gate: do not claim the demo environment is ready until a fresh `~/.paperclip` boot has been health-checked after the quarantine.
- Fixture gate: the Northstar fixture seed route remains opt-in and board-only; denied calls must not touch the database.
- CEO smoke gate: the Playwright Weekly Review smoke passes against the seeded company and verifies finding, readiness, model, and recommendation-action evidence.
- Quality gate: `pnpm -r typecheck`, `pnpm build`, and `pnpm test` pass before a PR-ready handoff.
- Security gate: company-scoped review/version reads, refreshes, readiness/model latest-evidence reads, recommendation actions, malformed child-payload citation leakage, cross-company action targets, and retention purge eligibility have regression coverage.
- Rollback gate: rollback commands remain available in the Antigravity quarantine report and must be used before restoring the legacy Permisoria state.

Residual scope:

- No known Wave 8 hardening items remain before the next PR-ready full verification and release-readiness sweep.

## 19. Suggested File Ownership

Likely backend files:

- `packages/db/src/schema/weeklyReviews.ts`
- `packages/db/src/schema/index.ts`
- `packages/shared/src/types/adapter-readiness.ts`
- `packages/shared/src/types/model-assurance.ts`
- `packages/shared/src/types/weekly-review.ts`
- `packages/shared/src/validators/adapter-readiness.ts`
- `packages/shared/src/validators/model-assurance.ts`
- `packages/shared/src/validators/weekly-review.ts`
- `server/src/services/weekly-review/*`
- `server/src/services/weekly-review/events.ts`
- `server/src/services/weekly-review/retention.ts`
- `server/src/services/adapter-readiness/*`
- `server/src/services/model-assurance/*`
- `server/src/routes/weekly-reviews.ts`
- `server/src/routes/adapter-readiness.ts`
- `server/src/routes/model-assurance.ts`
- `server/src/__tests__/weekly-review-*.test.ts`
- `server/src/__tests__/weekly-review-retention.test.ts`
- `server/src/__tests__/adapter-readiness-*.test.ts`
- `server/src/__tests__/model-assurance-*.test.ts`

Likely frontend files:

- `ui/src/api/weeklyReviews.ts`
- `ui/src/api/adapterReadiness.ts`
- `ui/src/api/modelAssurance.ts`
- `ui/src/pages/WeeklyReview.tsx`
- `ui/src/pages/WeeklyReview.test.tsx`
- `ui/src/components/weekly-review/*`
- `ui/src/components/adapter-readiness/*`
- `ui/src/components/model-assurance/*`
- navigation/sidebar route registration files

Likely docs:

- `doc/plans/2026-05-21-weekly-executive-operating-review-mvp.md`
- follow-up implementation notes in `doc/DEVELOPING.md` only if setup commands change

## 20. Implementation Planning Decisions

These implementation choices remain for the task-level implementation plan:

1. Exact route registration should follow existing company route conventions; target route remains `/companies/:companyPrefix/weekly-review`.
2. Review findings should use one table with typed `metadata_json` for MVP.
3. Narration validation should use paragraph-level finding references for MVP.
4. Review action APIs should call shared service functions to avoid HTTP-internal coupling.
5. The demo company fixture should start as a test seed helper; a CLI seed command can follow after the acceptance tests are stable.
6. Instance runtime-health probes may be ephemeral, but any readiness evidence cited by a weekly review must be persisted as company-scoped probe evidence.
7. Model assurance should reuse adapter model lists, `detectModel` hooks, and model profile definitions before adding any new provider-specific model registry.

## 21. Risks

- The review becomes a generic report instead of an operating surface.
- LLM narration introduces unsupported confidence.
- Citation volume overwhelms the UI.
- Completeness rules produce noisy findings.
- Action APIs duplicate existing mutation logic.
- Review versions drift from underlying records without clear stale markers.
- Security scope expands if external sources are added too early.
- Adapter readiness checks become noisy or leak local runtime details.
- Automatic fallback hides runtime changes from the operator.
- Model IDs drift as providers rename, add, or remove models.
- Cheap/utility profiles are overused for material decisions.
- Model assurance becomes a second policy engine disconnected from adapter capabilities.
- Lifecycle events become too verbose for operators.
- Retention rules accidentally remove evidence needed for audits.
- A Northstar-first rollout accidentally hardcodes fixture-specific behavior.

Mitigations:

- dashboard leads with decisions and gaps
- deterministic findings are source of truth
- citations are drilldown-first, not always expanded
- fixture includes false-positive controls
- action APIs call shared domain services
- refresh creates explicit new versions
- external sources remain out of MVP
- readiness probe records are redacted and company-scoped before review citation
- fallback remains advisory until a board/operator action approves it
- model assurance reads adapter-owned model metadata and live probe output instead of hardcoding a permanent model catalog
- cheap/utility profile use is bounded by role-fit policy
- model/profile changes that alter cost or risk require operator approval and activity logging
- lifecycle events are summarized in the UI and detailed in drilldowns
- purge logic excludes ready snapshots, citations, actions, and activity logs
- tests must prove the same engine computes Northstar findings from generic company records

## 22. Next Step

After this PRD/SPEC is approved, create a task-level implementation plan that decomposes Waves 1-8 into small TDD steps with exact files, tests, commands, and checkpoints.
