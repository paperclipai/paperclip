# Phase 13: Enterprise Rollout and RT2 Terminology - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 13은 v2.1의 마지막 정식 Phase로, enterprise setup을 운영자가 이해할 수 있는 RT2 용어의 화면으로 묶고, portable company template 적용 전에 생성/스킵/오류 객체를 preview하게 하며, 제품-facing 표면에서 Paperclip-first label 누수를 줄인다. 기존 infrastructure/package 이름은 compatibility layer로 보존할 수 있다.

</domain>

<decisions>
## Implementation Decisions

### RT2 rollout 화면
- **D-01:** `CompanySettings`에 더 섞지 않고 company-scoped RT2 route `enterprise-rollout`을 추가한다.
- **D-02:** 화면은 SSO, template, binding/access mode, policy default를 한 페이지에서 설정한다.
- **D-03:** 기존 `rt2-enterprise` schema/service를 재사용하고, 부족한 combined overview/save endpoint만 추가한다.

### Template preview/apply
- **D-04:** template preview는 단순 count가 아니라 `create`, `skip`, `error` action을 가진 객체 목록을 반환한다.
- **D-05:** apply는 preview와 같은 객체 구조를 반환하고, 실제 생성된 항목에는 `createdId`를 포함한다.
- **D-06:** 현재 apply path가 materialize하지 않는 skill, department, agent config는 preview에서 `skip`으로 명시한다.

### Terminology cleanup
- **D-07:** product-facing RT2 navigation에는 `Rollout`을 추가하고, Plan Map에서 enterprise 영역을 Phase 13 shipped로 갱신한다.
- **D-08:** package name, import path, plugin bridge, internal env variable처럼 compatibility가 필요한 `paperclip` 문자열은 이번 Phase에서 무리하게 변경하지 않는다.

### the agent's Discretion
- SSO provider validation과 실제 identity provider handshake는 future scope로 두고, 이번 Phase는 설정/표시/감사 가능한 rollout surface에 집중한다.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone scope
- `.planning/REQUIREMENTS.md` — `ENT-01`, `ENT-02`, `ENT-03` acceptance boundary.
- `.planning/ROADMAP.md` — Phase 13 목표와 v2.1 완료 기준.
- `.planning/DEVPLAN-ALIGNMENT.md` — 개발기획서 gap audit 기준선.

### Product identity
- `AGENTS.md` — RealTycoon2-first identity, Paperclip reference boundary, Korean GSD docs rule.
- `.planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md` — Paperclip boundary and RT2 shell decisions.
- `.planning/phases/08-dev-plan-alignment-baseline/08-CONTEXT.md` — development plan alignment wording policy.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `server/src/services/rt2-enterprise.ts` — SSO, company template, tenant policy, binding mode primitives already exist.
- `server/src/services/rt2-template-application.ts` — template preview/apply path already exists but only returned counts/IDs.
- `ui/src/pages/rt2/PlanAlignmentPage.tsx` — adoption checklist already exposes enterprise gap.
- `ui/src/components/Sidebar.tsx` and `ui/src/App.tsx` — RT2 navigation and company-prefixed routes are the right integration points.

### Established Patterns
- RT2 pages are company-scoped under `/:companyPrefix/...`.
- Shared contracts live in `packages/shared/src/types`.
- DB schema additions need migration SQL and `_journal.json` entry.

### Integration Points
- Add `GET/POST /companies/:companyId/rt2/enterprise/rollout`.
- Strengthen `GET/POST /companies/:companyId/rt2/templates/:templateId/(preview|apply)`.
- Add `ui/src/pages/rt2/EnterpriseRolloutPage.tsx` and `ui/src/api/rt2-enterprise.ts`.

</code_context>

<specifics>
## Specific Ideas

- 사용자가 읽는 planning/status Markdown은 한국어로 작성한다.
- `--auto --chain`이므로 discussion에서 멈추지 않고 plan과 execute를 같은 Phase 안에서 이어간다.

</specifics>

<deferred>
## Deferred Ideas

- 실제 SSO handshake, SCIM sync, provider metadata validation.
- native mobile rollout.
- public marketplace 밖의 template ecosystem.

</deferred>

---

*Phase: 13-enterprise-rollout-and-rt2-terminology*
*Context gathered: 2026-04-25*
