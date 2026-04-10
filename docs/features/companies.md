# Companies (회사)

## 목적
> 에이전트, 이슈, 프로젝트 등 모든 엔티티의 최상위 조직 단위. 회사별 격리된 워크스페이스를 제공한다.

## 목표
- 회사별 고유 이슈 프리픽스(issuePrefix) 자동 생성
- 브랜딩(로고, 컬러) 관리
- 회사 전체 가져오기/내보내기 (포터빌리티)
- 예산 및 피드백 공유 정책 설정

## 동작 구조

### 데이터 모델
```
companies
├── id, name, description
├── status (기본값 active), pauseReason, pausedAt
├── issuePrefix (text, unique — 기본값 PAP, 이슈 식별자 접두사)
├── issueCounter (integer, 자동 증가)
├── budgetMonthlyCents, spentMonthlyCents
├── requireBoardApprovalForNewAgents (boolean)
├── feedbackDataSharingEnabled (boolean) + 동의 메타데이터
├── brandColor (text, hex)
└── createdAt, updatedAt

company_logos — assetId 참조로 로고 관리
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies` | 전체 회사 목록 |
| GET | `/companies/stats` | 회사별 에이전트/이슈 수 |
| POST | `/companies` | 회사 생성 (프리픽스 자동 생성) |
| PATCH | `/companies/:id` | 회사 설정 수정 |
| PATCH | `/companies/:id/branding` | 브랜딩(컬러/로고) 수정 — CEO 에이전트만 |
| POST | `/companies/:id/archive` | 아카이브 |
| DELETE | `/companies/:id` | 삭제 (전체 캐스케이드) |
| POST | `/companies/:id/export` | 회사 번들 내보내기 |
| POST | `/companies/:id/imports/preview` | 가져오기 미리보기 |
| POST | `/companies/:id/imports/apply` | 가져오기 적용 |

### 비즈니스 로직
- **이슈 프리픽스 자동 생성**: 회사명에서 알파벳 추출, 충돌 시 숫자 접미사 (최대 10K 시도)
- **캐스케이드 삭제**: 회사 삭제 시 에이전트, 이슈, 프로젝트, 목표, 승인, 활동 로그, 비용 이벤트 등 전부 삭제
- **월간 지출 집계**: `hydrateCompanySpend()` — cost_events에서 UTC 월간 윈도우 합산
- **포터빌리티**: ZIP 번들로 내보내기(에이전트/프로젝트/이슈/스킬), 가져오기 시 충돌 전략 선택(create/update/skip/replace)
- **에이전트 안전 가져오기**: CEO 에이전트는 replace 전략 금지

### UI
- **Companies 페이지**: 회사 목록, 인라인 편집, 에이전트/이슈 카운트
- **CompanySettings**: 일반 설정, 브랜딩, 보드 승인 토글, 피드백 공유, 초대 스니펫
- **CompanyImport**: ZIP 업로드 → 미리보기 → 충돌 전략 → 적용
- **CompanyExport**: 파일 트리 선택 → ZIP 다운로드

## 관련 엔티티
- **Agent, Issue, Project, Goal, Team**: 모두 `companyId` FK로 소속
- **Budget**: 회사 월간 예산 정책
- **Activity**: 회사 스코프 활동 로그

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/companies.ts` |
| Service | `server/src/services/companies.ts` |
| Route | `server/src/routes/companies.ts` |
| Page | `ui/src/pages/Companies.tsx`, `CompanySettings.tsx`, `CompanyImport.tsx`, `CompanyExport.tsx` |
