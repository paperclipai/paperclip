# Phase 12: Jarvis Runtime and Change Management - Discussion Log

> **Audit trail only.** 계획/구현 입력은 `12-CONTEXT.md`를 기준으로 한다.

**Date:** 2026-04-25T14:54:00+09:00  
**Phase:** 12-Jarvis Runtime and Change Management  
**Mode:** auto chain  
**Areas analyzed:** Manager Review, Auto Policy, Reverse Design, Runtime Skill Capability

## Manager Review

| Option | Description | Selected |
|--------|-------------|----------|
| Existing quality score queue | `rt2_quality_scores`를 manager review queue로 컴파일 | yes |
| New review table | 별도 Jarvis review table 추가 | no |

**Decision:** 기존 quality score row를 source of truth로 사용하고, API에서 evidence-rich review item을 만든다.

## Auto Policy

| Option | Description | Selected |
|--------|-------------|----------|
| Base price band | base price와 threshold band로 Auto/Co-Pilot 라우팅 | yes |
| Manual flag only | mode flag만 신뢰 | no |

**Decision:** Auto policy decision을 응답에 포함하고, band 밖이면 Co-Pilot pending으로 저장한다.

## Reverse Design

| Option | Description | Selected |
|--------|-------------|----------|
| Proposal first | expected deliverable에서 task proposal+rationale 생성 | yes |
| Auto-create task | 즉시 task 생성까지 수행 | no |

**Decision:** 이번 Phase는 traceable proposal까지만 처리한다. 자동 생성은 승인 workflow가 더 명확해진 뒤 확장한다.

## Runtime Skill Capability

| Option | Description | Selected |
|--------|-------------|----------|
| Governed capability | skill injection과 approval request를 함께 노출 | yes |
| Hidden adapter detail | adapter runtime 내부 구현으로 유지 | no |

**Decision:** runtime skill attachment는 `jarvis_skill_capability` approval과 연결한다.

## Auto-Resolved

- 사용자 질문 없이 `--auto --chain`에 따라 codebase-first default를 선택했다.
- mechanical type/migration cleanup은 별도 GSD cycle 없이 inline 처리했다.
