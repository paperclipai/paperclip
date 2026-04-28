# M4.4 Plan: qmd 보조 검색

## Tasks

### Phase A: 스키마 생성
- [ ] `packages/db/src/schema/rt2_search.ts` 생성
  - `rt2SearchIndex` 테이블 (검색 인덱스 메타데이터)
  - 인덱스 상태 추적

### Phase B: 서비스 레이어 구현
- [ ] `server/src/services/rt2-hybrid-search.ts` 생성
  - `search(query, companyId, options)` - 키워드 + 의미 검색
  - `indexDocument(documentId)` - 개별 문서 인덱싱
  - `rebuildIndex(companyId)` - 전체 인덱스 재구축
  - `getSearchStats(companyId)` - 인덱스 상태

### Phase C: 라우트 구현
- [ ] `server/src/routes/rt2-hybrid-search.ts` 생성
  - `GET /companies/:companyId/rt2/search?q=query` - 검색
  - `POST /companies/:companyId/rt2/search/index` - 인덱싱 트리거
  - `GET /companies/:companyId/rt2/search/stats` - 인덱스 상태

### Phase D: app.ts 등록
- [ ] 라우트 import 및 등록

### Phase E: 검증
- [ ] typecheck 통과

## 파일 구조
```
packages/db/src/schema/
└── rt2_search.ts                    (신규)

server/src/
├── services/rt2-hybrid-search.ts   (신규)
└── routes/rt2-hybrid-search.ts       (신규)
```

## 핵심 로직
```typescript
// search pseudocode
1. 키워드 검색 (PostgreSQL ILIKE)
2. 검색 결과 스코어링
3. 상위 결과 반환 (최대 50개)
4. 하이라이트 메타데이터 포함

// rebuildIndex pseudocode
1. companyId의 모든 documents 조회
2. 각 문서의 latestBody 인덱싱
3. 인덱스 상태 업데이트
```