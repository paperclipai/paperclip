# Skills (스킬)

## 목적
> 에이전트가 사용할 수 있는 능력(마크다운 지침, 도구, 워크플로우)을 패키지로 관리하고, GitHub/skills.sh에서 가져오거나 로컬에서 생성한다.

## 목표
- 로컬 생성, GitHub 임포트, skills.sh 레지스트리 임포트 지원
- 소스 참조(커밋 해시/태그)로 버전 추적 및 업데이트 감지
- 파일 단위 인벤토리 및 개별 파일 수정
- 프로젝트 워크스페이스 자동 스캔으로 스킬 디스커버리

## 동작 구조

### 데이터 모델
```
company_skills
├── id, companyId (FK → companies)
├── key (text, unique within company), slug, name, description
├── markdown (text — 스킬 본문)
├── sourceType (local_path | github | skills_sh)
├── sourceLocator, sourceRef (커밋 해시/태그)
├── trustLevel (markdown_only | ...)
├── compatibility (compatible | ...)
├── fileInventory (jsonb array — 파일 목록)
├── metadata (jsonb)
└── createdAt, updatedAt
```

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/skills` | 스킬 목록 |
| GET | `/companies/:companyId/skills/:id` | 스킬 상세 (파일 포함) |
| POST | `/companies/:companyId/skills` | 로컬 스킬 생성 |
| POST | `/companies/:companyId/skills/import` | 소스에서 임포트 |
| POST | `/companies/:companyId/skills/scan-projects` | 워크스페이스 자동 스캔 |
| PATCH | `/companies/:companyId/skills/:id/files` | 스킬 파일 수정 |
| GET | `/companies/:companyId/skills/:id/files?path=...` | 개별 파일 읽기 |
| GET | `/companies/:companyId/skills/:id/update-status` | 업데이트 확인 |
| POST | `/companies/:companyId/skills/:id/install-update` | 업데이트 설치 |
| DELETE | `/companies/:companyId/skills/:id` | 스킬 삭제 |

### 비즈니스 로직
- **소스 타입**: local_path(직접 생성), github(레포에서 임포트), skills_sh(레지스트리)
- **버전 추적**: `sourceRef`로 현재 버전 기록, 업데이트 시 새 버전과 비교
- **신뢰 수준**: `markdown_only`는 문서 용도만, 향후 확장 가능
- **자동 스캔**: `scanProjectWorkspaces()`로 프로젝트 디렉토리에서 SKILL.md + 매니페스트 자동 발견
- **권한**: `agents:create` 권한 필요

### UI
- **Skills 페이지**: 스킬 목록 + 임포트/생성
- **SkillDetail**: 스킬 파일 뷰어/에디터

## 관련 엔티티
- **Company**: `companyId` FK — 소속 회사
- **Agent**: 에이전트 런타임에서 스킬 참조
- **Project**: 프로젝트 워크스페이스에서 스킬 자동 발견

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/company_skills.ts` |
| Service | `server/src/services/company-skills.ts` |
| Route | `server/src/routes/company-skills.ts` |
| Page | `ui/src/pages/Skills.tsx` |
