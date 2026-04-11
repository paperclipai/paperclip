# Source Of Truth Map

기준일: 2026-03-16

이 문서는 회사 운영에서 `무슨 질문을 어디서 먼저 읽어야 하는지`를 정리하는 기준표다.

핵심은 하나다.

`질문마다 먼저 봐야 할 원본이 다르다.`

## 1. 대표용 빠른 표

| 영역 | 먼저 보는 원본 | 위치 | 연결 문서 |
| --- | --- | --- | --- |
| 장기 방향 | strategy 문서 | repo | [../strategy/README.md](../strategy/README.md) |
| 제품 원본 / 사업계획서 | Flotter 현재판 문서 + 원본 아카이브 | Notion, repo | [../products/flotter/03-current-product-brief.md](../products/flotter/03-current-product-brief.md), [../products/flotter/01-business-plan-archive.md](../products/flotter/01-business-plan-archive.md) |
| 자체서비스 실행축 / Flotter | own-services flotter area | repo | [../areas/own-services/flotter/README.md](../areas/own-services/flotter/README.md) |
| 올해 실행축 | tactical priority / execution plan | repo | [../strategy/01-2026-03-tactical-priority.md](../strategy/01-2026-03-tactical-priority.md), [../strategy/07-2026-execution-plan.md](../strategy/07-2026-execution-plan.md) |
| 연매출 목표 | revenue plan | repo | [../roadmap/03-2026-revenue-plan.md](../roadmap/03-2026-revenue-plan.md) |
| 확정 매출 / 자금 상태 | Alfred + 계약서 + 키움 | Alfred, Drive, 키움 | [03-company-capital-position.md](./03-company-capital-position.md) |
| 운영현금 판단 | 자금 보드 | repo | [04-capital-board.md](./04-capital-board.md) |
| 영업 파이프라인 | Notion 영업 CRM | Notion | [../management/09-sales-crm-source-of-truth.md](../management/09-sales-crm-source-of-truth.md) |
| 진행 기회 해석 | active opportunities | repo | [../management/06-active-opportunities.md](../management/06-active-opportunities.md) |
| 수주 여부 판단 | intake matrix | repo | [../management/07-project-intake-matrix.md](../management/07-project-intake-matrix.md) |
| 외주개발 리드 대응 방식 | outsourcing workflow | repo | [../areas/outsourcing/01-lead-response-workflow.md](../areas/outsourcing/01-lead-response-workflow.md) |
| 외주개발 수주 판단 | outsourcing intake decision | repo | [../areas/outsourcing/02-intake-decision-workflow.md](../areas/outsourcing/02-intake-decision-workflow.md) |
| 외주개발 견적 운영 | outsourcing quote workflow + pricing framework + customer delivery workflow | repo | [../areas/outsourcing/03-quote-workflow.md](../areas/outsourcing/03-quote-workflow.md), [../areas/outsourcing/05-pricing-framework.md](../areas/outsourcing/05-pricing-framework.md), [../areas/outsourcing/06-customer-quote-delivery-workflow.md](../areas/outsourcing/06-customer-quote-delivery-workflow.md) |
| 외주개발 제안 운영 | outsourcing proposal workflow | repo | [../areas/outsourcing/04-proposal-workflow.md](../areas/outsourcing/04-proposal-workflow.md) |
| superbuilder / 내부 출하 엔진 | superbuilder source of truth + live repo | repo, GitHub | [18-superbuilder-source-of-truth.md](./18-superbuilder-source-of-truth.md), [../strategy/02-superbuilder-positioning.md](../strategy/02-superbuilder-positioning.md) |
| 회의 내용 | Notion 회의록 DB | Notion | [08-meeting-notes-operating-model.md](./08-meeting-notes-operating-model.md) |
| 주간 정렬 | Cycle 문서 + Linear Cycle | Notion, Linear | [../templates/06-weekly-cycle-template.md](../templates/06-weekly-cycle-template.md) |
| 일정 | Google Calendar | Calendar | [11-google-calendar-operations.md](./11-google-calendar-operations.md) |
| 코드 실제 진행 | GitHub | GitHub | [10-github-work-activity.md](./10-github-work-activity.md) |
| 마케팅 실적 | Google Ads, GA4, PostHog | 각 서비스 | [07-marketing-performance-snapshot.md](./07-marketing-performance-snapshot.md) |
| AI 벤더 / 키 관리 기준 | AI vendor registry | repo | [../management/04-ai-vendor-registry.md](../management/04-ai-vendor-registry.md) |
| 계약서 / 법인 문서 / 세무 자료 | Google Drive > 비브라이트코드 | Drive | [14-google-drive-operations.md](./14-google-drive-operations.md) |
| 회사 온보딩 / 정책 / 위키 | Notion 위키 DB | Notion, repo | [../management/10-company-wiki-source-of-truth.md](../management/10-company-wiki-source-of-truth.md), [../management/11-company-wiki-archive.md](../management/11-company-wiki-archive.md) |
| 팀 운영 기준 | team operating model | repo | [12-team-operating-model.md](./12-team-operating-model.md) |
| 운영 원칙 / 금지 목록 | rules | repo | [../rules/01-operating-principles.md](../rules/01-operating-principles.md), [../rules/02-strategic-no-go.md](../rules/02-strategic-no-go.md) |

## 2. 질문별 읽는 순서

### 매출 관련 질문

1. [03-company-capital-position.md](./03-company-capital-position.md)
2. Alfred 데이터
3. Google Drive 계약서 폴더

### CRM 관련 질문

1. Notion 영업 CRM
2. [../management/09-sales-crm-source-of-truth.md](../management/09-sales-crm-source-of-truth.md)
3. 필요하면 [../management/06-active-opportunities.md](../management/06-active-opportunities.md)

### 현재 무엇이 움직였는지

1. GitHub 활동
2. Linear
3. Cycle / 회의록

### 일정 관련 질문

1. Google Calendar
2. 회의록 / Cycle 문서

### 계약서 / 법인 문서 질문

1. Google Drive `비브라이트코드` 폴더
2. 그 안의 `계약서`, `세금`, `법인자료`, `견적서`

### 제품 원본 / 사업계획서 질문

1. [../products/flotter/03-current-product-brief.md](../products/flotter/03-current-product-brief.md)
2. [../products/flotter/04-superbuilder-build-map.md](../products/flotter/04-superbuilder-build-map.md)
3. [../products/flotter/05-2026-execution-plan.md](../products/flotter/05-2026-execution-plan.md)
4. [../products/flotter/01-business-plan-archive.md](../products/flotter/01-business-plan-archive.md)
5. Flotter 원본 Notion 페이지

### superbuilder / 내부 SaaS 팩토리 질문

1. [18-superbuilder-source-of-truth.md](./18-superbuilder-source-of-truth.md)
2. [../strategy/02-superbuilder-positioning.md](../strategy/02-superbuilder-positioning.md)
3. [../strategy/03-2026-03-development-view.md](../strategy/03-2026-03-development-view.md)
4. live repo `/Users/bright/Projects/superbuilder`
5. GitHub `BBrightcode-atlas/superbuilder`

### 회사 위키 / 온보딩 / 정책 질문

1. Notion `위키` DB
2. [../management/10-company-wiki-source-of-truth.md](../management/10-company-wiki-source-of-truth.md)
3. [../management/11-company-wiki-archive.md](../management/11-company-wiki-archive.md)

## 3. 현재 확인된 회사 자료 기준 경로

### Google Drive

- 회사 폴더: `비브라이트코드`
- 계약서 폴더: `비브라이트코드 > 계약서`

### Notion

- 회의록 DB
- 영업 CRM
- OKRs 보드
- 위키 DB

### GitHub

- `bright2024/company`
- `BBrightcode-atlas/superbuilder`
- `BBrightcodeDev/atlas-ui`

## 4. 운영 원칙

- 같은 정보를 여러 군데서 다시 정의하지 않는다
- 원본은 외부 도구에 두고, repo에는 해석과 기준을 남긴다
- 숫자 질문은 기억보다 source of truth를 먼저 읽는다
- 충돌 시 `원본 데이터 > 해석 문서 > 기억` 순으로 우선한다

## 한 줄 정리

회사의 질문은 많지만,
각 질문마다 먼저 읽어야 할 원본은 이미 정해져 있어야 한다.
