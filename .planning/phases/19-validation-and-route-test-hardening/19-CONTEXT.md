# Phase 19: Validation and Route Test Hardening - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 19는 v2.2에서 기능 완료 후 남긴 검증 부채만 닫는다. 새 사용자 기능을 추가하지 않고, Phase 14-18의 strict `VALIDATION.md`, embedded Postgres 없이도 실행 가능한 route fallback evidence, 개발기획서 alignment scorecard의 validation 상태 동기화를 만든다.

</domain>

<decisions>
## Implementation Decisions

### Validation Artifact Shape
- **D-01:** Phase 14-18 각각에 `VALIDATION.md`를 추가하고 requirement, implementation evidence, verification command, residual risk를 한 문서에서 추적한다.
- **D-02:** 기존 `VERIFICATION.md`는 삭제하거나 대체하지 않는다. Phase 19는 기존 검증 문서 위에 Nyquist-style strict validation layer를 얹는다.

### Route Test Fallback
- **D-03:** embedded Postgres route suite는 계속 유지하되, host init이 불가능한 Windows 환경에서도 route contract가 실행되는 mock-backed fallback route test를 추가한다.
- **D-04:** fallback test는 service 내부 DB 동작을 검증하지 않고 Express route wiring, auth boundary, response contract, 주요 mutation/preview endpoint를 검증한다.

### Alignment Scorecard Sync
- **D-05:** 개발기획서 alignment scorecard는 단순 `shipped/partial/missing`만 보여주지 않고 `validated`, `tech_debt`, `deferred` 상태를 명시한다.
- **D-06:** v2.2 validation debt 중 Phase 14-18 `VALIDATION.md`와 route fallback은 `validated`로 승격하고, 실제 외부 연동/고급 운영 기능은 v2.3 Phase 20-23의 `deferred` 범위로 남긴다.

### the agent's Discretion
- fallback test 파일 분리 방식, mock fixture 이름, validation 문서 표 구성은 기존 repo 패턴에 맞춰 결정한다.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope
- `.planning/ROADMAP.md` — Phase 19 goal, requirements, success criteria.
- `.planning/REQUIREMENTS.md` — `VALID-01`, `VALID-02`, `VALID-03`.
- `.planning/PROJECT.md` — RT2-first product identity and v2.3 milestone intent.

### v2.2 Evidence
- `.planning/milestones/v2.2-MILESTONE-AUDIT.md` — exact tech debt source for Phase 19.
- `.planning/RETROSPECTIVE.md` — v2.2 lessons about validation artifacts and embedded Postgres skips.
- `.planning/phases/14-daily-kanban-trello-parity/14-VERIFICATION.md` — Phase 14 evidence.
- `.planning/phases/15-identity-shell-hardening/15-VERIFICATION.md` — Phase 15 evidence.
- `.planning/phases/16-trello-based-realtycoon-work-board/16-VERIFICATION.md` — Phase 16 evidence.
- `.planning/phases/17-knowledge-bridge-completion/17-VERIFICATION.md` — Phase 17 evidence and skipped route suite.
- `.planning/phases/18-economy-and-rollout-depth/18-VERIFICATION.md` — Phase 18 evidence and skipped route suites.

### Product Scorecard
- `.planning/DEVPLAN-ALIGNMENT.md` — development-plan alignment score and remaining gap narrative.
- `ui/src/pages/rt2/PlanAlignmentPage.tsx` — in-app alignment scorecard.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `server/src/__tests__/rt2-knowledge-routes.test.ts`: embedded Postgres route suite for Knowledge Bridge.
- `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts`: embedded Postgres route suite for economy/marketplace.
- `server/src/__tests__/rt2-phase13-enterprise-rollout.test.ts`: embedded Postgres route suite for enterprise rollout.
- `ui/src/pages/rt2/PlanAlignmentPage.tsx`: existing scorecard UI can be extended without adding a new route.

### Established Patterns
- Route tests use Express + `supertest` with a synthetic `req.actor`.
- Embedded Postgres suites use `getEmbeddedPostgresTestSupport()` and skip when host init is unsupported.
- Planning docs are phase-scoped under `.planning/phases/{phase}` and written in Korean for user-readable status.

### Integration Points
- Add one non-embedded fallback route test file under `server/src/__tests__`.
- Add `VALIDATION.md` files beside existing Phase 14-18 verification docs.
- Update Plan Alignment UI and markdown scorecard to reflect validation state.

</code_context>

<specifics>
## Specific Ideas

- The fallback route test should not pretend database behavior passed. It should explicitly cover route contract when embedded Postgres is unavailable.
- `tech_debt` should not remain hidden in an archive-only audit; the app scorecard should surface what has been validated and what is deferred.

</specifics>

<deferred>
## Deferred Ideas

- Actual SSO handshake, SCIM sync, Obsidian bidirectional sync, settlement approval, anti-gaming, and Trello advanced parity remain Phase 20-23 scope.

</deferred>

---

*Phase: 19-validation-and-route-test-hardening*
*Context gathered: 2026-04-25*
