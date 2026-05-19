# 페퍼 조직구성 및 구성원 페르소나 지침 검토/보완 보고서

## 1. 검토 대상

- Company: `Her Paperclip Ops`
- 목적: 헤르가 관리하는 Paperclip 기반 업무조직. 개인/프로젝트 업무를 이슈, 목표, 에이전트 역할로 분해해 실행.
- 기준 페르소나: `헤르 CEO`
- 검토/수정 일시: 2026-05-15

## 2. 기존 상태 진단

### 잘 정의된 부분

- CEO가 최종 전략/품질/승인 책임자라는 축은 명확했음.
- 핵심 실행 흐름인 `접수 → 분해 → 실행 → 검수 → 보고`에 필요한 기본 역할은 존재했음.
- Paperclip 실행 계약은 PM/Engineer/Researcher/QA에 공통으로 들어가 있어 작업 방치 방지 장치는 있었음.

### 보완이 필요했던 부분

- CEO 지침이 두 번 중복되어 있었고, 두 번째 블록은 이스케이프 문자와 HTML entity가 섞여 품질이 낮았음.
- CEO 지침에 `UXDesigner`, `CMO`로 위임하라는 내용이 있었지만 실제 조직에는 해당 에이전트가 없었음.
- CTO 지침 파일이 사실상 비어 있었음.
- PM/Engineer/Researcher/QA는 모두 동일한 generic 지침만 가지고 있어 역할별 페르소나, 책임, 산출물 기준이 부족했음.
- 구성원 간 RACI/위임 경로가 명확하지 않았음.
- 최종 보고서에 담당자와 역할을 명시하라는 사용자 선호가 조직 지침에 반영되어 있지 않았음.

## 3. 적용한 보완 방향

### 조직 모델

현재 조직은 과확장하지 않고 lean phase-1 구조로 정리함.

- CEO / 헤르 CEO: 전략, 우선순위, 승인, 조직 위임, 품질 게이트, 보드 커뮤니케이션
- CTO: 기술 전략, 아키텍처, 보안/거버넌스 리스크, 구현 방향, 기술 품질 게이트
- PM / 기획 매니저: 요구사항 정리, 이슈 분해, 마일스톤/의존성 관리, 수락기준과 진행 흐름
- Engineer / 개발 엔지니어: 코드 작성, 자동화, 통합, 테스트 실행, 기술 산출물 생성
- Researcher / 리서치 분석가: 시장/기술/표준/보안 자료 조사, 출처 기반 분석, 선택지 비교
- QA / QA 리뷰어: 수락기준 검증, 회귀 테스트, 산출물 품질 리뷰, 결함/리스크 보고

### CEO 지침 정렬

- CEO는 IC 작업자가 아니라 전략/위임/검증 책임자로 재정의.
- 실제 존재하지 않는 UXDesigner/CMO 위임 지침 제거.
- 디자인/성장/법무/재무/보안 심화 역할은 반복적이거나 고위험일 때 specialist hiring 제안하도록 변경.
- OSS 거버넌스/SBOM/VEX/CVSS/EPSS/KEV 같은 고위험 데이터는 직접 수작업 생성하지 않고 전문 에이전트/도구에 위임 후 요약 증거를 검토하도록 명시.

### 구성원별 지침

각 agent의 `AGENTS.md`를 다음 구조로 보완함.

- Persona
- Mission
- Operating Style
- Responsibilities
- Delegation Interface
- Definition of Done
- Common Paperclip Execution Contract

### 공통 실행 계약 강화

모든 에이전트 지침에 다음을 명시함.

- 같은 heartbeat에서 실행 가능한 작업을 시작.
- 완료/검토/차단 상태를 명확히 남김.
- 병렬/위임 작업은 child issue로 관리.
- 사용자/보드 결정은 `request_confirmation`, `ask_user_questions`, `suggest_tasks` 같은 Paperclip interaction 사용.
- 최종 보고에는 담당자와 담당 역할을 포함.

### 에이전트 최적화 원칙 추가 반영

2026-05-15 추가 검토에서 Claude.md/AGENTS.md 계열 에이전트 지침의 핵심 원칙을 페퍼 운영 방식에 맞게 압축 반영함.

- Think before acting: 요청이 애매하면 추측하지 않고 질문하거나 선택지/트레이드오프를 제시.
- Minimal necessary work: 이슈 해결에 필요한 최소 작업만 수행.
- Surgical changes: 관련 없는 리팩토링, 포맷팅, 의존성 업그레이드, 범위 확장을 금지하고 후속 이슈로 분리.
- Verified outcomes: 파일 변경이 아니라 검증된 결과와 증거로 완료 판단.
- Concrete evidence: 테스트 출력, 재현 노트, API 응답, 스크린샷, 리뷰 산출물, 의사결정 기록 등 구체 증거를 남김.

## 4. 적용 내역

수정된 에이전트:

- `헤르 CEO` / role: `ceo`
- `CTO` / role: `cto`
- `기획 매니저` / role: `pm`
- `개발 엔지니어` / role: `engineer`
- `리서치 분석가` / role: `researcher`
- `QA 리뷰어` / role: `qa`

수정 항목:

- 각 agent의 managed instruction bundle `AGENTS.md`
- 각 agent의 capabilities 설명

백업 위치:

```text
/home/kklee/.paperclip/backups/agent-instructions/20260515-134527
/home/kklee/.paperclip/backups/agent-instructions/20260515-170300
```

## 5. 검증 결과

- Paperclip API health: `ok`
- 6개 에이전트 모두 instruction file 존재 확인.
- 6개 에이전트 모두 `# Persona:` 포함 확인.
- 6개 에이전트 모두 `Common Paperclip Execution Contract` 포함 확인.
- 6개 에이전트 모두 `Agent Discipline` 및 역할별 최적화 게이트 포함 확인.
- CEO instruction 중복 블록 제거 확인.
- CTO instruction 공백 문제 해결 확인.
- capabilities가 역할별 한국어 설명으로 업데이트된 것 확인.
- 루트/온보딩 AGENTS.md 변경에 대해 `git diff --check` 통과.
- UI 변경 파일 `ui/src/pages/Auth.tsx`: `pnpm --filter @paperclipai/ui typecheck` 통과.
- Codex local adapter 변경 파일 `packages/adapters/codex-local/src/index.ts`: `pnpm --filter @paperclipai/adapter-codex-local typecheck` 통과.

주의:

- `QA 리뷰어`의 status가 `error`로 남아 있음. 이번 작업은 지침/페르소나 보완이며, QA runtime error 원인 분석/복구는 별도 운영 점검 대상임.

## 6. 추가 권장사항

### 즉시 추가 채용은 보류

현재는 CEO/CTO/PM/Engineer/Researcher/QA 6인 구조로 충분함. UXDesigner/CMO를 미리 만들면 관리 복잡도만 늘 가능성이 있음.

### 추가 채용이 필요한 조건

- UX/UI 산출물이 반복적으로 발생하고 QA/PM으로 커버가 안 될 때: UX Designer 채용
- 제품 포지셔닝/마케팅/세일즈 자료가 반복될 때: CMO/Growth Lead 채용
- SBOM/VEX/취약점 분석이 상시 업무화될 때: Security/Governance Lead 채용
- 재무/비용/예산 최적화가 독립 업무가 될 때: Finance/Ops Analyst 채용

## 7. 책임자 및 역할

- 작업 책임자: 헤르
- 수행 역할: 조직/페르소나 아키텍트, Paperclip 운영 관리자, 품질 검토자
- 적용 범위: 페퍼 조직 구성 검토, agent instruction 보완, capabilities 정리, 적용 후 검증
