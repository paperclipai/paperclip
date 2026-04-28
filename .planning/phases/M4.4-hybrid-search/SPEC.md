# M4.4: qmd 보조 검색

## 1. What & Why
위키 500+ 페이지 도달 시 로컬 하이브리드 검색 제공.
키워드 검색 + AI 기반 의미 검색 조합으로 정확한 정보 발견.

## 2. Outcome
- 문서/위키 페이지 전체 텍스트 검색
- 하이브리드 검색 (키워드 + 의미론적)
- 검색 결과 랭킹 및 하이라이트

## 3. 스키마 변경
- `rt2SearchIndex` 테이블 추가 (검색 인덱스 메타데이터)
- 기존 documents 테이블의 latestBody 활용

## 4. 서비스
- `rt2HybridSearchService`
  - `search(query, companyId, options)` - 하이브리드 검색
  - `indexDocument(document)` - 문서 인덱싱
  - `rebuildIndex(companyId)` - 인덱스 재구축

## 5. API
- `GET /companies/:companyId/rt2/search?q=query` - 검색
- `POST /companies/:companyId/rt2/search/reindex` - 인덱스 재구축

## 6. 의존성
- documents 스키마
- rt2V33DailyWikiPages 스키마