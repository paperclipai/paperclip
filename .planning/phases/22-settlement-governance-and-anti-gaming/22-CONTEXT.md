# Phase 22: Settlement Governance and Anti-Gaming - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 22는 기존 P&L/coin ledger evidence를 실제 승인 가능한 settlement governance로 확장한다. 새 marketplace나 public economy를 만들지 않고, 산출물 단위 가격 제안, 협상 코멘트, 승인/반려, anti-gaming signal, gold/P&L/audit 반영을 하나의 운영 흐름으로 묶는다.

</domain>

<decisions>
## Implementation Decisions

### Settlement Flow
- **D-01:** settlement는 approved deliverable 단위로 생성하며 worker/approver가 가격 제안, 산정 근거, 협상 코멘트, 승인 상태를 한 화면에서 본다.
- **D-02:** 승인 시에만 `rt2_coin_ledger`와 `rt2_personal_pnl`에 반영한다. 반려는 ledger를 만들지 않고 decision reason과 audit log를 남긴다.
- **D-03:** 고가 settlement 또는 위험 signal이 있는 settlement는 `approval_required` 상태와 approval gate reason을 갖는다.

### Anti-Gaming
- **D-04:** Phase 22의 anti-gaming signal은 반복 self-review, 비정상 gold farming, 품질 점수 편향을 우선 제공한다.
- **D-05:** signal은 settlement 검토 화면에 노출되고, 승인/반려 결정 시 사용 여부를 감사 가능한 row로 남긴다.
- **D-06:** signal은 자동 처벌이 아니라 approver decision support다. penalty automation은 후속 phase로 둔다.

### the agent's Discretion
- UI는 기존 P&L 화면에 settlement governance section을 붙여 worker/approver flow를 분리하지 않는다.
- threshold는 운영 기본값으로 시작한다: high-value는 1,000G 이상, gold farming은 월 earned ledger count/total 이상치, quality bias는 auto-approved 98점 이상이다.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Milestone
- `.planning/ROADMAP.md` — Phase 22 목표와 성공 기준.
- `.planning/REQUIREMENTS.md` — `ECON-02`, `ECON-03`, `ECON-04` 수용 기준.
- `.planning/PROJECT.md` — v2.3 milestone 방향과 RealTycoon2-first identity.
- `.planning/DEVPLAN-ALIGNMENT.md` — Economy/P&L remaining gap.
- `AGENTS.md` — RealTycoon2 business truth, approval/audit, Paperclip engine-only policy.

### Prior Phase Context
- `.planning/phases/07-amoeba-economy-collaboration-and-marketplace/07-CONTEXT.md` — ledger-backed economy baseline.
- `.planning/phases/18-economy-and-rollout-depth/18-CONTEXT.md` — economy evidence and P&L basis decisions.
- `.planning/phases/18-economy-and-rollout-depth/18-VALIDATION.md` — Phase 18 residual risk that Phase 22 closes.
- `.planning/phases/21-obsidian-bidirectional-knowledge-sync/21-01-SUMMARY.md` — approved-change/audit pattern from Phase 21.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `server/src/services/rt2-personal-pnl.ts` — approved deliverable evidence, P&L materialization, coin ledger write path.
- `server/src/routes/rt2-personal-pnl.ts` — company-scoped P&L endpoints and authz.
- `ui/src/pages/rt2/PnlPage.tsx` — operator-facing P&L evidence page.
- `server/src/services/activity-log.ts` — mutation audit log helper.

### Established Patterns
- RT2 economy data remains company-scoped and ledger-backed.
- Important mutations log activity entries.
- UI uses React Query API clients and existing border-card sections.

### Integration Points
- `GET /companies/:companyId/rt2/pnl/settlements`
- `POST /companies/:companyId/rt2/pnl/settlements/:settlementId/comment`
- `POST /companies/:companyId/rt2/pnl/settlements/:settlementId/approve`
- `POST /companies/:companyId/rt2/pnl/settlements/:settlementId/reject`

</code_context>

<specifics>
## Specific Ideas

- Worker가 산출물 가격 제안과 근거를 보고 협상 코멘트를 남길 수 있어야 한다.
- Approver는 승인/반려와 동시에 gold ledger/P&L/audit 결과를 확인할 수 있어야 한다.
- Anti-gaming은 숫자 뒤에 숨지 않고 settlement decision 근거로 보인다.

</specifics>

<deferred>
## Deferred Ideas

- 자동 penalty, reputation demotion, fraud case workflow.
- company별 configurable anti-gaming threshold UI.
- external HR/payroll settlement export.

</deferred>

---

*Phase: 22-settlement-governance-and-anti-gaming*
*Context gathered: 2026-04-25*
