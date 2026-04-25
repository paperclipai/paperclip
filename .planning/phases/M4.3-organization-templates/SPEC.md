# M4.3: 조직 템플릿 공유

## 1. What & Why
Portable Company Templates를 사용하여 신규 부서/지점을 원클릭로 셋업하는 기능.
템플릿에 정의된 조직 구조, 워크플로우, 에이전트 구성을 실제 조직으로 즉시 전환.

## 2. Outcome
- 템플릿 선택 → 원클릭 적용 → 실제 부서/에이전트/워크플로우 자동 생성
- 템플릿 마켓플레이스 Browse & Apply UI

## 3. 스키마 변경
기존 `rt2CompanyTemplates` 활용 (M3.5에서 이미 구현)

## 4. 서비스
- `applyTemplateToCompany(templateId, targetCompanyId)` - 템플릿을 조직에 적용
- 템플릿 내 departments → 실제 부서 생성
- 템플릿 내 agentConfigs → 실제 에이전트 생성
- 템플릿 내 workflows → 워크플로우 템플릿 등록
- 템플릿 내 budgetPolicy → 예산 정책 생성

## 5. API
- `POST /companies/:companyId/rt2/templates/:templateId/apply` - 템플릿 적용

## 6. 의존성
- M3.5 rt2_enterprise.ts (rt2CompanyTemplates 스키마)
- companies, agents 스키마