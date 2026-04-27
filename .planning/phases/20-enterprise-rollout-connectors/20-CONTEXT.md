# Phase 20: Enterprise Rollout Connectors - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 20은 enterprise rollout 화면을 단순 saved setting preview에서 검증 가능한 SSO/SCIM/provider 운영 흐름으로 확장한다. 구현은 RealTycoon2 product surface 기준이며, SSO/SCIM은 외부 시스템을 실제 호출하기 전 operator가 적용 가능성과 위험을 확인하는 connector validation layer로 다룬다.

</domain>

<decisions>
## Implementation Decisions

### SSO Metadata Validation
- **D-01:** SSO provider metadata는 issuer URL, metadata URL, certificate expiry, callback URL을 각각 독립 check로 표시한다.
- **D-02:** certificate는 raw PEM/text 입력을 허용하고, 만료일 파싱이 가능하면 expiry를 보여준다. 파싱 불가 또는 누락은 위험 경고로 표시한다.
- **D-03:** 실제 IdP network handshake는 이번 phase 범위가 아니며, operator-visible preflight validation으로 제한한다.

### SCIM Sync Preview
- **D-04:** SCIM preview는 source user/group payload를 받아 create/update/deactivate 후보와 risk warning을 산출한다.
- **D-05:** preview 결과는 적용 전에 확인하는 read-only 계획 객체이며, 실제 user/group mutation은 후속 운영 단계로 미룬다.

### Rollout Readiness And Audit
- **D-06:** readiness는 SSO, SCIM, binding, policy를 한 화면에서 보여주고 각 항목의 validation check와 warning을 포함한다.
- **D-07:** 중요한 rollout save, SSO validation, SCIM preview 시도는 기존 `activity_log` 기반 audit entry로 남긴다.

### the agent's Discretion
- UI 배치는 기존 `EnterpriseRolloutPage`의 card-based operator 화면을 유지하면서 검증 패널을 추가한다.
- 검증 결과 type은 shared RT2 enterprise contract에 포함해 server/UI drift를 막는다.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Planning
- `.planning/ROADMAP.md` - Phase 20 goal, requirements, success criteria.
- `.planning/REQUIREMENTS.md` - `ENT-02`, `ENT-03`, `ENT-04` acceptance scope.
- `.planning/STATE.md` - v2.3 sequence and Phase 19 validation context.
- `.planning/PROJECT.md` - RealTycoon2 identity, operational rollout goal, constraints.
- `.planning/phases/19-validation-and-route-test-hardening/19-01-SUMMARY.md` - fallback route validation baseline and remaining Phase 20 scope.

### Code
- `server/src/services/rt2-enterprise.ts` - enterprise rollout service and evidence assembly.
- `server/src/routes/rt2-enterprise.ts` - rollout API routes and authz boundary.
- `ui/src/pages/rt2/EnterpriseRolloutPage.tsx` - operator rollout UI.
- `ui/src/api/rt2-enterprise.ts` - UI API client.
- `packages/shared/src/types/rt2-enterprise.ts` - shared rollout API contract.
- `server/src/services/activity-log.ts` - audit log writer.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2EnterpriseService.getRolloutOverview` already builds SSO/template/binding/policy evidence and should be expanded rather than replaced.
- `activity_log` and `logActivity` already provide company-scoped audit entries suitable for rollout validation attempts.
- Existing `EnterpriseRolloutPage` already hydrates saved SSO, binding, policy, and template values from overview.

### Established Patterns
- Routes enforce `assertCompanyAccess(req, companyId)` before company-scoped rollout operations.
- UI uses React Query mutations plus `queryKeys.rt2Enterprise.rollout(companyId)` invalidation after changes.
- Shared API response types are exported from `@paperclipai/shared` even though product-facing copy remains RealTycoon2.

### Integration Points
- Add SSO validation and SCIM preview methods to `rt2EnterpriseService`.
- Add validation/preview endpoints under `/companies/:companyId/rt2/enterprise/...`.
- Extend `Rt2EnterpriseRolloutOverview` with readiness, last validation/preview, and audit log summaries.

</code_context>

<specifics>
## Specific Ideas

- Operator should see why readiness is not complete, not just a partial/missing badge.
- SCIM preview should be explicit about deactivate candidates because that is the highest-risk sync action.
- Audit log should be visible in the same rollout screen so validation attempts are reviewable.

</specifics>

<deferred>
## Deferred Ideas

- Real IdP metadata fetch and live SCIM connector mutation are not in Phase 20.
- Full SSO login runtime integration is outside this phase; this phase validates rollout readiness.

</deferred>

---

*Phase: 20-enterprise-rollout-connectors*
*Context gathered: 2026-04-25*
