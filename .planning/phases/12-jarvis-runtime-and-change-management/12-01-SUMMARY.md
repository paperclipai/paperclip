# Phase 12 Summary: Jarvis Runtime and Change Management

**Status:** Complete  
**Completed:** 2026-04-25  
**Scope:** v2.1 정식 Phase 12 전체  
**Requirements:** `JARVIS-01`, `JARVIS-02`, `JARVIS-03`, `JARVIS-04`

## 완료 내용

- Jarvis 품질평가 manager review queue를 추가했다.
  - Shadow/Co-Pilot/Auto mode, score, expected gold delta, policy band, rationale, manager decision, task/deliverable evidence를 반환한다.
  - manager approve/reject action으로 `rt2_quality_scores`를 finalize한다.

- Auto policy boundary를 명시했다.
  - base price와 threshold band로 `auto_approved`, `requires_copilot`, `record_only`를 판단한다.
  - `auto-evaluate` 응답에 `policyDecision`을 포함한다.

- expected deliverable 기반 reverse-design task proposal을 추가했다.
  - Jarvis가 산출물에서 task와 suggested to-do를 제안한다.
  - rationale/evidence는 `rt2_reverse_design_runs`에 남긴다.

- runtime skill injection을 governed Jarvis capability로 노출했다.
  - skill capability 생성 시 `rt2_runtime_skill_injections`와 `jarvis_skill_capability` approval request를 함께 만든다.
  - Governance UI에서 capability status와 approval status를 볼 수 있다.

- DB migration을 보강했다.
  - `0073_rt2_phase12_jarvis_runtime_tables.sql` 추가.
  - migration journal 업데이트.

## 주요 파일

- `packages/shared/src/types/rt2-governance.ts`
- `server/src/services/rt2-auto-evaluation.ts`
- `server/src/routes/rt2-auto-evaluation.ts`
- `server/src/services/rt2-advanced-ai.ts`
- `server/src/routes/rt2-advanced-ai.ts`
- `ui/src/api/rt2-jarvis-runtime.ts`
- `ui/src/components/Rt2QualityPanel.tsx`
- `ui/src/components/Rt2GovernancePanel.tsx`
- `server/src/__tests__/rt2-phase6-intelligence.test.ts`
- `packages/db/src/migrations/0073_rt2_phase12_jarvis_runtime_tables.sql`

## 검증

- `pnpm --filter @paperclipai/db run check:migrations` 통과.
- `pnpm --filter @paperclipai/shared typecheck` 통과.
- `pnpm --filter @paperclipai/server typecheck` 통과.
- `pnpm --filter @paperclipai/ui typecheck` 통과.
- `pnpm exec vitest run server/src/__tests__/rt2-phase6-intelligence.test.ts` 통과.

## 참고

- Vitest는 Windows sandbox 안에서 `spawn EPERM`으로 실패해서 승인된 sandbox 밖 실행으로 검증했다.
- reverse-designed proposal을 실제 Task 생성까지 자동 연결하는 것은 이번 Phase 범위 밖으로 남겼다.
