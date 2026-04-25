# Phase 9 요약: Friction-Zero Capture Surfaces

**완료일:** 2026-04-25  
**상태:** 완료

## 완료한 것

- `packages/shared/src/one-liner-draft.ts`에 shared One-Liner parsing과 reward-evidence helper를 추가했다.
- `ui/src/components/FloatingOneLinerCapture.tsx`에 global floating One-Liner widget을 추가했다.
- global `c` shortcut이 현재 화면에서 capture를 열도록 바꾸고 shortcuts dialog를 업데이트했다.
- browser voice-to-draft 지원과 unsupported/error fallback을 추가했다.
- Slack/Teams-style reviewed draft intake용 `POST /api/companies/:companyId/rt2/one-liner/inbound-draft`를 추가했다.
- task creation response와 One-Liner UI에서 created task, deliverable, proposed gold, XP, settlement state, reward rationale을 즉시 보여주도록 개선했다.

## 요구사항 커버리지

- `CAP-01`: 완료 — floating widget이 global layout에서 열린다.
- `CAP-02`: 완료 — `c` shortcut이 capture를 열고 shortcuts dialog에 문서화되어 있다.
- `CAP-03`: 완료 — browser가 지원하는 경우 voice input으로 reviewed draft를 만들 수 있다.
- `CAP-04`: 완료 — inbound messenger-style text가 같은 reviewed draft 구조를 만든다.
- `CAP-05`: 완료 — commit result가 task/deliverable/reward evidence를 즉시 보여준다.

## 검증

- 통과: `pnpm --filter @paperclipai/shared typecheck`
- 통과: `pnpm --filter @paperclipai/server typecheck`
- 통과: `pnpm --filter @paperclipai/ui typecheck`
- 통과: `pnpm exec vitest run ui/src/lib/one-liner-draft.test.ts`
- 통과: `pnpm exec vitest run server/src/__tests__/rt2-task-routes.test.ts`

## 메모

- Vitest는 sandbox에서 `spawn EPERM`으로 실패해 승인된 unsandboxed rerun이 필요했다.
- 첫 UI Vitest command는 잘못된 project filter(`--project ui`) 때문에 실패했고, 올바른 direct file command는 통과했다.
- 실제 Slack/Teams installation, webhook signing, immutable ledger settlement는 의도적으로 defer했다.
