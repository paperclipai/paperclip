# Phase 39: Enterprise Connector Apply Loop - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 39 upgrades the existing enterprise rollout connector surface from preview-only SSO/SCIM validation into an auditable operational apply loop. It covers OIDC/SAML metadata and callback-state validation evidence, SCIM user/group preview-to-apply mutation, partial failure and rollback-candidate evidence, activity-log linkage, rollout readiness surfacing, and deterministic route/service tests without external network dependency.

It does not implement full production SSO login, mandatory live IdP calls, broad identity lifecycle management, cross-company federation, or native/mobile capture.

</domain>

<decisions>
## Implementation Decisions

### IdP Handshake Evidence
- **D-01:** Extend the current SSO metadata validation path instead of creating a separate identity subsystem. Validation should continue to accept operator-provided issuer URL, metadata URL, certificate, callback URL, and provider, then add callback state evidence and structured failure reasons.
- **D-02:** Persist validation/apply evidence in RT2 enterprise rollout records or a new company-scoped connector evidence table so `GET /rt2/enterprise/rollout` can show the last verified IdP state without relying only on transient response state.
- **D-03:** Keep network behavior deterministic in local dev and CI. If live metadata fetch support is introduced, it must be optional/injected and tests must use deterministic fixtures or service seams.

### SCIM Preview To Apply
- **D-04:** Promote the existing `previewScimSync` candidate model into an explicit preview/apply lifecycle. Apply should require a preview identifier or preview fingerprint generated from source users/groups so stale or changed payloads cannot be silently applied.
- **D-05:** The apply mutation should produce per-candidate results: applied, skipped, failed, and rollbackCandidate. Deactivate actions remain high-risk and must require explicit operator acknowledgement in the request or candidate selection.
- **D-06:** Phase 39 should store apply results and rollback candidates as audit evidence, not attempt a full reversible identity undo engine. Rollback candidates should include enough prior/target state for operator review in a later phase.

### Activity Log And Readiness
- **D-07:** Add new audit actions alongside the existing rollout actions: `rt2.rollout.sso_handshake_validated`, `rt2.rollout.scim_applied`, and a partial/failure action if useful for filtering. Activity details must include status, summary counts, failure reasons, preview/apply identifiers, and rollback candidate counts.
- **D-08:** The rollout overview readiness should treat SCIM as `ready` only after a successful or partially successful apply with stored evidence. Preview-only SCIM remains `partial`.
- **D-09:** Company boundary remains mandatory: every route uses `assertCompanyAccess`, every stored evidence row includes `companyId`, and tests cover cross-company access or route-level authz behavior where practical.

### Operator Surface
- **D-10:** Extend `EnterpriseRolloutPage` rather than adding a separate dashboard. Operators should see IdP validation evidence, SCIM preview, selected apply candidates, apply result counts, rollback candidates, and recent audit log in the same enterprise rollout workflow.
- **D-11:** UI should stay dense and evidence-forward: status badges, per-check rows, candidate/result tables, failure reasons, timestamps, and record IDs. Avoid explanatory or marketing-style panels.
- **D-12:** Client/server contract changes must live in `packages/shared/src/types/rt2-enterprise.ts` and be consumed by both `server/src/services/rt2-enterprise.ts` and `ui/src/api/rt2-enterprise.ts`.

### Verification
- **D-13:** Add deterministic tests for success, failure, partial failure, rollback-candidate, stale preview, explicit deactivate acknowledgement, activity log, and rollout readiness behavior.
- **D-14:** Preserve the fallback route-contract style from `rt2-v23-route-fallback.test.ts` so connector contracts can be verified without embedded Postgres, and add embedded Postgres service/route coverage where schema persistence is introduced.
- **D-15:** Verification should include `pnpm typecheck && pnpm test`; if embedded Postgres tests skip on the Windows host, document that as an environment constraint and rely on deterministic fallback coverage for the default suite.

### the agent's Discretion
- Exact table/schema shape for persisted connector evidence, as long as it is company-scoped, typed, migration-backed, and visible in rollout overview.
- Whether apply selection is by candidate IDs, explicit candidate list, or approved action groups, as long as stale preview detection and deactivate acknowledgement are enforced.
- Exact wording of operator copy and status labels, provided RealTycoon2 product-facing terminology is preserved.

</decisions>

<specifics>
## Specific Ideas

- Treat Phase 39 as the operational continuation of Phase 20: Phase 20 made SSO/SCIM visible and previewable; Phase 39 makes it persistently auditable and apply-capable.
- SCIM deactivate is the highest-risk action and should be visibly separated from create/update in both API results and UI.
- Partial apply is not an error-only state. It should leave useful evidence: what applied, what failed, why, and what could be rolled back or retried.
- Rollout readiness should answer "can this company safely operate this connector boundary now?" rather than only "does the endpoint exist?"

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product And Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, v2.6 goal, provider-optional deterministic local development constraint, and auditability principles.
- `.planning/REQUIREMENTS.md` - `EXT-01` and `EXT-02` requirements for IdP handshake validation and SCIM preview-to-apply evidence.
- `.planning/ROADMAP.md` - Phase 39 goal and success criteria.
- `.planning/STATE.md` - Current v2.6 planning state and deferred connector/autonomy boundaries.

### Prior Phase Context
- `.planning/phases/20-enterprise-rollout-connectors/20-CONTEXT.md` - Existing decisions for SSO metadata validation, SCIM preview, rollout readiness, and audit log.
- `.planning/phases/20-enterprise-rollout-connectors/20-01-SUMMARY.md` - Actual Phase 20 delivered behavior and verification evidence.
- `.planning/phases/13-enterprise-rollout-and-rt2-terminology/13-CONTEXT.md` - Enterprise rollout and RT2 terminology baseline.
- `.planning/phases/13-enterprise-rollout-and-rt2-terminology/13-01-SUMMARY.md` - Existing rollout settings, template apply, and enterprise route evidence.

### Existing Code Evidence
- `server/src/services/rt2-enterprise.ts` - Current SSO validation, SCIM preview, rollout overview, readiness, and audit-log aggregation.
- `server/src/routes/rt2-enterprise.ts` - Company-scoped enterprise rollout routes and existing validation/preview audit writes.
- `packages/shared/src/types/rt2-enterprise.ts` - Shared rollout, validation, SCIM preview, readiness, and audit entry API contract.
- `packages/db/src/schema/rt2_enterprise.ts` - Existing enterprise SSO/template/policy/binding schema to extend or complement.
- `packages/db/src/schema/activity_log.ts` - Company-scoped activity log used for rollout audit evidence.
- `ui/src/pages/rt2/EnterpriseRolloutPage.tsx` - Existing operator rollout UI to extend with apply evidence and rollback candidates.
- `ui/src/api/rt2-enterprise.ts` - Existing UI API client methods for rollout, SSO validation, and SCIM preview.
- `server/src/__tests__/rt2-phase13-enterprise-rollout.test.ts` - Embedded Postgres enterprise rollout route and template apply coverage.
- `server/src/__tests__/rt2-v23-route-fallback.test.ts` - Deterministic fallback route-contract coverage for enterprise rollout without embedded Postgres.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2EnterpriseService.validateSsoProviderMetadata` already returns structured validation checks, warnings, certificate expiry, callback URL validation, and status.
- `rt2EnterpriseService.previewScimSync` already creates user/group candidates with create/update/deactivate actions, warnings, summaries, and checked timestamps.
- `rt2EnterpriseService.getRolloutOverview` already aggregates SSO, SCIM, template, binding, policy readiness and recent rollout audit log.
- `rt2EnterpriseRoutes` already exposes company-scoped rollout, SSO validate, and SCIM preview endpoints with `assertCompanyAccess` and `logActivity`.
- `EnterpriseRolloutPage` already has operator controls for SSO metadata validation, SCIM source JSON preview, rollout readiness, evidence cards, and audit records.

### Established Patterns
- RT2 enterprise API paths live under `/companies/:companyId/rt2/enterprise/...`.
- Product-facing UI copy should say RealTycoon2/RT2 and "enterprise rollout" concepts, while internal package names can remain Paperclip-derived.
- Shared contracts are exported through `@paperclipai/shared`, with server and UI consuming the same types.
- Route tests use both embedded Postgres where persistence matters and mocked fallback route-contract tests where host support is unreliable.
- Activity log entries are the accepted audit mechanism for company-scoped operator actions.

### Integration Points
- Add or extend DB schema for connector validation/apply evidence and rollback candidates.
- Add service methods near `validateSsoProviderMetadata` and `previewScimSync` for persisted handshake evidence, SCIM preview persistence/fingerprint, and SCIM apply.
- Add route methods under `server/src/routes/rt2-enterprise.ts`, likely `/sso/handshake/validate`, `/scim/preview`, and `/scim/apply` or a compatible extension of existing paths.
- Extend shared types for persisted evidence, preview IDs/fingerprints, apply request/result, per-candidate results, and readiness evidence.
- Extend `EnterpriseRolloutPage` and `rt2EnterpriseApi` to run apply, render apply results, show rollback candidates, and refresh rollout overview.

</code_context>

<deferred>
## Deferred Ideas

- Full production SSO login runtime integration remains outside Phase 39.
- Mandatory live IdP metadata fetch or live SCIM provider dependency remains out of scope; deterministic fixtures must be enough for default verification.
- Full reversible identity rollback automation is deferred; Phase 39 records rollback candidates and evidence.
- Trusted local knowledge bridge, Slack/Teams/native/mobile capture, Jarvis autonomy eval guardrails, and validation debt closure belong to Phase 40-43.

</deferred>

---

*Phase: 39-enterprise-connector-apply-loop*
*Context gathered: 2026-04-29*
