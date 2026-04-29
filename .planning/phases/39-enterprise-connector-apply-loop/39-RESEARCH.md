# Phase 39: Enterprise Connector Apply Loop - Research

**Researched:** 2026-04-29  
**Domain:** RT2 enterprise connector persistence, SSO validation evidence, SCIM preview/apply, audit log, rollout UI  
**Confidence:** HIGH

## User Constraints

Locked Phase 39 decisions require extending the existing enterprise rollout connector surface, not creating a separate identity subsystem. SSO validation must add callback-state evidence and structured failure reasons while staying deterministic in local dev/CI. SCIM preview must become an explicit preview/apply lifecycle with preview ID or fingerprint stale detection, per-candidate apply results, explicit deactivate acknowledgement, rollback-candidate evidence, activity-log linkage, and rollout readiness updates. [VERIFIED: .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md]

Out of scope: full production SSO login, mandatory live IdP calls, broad identity lifecycle management, full reversible rollback automation, cross-company federation, and native/mobile capture. [VERIFIED: .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md]

Project constraints: communicate in Korean for reports, preserve company boundaries, use Express + React/Vite + Drizzle + Postgres/PGlite, leave `DATABASE_URL` unset for local embedded PGlite dev, do not commit `pnpm-lock.yaml`, do not run `pnpm test:e2e` as default verification, and verify with `pnpm typecheck && pnpm test` when implementation is complete. [VERIFIED: AGENTS.md]

## Existing Assets

Phase 20 already established the product shape: SSO metadata validation is operator-visible preflight validation, SCIM preview is read-only, and rollout readiness/audit evidence belongs on the existing enterprise rollout screen. [VERIFIED: .planning/phases/20-enterprise-rollout-connectors/20-CONTEXT.md]

`rt2EnterpriseService` already owns the right service boundary. It has `validateSsoProviderMetadata`, `previewScimSync`, `getRolloutOverview`, `saveRolloutSettings`, and `getRolloutAuditLog`; the current validation/preview functions are deterministic and do not depend on external network calls. [VERIFIED: server/src/services/rt2-enterprise.ts]

`rt2EnterpriseRoutes` already exposes company-scoped routes under `/companies/:companyId/rt2/enterprise/...`, calls `assertCompanyAccess`, and logs rollout actions through `logActivity`. Existing actions are `rt2.rollout.settings_saved`, `rt2.rollout.sso_validated`, and `rt2.rollout.scim_previewed`. [VERIFIED: server/src/routes/rt2-enterprise.ts]

The shared contract file currently defines `Rt2RolloutSsoValidationInput/Result`, `Rt2ScimSyncPreviewInput/Result`, `Rt2EnterpriseRolloutOverview`, evidence/readiness item shapes, and rollout audit entries. Server and UI both consume these shared types. [VERIFIED: packages/shared/src/types/rt2-enterprise.ts; ui/src/api/rt2-enterprise.ts; server/src/services/rt2-enterprise.ts]

The database has enterprise tables for SSO connections, company templates, tenant policies, and binding modes, but no persisted connector evidence, SCIM preview snapshot, SCIM apply run, or rollback-candidate table yet. [VERIFIED: packages/db/src/schema/rt2_enterprise.ts; packages/db/src/migrations/0090_rt2_phase13_enterprise_tables.sql]

`activity_log` is already company-scoped and stores flexible JSON `details`, which is sufficient for action summaries, preview/apply identifiers, failure reasons, and rollback counts. [VERIFIED: packages/db/src/schema/activity_log.ts]

`EnterpriseRolloutPage` already contains the operator surface to extend: SSO metadata form/check rows, SCIM source JSON preview, evidence cards, readiness rows, and recent audit log. It uses React Query mutations and invalidates `queryKeys.rt2Enterprise.rollout(companyId)` after writes. [VERIFIED: ui/src/pages/rt2/EnterpriseRolloutPage.tsx]

Template preview/apply is the closest local implementation pattern for Phase 39: `previewTemplateApplication` calculates per-item actions, `applyTemplateToCompany` reuses the preview, returns per-item `create/skip/error`, and route tests assert preview/apply behavior. [VERIFIED: server/src/services/rt2-template-application.ts; server/src/routes/rt2-template-application.ts; server/src/__tests__/rt2-phase13-enterprise-rollout.test.ts]

## Recommended Technical Approach

Use an append-only, company-scoped connector evidence table as the durable source for both SSO validation evidence and SCIM preview/apply evidence. Do not overload `rt2_sso_connections` with large validation/apply payloads. `rt2_sso_connections` remains connection configuration; connector evidence records become the operational audit/readiness state. [VERIFIED: packages/db/src/schema/rt2_enterprise.ts] [ASSUMED: recommended design]

Add service methods near the existing functions:

- `validateSsoHandshake(companyId, input, options?)`: calls the existing SSO validator, adds callback-state checks, persists evidence, and returns the persisted result. [VERIFIED: server/src/services/rt2-enterprise.ts] [ASSUMED: method name]
- `createScimPreview(companyId, input)`: calls/refactors `previewScimSync`, assigns stable candidate IDs, computes a deterministic fingerprint from normalized users/groups/candidates, persists preview evidence, and returns `previewId` plus `previewFingerprint`. [VERIFIED: server/src/services/rt2-enterprise.ts] [ASSUMED: method name]
- `applyScimPreview(companyId, input)`: loads preview evidence by ID, verifies fingerprint, enforces deactivate acknowledgement, applies selected candidates into connector evidence/apply state, writes per-candidate results and rollback candidates, and returns a persisted apply result. [VERIFIED: .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md] [ASSUMED: method name]

Keep the existing `/sso/validate` and `/scim/preview` paths if possible, but upgrade their responses to include persisted evidence IDs. Add a new `/companies/:companyId/rt2/enterprise/scim/apply` route for apply. This preserves UI/API compatibility while adding the missing operational loop. [VERIFIED: server/src/routes/rt2-enterprise.ts] [ASSUMED: route choice]

Make `GET /rt2/enterprise/rollout` read the latest persisted evidence instead of recomputing SSO validation from active SSO config and instead of returning `scimPreview: null`. SCIM readiness should be `ready` after successful apply, `warning/partial` after partial apply, and `warning/partial` for preview-only evidence. [VERIFIED: server/src/services/rt2-enterprise.ts; .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md]

Do not add live IdP or live SCIM dependencies in the default path. If metadata fetch support is added, inject the fetcher and keep tests on fixture/fake fetchers. [VERIFIED: .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md]

## Data Model/Migration Notes

Recommended migration: add one table, `rt2_enterprise_connector_evidence`, exported from `packages/db/src/schema/rt2_enterprise.ts` and `packages/db/src/schema/index.ts`. [VERIFIED: packages/db/src/schema/index.ts] [ASSUMED: table name]

Suggested columns:

| Column | Purpose |
|--------|---------|
| `id uuid primary key default gen_random_uuid()` | Evidence, preview, or apply identifier. [ASSUMED] |
| `company_id uuid not null references companies(id)` | Mandatory company boundary. [VERIFIED: existing RT2 enterprise tables] |
| `connector_kind text not null` | `sso` or `scim`. [ASSUMED] |
| `evidence_type text not null` | `sso_handshake`, `scim_preview`, `scim_apply`. [ASSUMED] |
| `status text not null` | Validation/apply status such as `pass`, `warning`, `fail`, `applied`, `partial`, `failed`. [ASSUMED] |
| `provider text` | SSO provider or SCIM source label. [ASSUMED] |
| `preview_evidence_id uuid` | Apply-to-preview linkage for stale detection. [ASSUMED] |
| `fingerprint text` | Deterministic normalized payload/preview fingerprint. [ASSUMED] |
| `summary jsonb not null default '{}'::jsonb` | Counts and high-level result. [ASSUMED] |
| `checks jsonb not null default '[]'::jsonb` | SSO validation checks or SCIM validation checks. [ASSUMED] |
| `candidates jsonb not null default '[]'::jsonb` | Preview candidates or per-candidate apply results. [ASSUMED] |
| `rollback_candidates jsonb not null default '[]'::jsonb` | Prior/target state for operator review, not automatic rollback. [ASSUMED] |
| `failure_reasons jsonb not null default '[]'::jsonb` | Structured failure reasons for UI and audit. [ASSUMED] |
| `created_at timestamp with time zone default now()` | Ordering latest evidence. [VERIFIED: existing schema pattern] |
| `applied_at timestamp with time zone` | Non-null for apply evidence. [ASSUMED] |

Indexes should include `(company_id, connector_kind, evidence_type, created_at)` for latest overview lookup and `(company_id, preview_evidence_id)` for apply lookup. This mirrors existing company-indexed schema patterns. [VERIFIED: packages/db/src/schema/rt2_enterprise.ts] [ASSUMED: index set]

The migration should be the next numbered SQL file after `0098_rt2_contradiction_review.sql`. Existing migrations are plain SQL under `packages/db/src/migrations`, while Drizzle schema lives under `packages/db/src/schema`. [VERIFIED: packages/db/src/migrations; packages/db/src/schema]

Prefer JSONB payloads for evidence/candidate detail in Phase 39 because the requirement is audit evidence and readiness surfacing, not query-heavy identity lifecycle management. Normalized user/group state tables can be deferred until a real identity lifecycle phase exists. [VERIFIED: .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md] [ASSUMED: recommended design]

## Route and Service Design

Routes must keep the existing company boundary invariant: extract `companyId`, call `assertCompanyAccess(req, companyId)`, call the enterprise service, write activity log details, then return typed JSON. [VERIFIED: server/src/routes/rt2-enterprise.ts]

Recommended route contract:

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `POST` | `/companies/:companyId/rt2/enterprise/sso/validate` | existing SSO input plus optional `callbackState`/`expectedCallbackState` | persisted SSO validation result with `evidenceId`, `failureReasons`, callback-state checks. [ASSUMED] |
| `POST` | `/companies/:companyId/rt2/enterprise/scim/preview` | existing users/groups payload | preview result with `previewId`, `previewFingerprint`, stable candidate IDs. [ASSUMED] |
| `POST` | `/companies/:companyId/rt2/enterprise/scim/apply` | `previewId`, `previewFingerprint`, selected candidate IDs, `acknowledgeDeactivations` | apply result with per-candidate `applied/skipped/failed/rollbackCandidate`, counts, evidence ID. [ASSUMED] |
| `GET` | `/companies/:companyId/rt2/enterprise/rollout` | none | overview hydrated from latest connector evidence and activity log. [VERIFIED: existing route] |

SSO callback-state validation should be a deterministic check, not a real auth callback. Recommended checks: callback URL is HTTPS and has `/auth/callback` or `/sso/callback`, supplied callback state is non-empty when expected, and expected/actual state match when both are provided. Failure reasons should be structured, for example `{ code: "callback_state_mismatch", message: "..." }`. [VERIFIED: existing callback URL check in server/src/services/rt2-enterprise.ts] [ASSUMED: callback state detail]

SCIM preview should normalize source users/groups before fingerprinting: sort by `kind` and `externalId`, include candidate action/reason/warnings, and hash a stable JSON representation with Node `crypto`. This prevents stale or changed payloads from being silently applied. [VERIFIED: Node crypto is already used in service for X509Certificate] [ASSUMED: fingerprint algorithm]

SCIM apply should not throw away partial success. Return HTTP 200 for a completed apply run even when some candidates fail; encode `status: "partial"` and per-candidate failures in the result. Reserve HTTP 400 for invalid request conditions such as missing preview, stale fingerprint, or missing deactivate acknowledgement. [VERIFIED: template apply returns structured errors; route currently uses 400 for failed template application] [ASSUMED: SCIM status semantics]

Activity log actions should include the Phase 39 actions from context: `rt2.rollout.sso_handshake_validated`, `rt2.rollout.scim_applied`, and optionally `rt2.rollout.scim_apply_partial` or use `rt2.rollout.scim_applied` with `details.status = "partial"`. Add these to `rolloutAuditActions` so overview audit log includes them. [VERIFIED: server/src/services/rt2-enterprise.ts; .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md]

## UI Integration

Extend `EnterpriseRolloutPage`; do not add a separate dashboard. The current page already has SSO validation, SCIM preview, evidence, readiness, and audit sections. [VERIFIED: ui/src/pages/rt2/EnterpriseRolloutPage.tsx; .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md]

Add these UI states:

- SSO evidence: latest `evidenceId`, checked timestamp, callback-state check row, structured failure reasons, and certificate expiry where available. [VERIFIED: current SSO check rendering] [ASSUMED: UI fields]
- SCIM preview: display `previewId`/fingerprint, stable candidate IDs, selection checkboxes, and a visually separate deactivate group. [VERIFIED: current SCIM candidate table] [ASSUMED: UI fields]
- SCIM apply controls: selected candidate count, explicit deactivate acknowledgement checkbox when selected candidates include deactivate, apply button disabled for stale/missing preview or unacknowledged deactivations. [VERIFIED: Phase 39 context D-05/D-10] [ASSUMED: UI behavior]
- Apply result evidence: counts for applied/skipped/failed/rollback candidates, per-candidate rows, failure reasons, rollback candidate table, timestamps, and record IDs. [VERIFIED: Phase 39 context D-10/D-11] [ASSUMED: UI rendering]
- Audit log: continue rendering recent rollout audit entries, but surface action/details summary if available so apply status and rollback count are visible without opening raw JSON. [VERIFIED: current audit log renders action/actor/time only] [ASSUMED: enhancement]

Add `rt2EnterpriseApi.applyScim(companyId, input)` in `ui/src/api/rt2-enterprise.ts`, and update shared imports to use the new request/result types. After validate/preview/apply, invalidate `queryKeys.rt2Enterprise.rollout(companyId)` as the current page already does. [VERIFIED: ui/src/api/rt2-enterprise.ts; ui/src/pages/rt2/EnterpriseRolloutPage.tsx]

Keep UI dense and evidence-forward. Avoid marketing panels or broad explanatory text; the existing screen uses compact cards, badges, check rows, and tables, which matches Phase 39 operator constraints. [VERIFIED: ui/src/pages/rt2/EnterpriseRolloutPage.tsx; .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md]

## Test Strategy

Add embedded Postgres route/service coverage, likely in a new `server/src/__tests__/rt2-phase39-enterprise-connector-apply-loop.test.ts` or by extending the Phase 13 enterprise rollout suite. It must seed a company, exercise persisted SSO validation evidence, SCIM preview evidence, SCIM apply evidence, activity log rows, and rollout overview readiness. [VERIFIED: server/src/__tests__/rt2-phase13-enterprise-rollout.test.ts] [ASSUMED: test file name]

Add fallback route-contract coverage in `server/src/__tests__/rt2-v23-route-fallback.test.ts` or a new fallback suite. The fallback test should mock new service methods and assert route paths, request forwarding, authz boundary, activity log actions, and response shapes without embedded Postgres. [VERIFIED: server/src/__tests__/rt2-v23-route-fallback.test.ts]

Minimum deterministic cases:

| Case | Expected Evidence |
|------|-------------------|
| SSO valid metadata + callback state | persisted `sso_handshake` evidence, action `rt2.rollout.sso_handshake_validated`, readiness SSO pass. [VERIFIED: Phase 39 context] |
| SSO invalid callback state | structured failure reason and readiness fail/warning. [VERIFIED: Phase 39 context] |
| SCIM preview with create/update/deactivate | persisted preview ID/fingerprint and candidate IDs. [VERIFIED: existing preview candidate generation] |
| SCIM apply success | apply evidence, action `rt2.rollout.scim_applied`, SCIM readiness ready. [VERIFIED: Phase 39 context] |
| SCIM apply partial failure | per-candidate failed result, rollback candidates for applied risky changes, readiness partial, activity details include failure counts. [VERIFIED: Phase 39 context] |
| Stale preview fingerprint | HTTP 400, no apply evidence, no success audit action. [VERIFIED: Phase 39 context] |
| Deactivate without acknowledgement | HTTP 400, no apply evidence, failure reason references acknowledgement. [VERIFIED: Phase 39 context] |
| Cross-company/authz route behavior | `assertCompanyAccess` blocks access before service mutation. [VERIFIED: server/src/routes/rt2-enterprise.ts] |

Run `pnpm typecheck && pnpm test` for final verification. Do not use `pnpm test:e2e` as default. If embedded Postgres skips on Windows, document the skip reason and rely on fallback route-contract coverage plus service-level deterministic tests. [VERIFIED: AGENTS.md; .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md; .planning/STATE.md]

## Risks

Persisting only activity-log details would make readiness reconstruction fragile because activity rows are audit events, not a typed connector state store. Use activity log for operator audit and a connector evidence table for latest state. [VERIFIED: activity_log flexible details; Phase 39 requires rollout overview evidence] [ASSUMED: risk assessment]

Recomputing SSO validation in `getRolloutOverview` can produce drift because current code derives validation from active SSO config each time. Phase 39 should show last verified IdP state from persisted evidence. [VERIFIED: server/src/services/rt2-enterprise.ts; Phase 39 D-02]

SCIM deactivate is the highest-risk action. Applying all candidates by default would violate Phase 39 constraints; require selected candidates and explicit deactivation acknowledgement. [VERIFIED: .planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md]

Stale preview bugs are likely if candidate IDs are positional or derived from UI row order. Candidate IDs should be deterministic from `kind`, `externalId`, and action, and apply should verify the preview fingerprint. [VERIFIED: existing preview candidates lack IDs] [ASSUMED: risk assessment]

HTTP status semantics can become misleading for partial apply. Treat partial apply as a completed operation with `status: "partial"` and visible failures; use 4xx for invalid requests only. [ASSUMED: risk assessment]

Adding live network fetch in this phase can make CI flaky and violate local deterministic constraints. Any network behavior must be optional/injected and covered by fixtures. [VERIFIED: Phase 39 D-03/D-15]

## Validation Architecture

`.planning/config.json` is absent, so Nyquist validation should be treated as enabled by default under the GSD research rules. [VERIFIED: filesystem check]

| Property | Value |
|----------|-------|
| Framework | Vitest via `pnpm test`, with `supertest` for Express route tests. [VERIFIED: package.json; existing tests] |
| Embedded DB | `getEmbeddedPostgresTestSupport()` + `startEmbeddedPostgresTestDatabase()` where persistence matters. [VERIFIED: server/src/__tests__/rt2-phase13-enterprise-rollout.test.ts] |
| Fallback route tests | Mock service methods with `vi.mock` to verify contracts without embedded Postgres. [VERIFIED: server/src/__tests__/rt2-v23-route-fallback.test.ts] |
| Quick run command | `pnpm test -- server/src/__tests__/rt2-v23-route-fallback.test.ts server/src/__tests__/rt2-phase13-enterprise-rollout.test.ts` [ASSUMED: Vitest filter support through project test runner] |
| Full suite command | `pnpm typecheck && pnpm test` [VERIFIED: AGENTS.md; package.json] |

Requirement map:

| Requirement | Behavior | Test Type | Automated Command |
|-------------|----------|-----------|-------------------|
| EXT-01 | SSO/OIDC/SAML metadata, callback-state, failure reason, and audit evidence are persisted and surfaced. | Embedded route/service + fallback route contract | `pnpm test -- server/src/__tests__/rt2-phase39-enterprise-connector-apply-loop.test.ts server/src/__tests__/rt2-v23-route-fallback.test.ts` [ASSUMED: new test file] |
| EXT-02 | SCIM preview becomes apply, with per-candidate result, partial failure, rollback candidate, activity log, and readiness evidence. | Embedded route/service + fallback route contract | `pnpm test -- server/src/__tests__/rt2-phase39-enterprise-connector-apply-loop.test.ts server/src/__tests__/rt2-v23-route-fallback.test.ts` [ASSUMED: new test file] |

Wave 0 gaps for planning:

- Add DB schema and migration for connector evidence before embedded persistence tests can pass. [VERIFIED: no current evidence table]
- Add shared types for `evidenceId`, `previewId`, `previewFingerprint`, apply request/result, per-candidate result status, rollback candidates, and structured failure reasons. [VERIFIED: packages/shared/src/types/rt2-enterprise.ts]
- Add fallback mocks for new enterprise service methods before route-contract tests can compile. [VERIFIED: server/src/__tests__/rt2-v23-route-fallback.test.ts]
- Update overview tests because current expected SCIM evidence is always `partial`; Phase 39 should make SCIM `ready` after successful/partial apply evidence. [VERIFIED: server/src/__tests__/rt2-phase13-enterprise-rollout.test.ts; Phase 39 D-08]

## Sources

- `.planning/phases/39-enterprise-connector-apply-loop/39-CONTEXT.md`
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`
- `.planning/PROJECT.md`
- `.planning/phases/20-enterprise-rollout-connectors/20-CONTEXT.md`
- `AGENTS.md`
- `server/src/services/rt2-enterprise.ts`
- `server/src/routes/rt2-enterprise.ts`
- `packages/shared/src/types/rt2-enterprise.ts`
- `packages/db/src/schema/rt2_enterprise.ts`
- `packages/db/src/schema/activity_log.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/migrations/0090_rt2_phase13_enterprise_tables.sql`
- `ui/src/pages/rt2/EnterpriseRolloutPage.tsx`
- `ui/src/api/rt2-enterprise.ts`
- `server/src/__tests__/rt2-phase13-enterprise-rollout.test.ts`
- `server/src/__tests__/rt2-v23-route-fallback.test.ts`
- `server/src/services/rt2-template-application.ts`
- `server/src/routes/rt2-template-application.ts`
- `package.json`

## RESEARCH COMPLETE

Files changed:
- `.planning/phases/39-enterprise-connector-apply-loop/39-RESEARCH.md`
