# M4.3 Plan: 조직 템플릿 공유

## Tasks

### Phase A: 서비스 레이어 구현
- [ ] `server/src/services/rt2-template-application.ts` 생성
  - `applyTemplateToCompany(db, templateId, targetCompanyId)` 함수
  - 템플릿 데이터 파싱
  - 부서, 에이전트, 워크플로우, 예산 정책 생성 로직

### Phase B: 라우트 구현
- [ ] `server/src/routes/rt2-template-application.ts` 생성
  - `POST /companies/:companyId/rt2/templates/:templateId/apply`

### Phase C: app.ts 등록
- [ ] 라우트 import 및 등록

### Phase D: 검증
- [ ] typecheck 통과

## 파일 구조
```
server/src/
├── services/rt2-template-application.ts  (신규)
└── routes/rt2-template-application.ts    (신규)
```

## 핵심 로직
```typescript
// applyTemplateToCompany pseudocode
1. 템플릿 조회 (isPublic=true 또는 authorCompanyId === targetCompanyId)
2. 템플릿 사용 카운트 증가
3. templateData.departments 순회 → 부서 생성
4. templateData.agentConfigs 순회 → 에이전트 생성
5. templateData.workflows 순회 → 워크플로우 생성
6. templateData.budgetPolicy → 예산 정책 생성
7. templateData.skills → 스킬 할당
8. templateData.governance → 거버넌스 설정
```