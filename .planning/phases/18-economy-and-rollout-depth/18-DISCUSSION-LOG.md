# Phase 18: Economy and Rollout Depth - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-25
**Phase:** 18-Economy and Rollout Depth
**Areas discussed:** Economy Evidence, Rollout Evidence, Verification Boundary

---

## Economy Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Persisted evidence 연결 | 기존 deliverable/quality/ledger/reward/subscription record를 연결해 표시 | ✓ |
| 새 pricing formula 중심 | 새 산정식을 만들어 marketplace/P&L에 강하게 반영 | |
| UI copy만 보강 | 계산 근거 없이 문구만 운영자 친화적으로 변경 | |

**Auto choice:** Persisted evidence 연결
**Notes:** `ECON-01`은 산정 근거 표시가 핵심이므로 fake formula보다 기존 evidence 연결이 안전하다.

---

## Rollout Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Ready/partial/missing 검수 상태 | SSO/template/binding/policy별 저장값과 warning을 표시 | ✓ |
| 실제 SSO handshake까지 구현 | identity provider 연동까지 진행 | |
| 기존 form 유지 | 저장 form만 유지하고 검수 증거는 생략 | |

**Auto choice:** Ready/partial/missing 검수 상태
**Notes:** Phase 13에서 실제 handshake/SCIM은 후속 범위로 둔 결정과 일관된다.

---

## Verification Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Typecheck + scoped route tests | 컴파일 계약과 기존 라우트 테스트를 검증 | ✓ |
| Full e2e/browser QA | 이번 변경보다 무거운 검수 | |
| 문서만 갱신 | 구현 검증이 부족 | |

**Auto choice:** Typecheck + scoped route tests
**Notes:** Windows sandbox `spawn EPERM`과 embedded Postgres skip 가능성을 명시적으로 기록한다.

## the agent's Discretion

- Evidence badge 색상과 copy는 기존 RT2 화면 스타일에 맞춰 구현한다.

## Deferred Ideas

- 실제 SSO handshake/SCIM/native rollout.
- 가격 협상, settlement approval, anti-gaming economy depth.
