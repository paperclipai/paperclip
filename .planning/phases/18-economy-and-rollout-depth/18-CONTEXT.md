# Phase 18: Economy and Rollout Depth - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 18은 v2.2의 마지막 구현 Phase다. 범위는 marketplace/P&L/enterprise rollout을 새 제품 영역으로 넓히는 것이 아니라, 이미 존재하는 RealTycoon2 경제/rollout 표면이 실제 저장값과 산정 근거를 운영자가 검수할 수 있게 만드는 것이다.

</domain>

<decisions>
## Implementation Decisions

### Economy Evidence
- **D-01:** P&L은 approved deliverable, quality score, coin ledger, participant split에서 산정 근거를 표시한다.
- **D-02:** Marketplace listing은 가격/품질/기준가/gold estimate/평판/collaboration multiplier/subscription demand를 한 번에 보여준다.
- **D-03:** 경제 데이터는 새 임의 계산식이 아니라 기존 `rt2_personal_pnl`, `rt2_coin_ledger`, `issue_work_products`, `rt2_quality_scores`, `rt2_collaboration_rewards`의 증거를 연결한다.

### Rollout Evidence
- **D-04:** Enterprise rollout은 SSO, template, binding mode, policy default 각각에 `ready/partial/missing` evidence status를 붙인다.
- **D-05:** 저장된 실제 설정값을 form에 다시 hydrate해 운영자가 현재 적용값을 보고 수정할 수 있게 한다.
- **D-06:** 실제 SSO handshake/SCIM/native distribution은 이번 Phase 밖이다. 이번 Phase는 운영 검수 가능한 saved configuration과 preview/apply evidence에 집중한다.

### the agent's Discretion
- Evidence badge와 warning copy는 기존 RT2 card/form 스타일 안에서 최소 UI로 구현한다.
- Embedded Postgres가 이 호스트에서 skip될 가능성이 있으므로 typecheck를 강한 검증 축으로 두고, route tests는 collection/skip 여부까지 기록한다.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Milestone
- `.planning/ROADMAP.md` — Phase 18 목표와 성공 기준.
- `.planning/REQUIREMENTS.md` — `ECON-01`, `ENT-01` 수용 기준.
- `.planning/PROJECT.md` — RealTycoon2-first identity와 v2.2 목표.
- `.planning/DEVPLAN-ALIGNMENT.md` — 남은 큰 gap이 marketplace/P&L depth와 enterprise rollout임을 기록.
- `AGENTS.md` — Paperclip/Multica engine-only policy, RealTycoon2 naming, verification rules.

### Prior Phase Context
- `.planning/phases/07-amoeba-economy-collaboration-and-marketplace/07-CONTEXT.md` — economy/marketplace baseline.
- `.planning/phases/13-enterprise-rollout-and-rt2-terminology/13-CONTEXT.md` — rollout baseline과 out-of-scope handshake 경계.
- `.planning/phases/15-identity-shell-hardening/15-CONTEXT.md` — product-facing identity hardening.
- `.planning/phases/16-trello-based-realtycoon-work-board/16-CONTEXT.md` — RealTycoon2 frontend identity 기준.
- `.planning/phases/17-knowledge-bridge-completion/17-CONTEXT.md` — evidence status를 operator workflow로 노출하는 패턴.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `server/src/services/rt2-personal-pnl.ts` — approved deliverable revenue, actor P&L, coin ledger drilldown이 이미 있다.
- `server/src/services/rt2-agent-marketplace.ts` — listing evidence에 quality/reputation/subscription data를 붙이는 mapper가 있다.
- `server/src/services/rt2-enterprise.ts` — SSO/template/policy/binding overview와 save path가 있다.
- `ui/src/pages/rt2/PnlPage.tsx`, `MarketplacePage.tsx`, `EnterpriseRolloutPage.tsx` — Phase 18의 운영자-facing 표면이다.

### Established Patterns
- RT2 화면은 company-scoped route와 React Query API client를 통해 server route를 읽는다.
- Rollout template apply는 preview가 먼저이며 irreversible apply 전에 action 객체를 보여준다.
- 경제 settlement는 ledger-backed이며 manual fake data 대신 persisted evidence를 표시한다.

### Integration Points
- `GET /companies/:companyId/rt2/pnl/summary`
- `GET /companies/:companyId/rt2/pnl/drilldown/:actorId`
- `GET /companies/:companyId/rt2/marketplace/agents`
- `GET/POST /companies/:companyId/rt2/enterprise/rollout`
- `GET/POST /companies/:companyId/rt2/templates/:templateId/(preview|apply)`

</code_context>

<specifics>
## Specific Ideas

- 사용자가 불안해한 "본체 Paperclip + RealTycoon 장식" 느낌이 나지 않도록, UI copy는 RealTycoon2/Jarvis/산출물/금화/운영 검수 중심으로 유지한다.
- 운영자는 한 화면에서 숫자뿐 아니라 "이 숫자가 어떤 테이블/산출물/품질 승인/ledger entry에서 왔는지"를 확인할 수 있어야 한다.

</specifics>

<deferred>
## Deferred Ideas

- 실제 SSO handshake, SCIM sync, provider metadata validation.
- 가격 협상, settlement approval workflow, anti-gaming/reputation 심화.
- public marketplace ecosystem과 native mobile rollout.

</deferred>

---

*Phase: 18-economy-and-rollout-depth*
*Context gathered: 2026-04-25*
