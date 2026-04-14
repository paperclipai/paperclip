# 견적 플러그인 시나리오

## 개요

에이전트가 `generate_quote` 툴을 호출하면, 플러그인 워커가 견적서 PDF를 생성해 반환한다.
기존 company-os의 견적 로직(pricing-rules, Playwright PDF, VAT 계산)을 플러그인으로 이식.

---

## 시나리오 1: 대화 기반 견적 생성

```
사용자 (룸에서):
  "김철수 대표님 웹사이트 리뉴얼 견적 보내줘.
   랜딩페이지, 어드민 기본, 카카오 로그인, FAQ, 알림톡 연동."

에이전트 (LLM 판단):
  → tool_use: quote-gen:generate_quote
```

### 입력 (Agent → Plugin)

```json
{
  "tool": "quote-gen:generate_quote",
  "parameters": {
    "customerName": "김철수",
    "projectName": "웹사이트 리뉴얼",
    "items": [
      { "type": "skeleton", "key": "landing" },
      { "type": "skeleton", "key": "admin-basic" },
      { "type": "feature", "key": "auth-kakao" },
      { "type": "feature", "key": "faq" },
      { "type": "feature", "key": "alimtalk" }
    ],
    "notes": ["디자인 시안 2회 수정 포함"],
    "validityDays": 30
  }
}
```

### 처리 (Plugin Worker)

1. `pricing-rules.json`에서 각 항목 단가 조회
2. 소계 합산 → VAT 10% → 만원미만 절삭
3. Playwright로 HTML 템플릿 렌더 → A4 PDF 생성
4. 버전 관리: `{customerName}/2026-04-14-v1.pdf`

### 출력 (Plugin → Agent)

```json
{
  "content": "견적서 생성 완료: 김철수-웹사이트 리뉴얼 (₩8,450,000, VAT 포함 ₩9,290,000)",
  "data": {
    "customerName": "김철수",
    "projectName": "웹사이트 리뉴얼",
    "version": 1,
    "subtotal": 8450000,
    "vat": 845000,
    "total": 9290000,
    "items": [
      { "category": "기본 구성", "label": "랜딩페이지", "price": 2500000 },
      { "category": "기본 구성", "label": "어드민 기본", "price": 500000 },
      { "category": "기능", "label": "카카오 로그인", "price": 800000 },
      { "category": "기능", "label": "FAQ", "price": 350000 },
      { "category": "기능", "label": "알림톡 연동", "price": 4300000 }
    ],
    "pdfPath": "/quotes/김철수/2026-04-14-v1.pdf",
    "validUntil": "2026-05-14"
  },
  "artifacts": [
    {
      "name": "김철수-견적서.pdf",
      "path": "/quotes/김철수/2026-04-14-v1.pdf",
      "mimeType": "application/pdf"
    }
  ]
}
```

### 에이전트 후속 행동

에이전트가 결과를 받아서:
- 룸에 "견적서 생성했습니다. 총 ₩9,290,000 (VAT 포함)" 메시지
- PDF 파일 첨부 또는 다운로드 링크 제공

---

## 시나리오 2: 수동 항목 추가

```json
{
  "parameters": {
    "customerName": "이영희",
    "projectName": "AI 챗봇 구축",
    "items": [
      { "type": "skeleton", "key": "landing" },
      { "type": "manual", "label": "GPT-4 챗봇 커스텀", "category": "AI 연동", "price": 5000000, "period": "4주" },
      { "type": "manual", "label": "RAG 파이프라인", "category": "AI 연동", "price": 3000000, "period": "2주" }
    ]
  }
}
```

manual 타입은 pricing-rules 조회 없이 직접 단가/기간 지정.

---

## 시나리오 3: 견적 수정 (버전 업)

```
사용자: "아까 김철수 견적에서 알림톡 빼고 블로그 추가해줘"

에이전트 → quote-gen:update_quote
```

```json
{
  "tool": "quote-gen:update_quote",
  "parameters": {
    "customerName": "김철수",
    "removeItems": ["alimtalk"],
    "addItems": [
      { "type": "feature", "key": "blog-cms" }
    ]
  }
}
```

→ 기존 v1 기반으로 v2 생성, 이전 버전 보존

---

## 시나리오 4: 견적 조회

```
사용자: "김철수 견적 이력 보여줘"

에이전트 → quote-gen:list_quotes
```

```json
{
  "tool": "quote-gen:list_quotes",
  "parameters": { "customerName": "김철수" }
}
```

→ 버전별 견적 목록 + 금액 요약 반환

---

## 플러그인 툴 목록

| 툴 이름 | 설명 | 필수 파라미터 |
|---------|------|-------------|
| `generate_quote` | 새 견적서 생성 (PDF + JSON) | customerName, projectName, items[] |
| `update_quote` | 기존 견적 수정 → 새 버전 | customerName, addItems/removeItems |
| `list_quotes` | 고객별 견적 이력 조회 | customerName |
| `get_pricing` | 단가표 조회 | (없음 = 전체, category로 필터) |

---

## 데이터 흐름 요약

```
사용자 발화
  ↓ (자연어)
에이전트 LLM — 의도 파악, 파라미터 추출
  ↓ (structured JSON)
POST /api/plugins/tools/execute
  ↓ (JSON-RPC over stdio)
Quote Plugin Worker
  ├── pricing-rules.json 조회
  ├── 금액 계산 (소계 → VAT → 절삭)
  ├── Playwright PDF 렌더링
  └── 파일 저장 + 버전 관리
  ↓ (ToolResult)
에이전트 — 결과를 룸에 전달
  ↓
사용자 — PDF 확인, 수정 요청 가능
```

## 공급자 정보 (설정으로 관리)

플러그인 설정(plugin_company_settings)에 저장:

```json
{
  "supplier": {
    "companyName": "비브라이트코드",
    "bizNo": "111-87-03249",
    "ceo": "김대환",
    "phone": "010-xxxx-xxxx",
    "address": "...",
    "bizType": "정보통신업",
    "bizItem": "소프트웨어 개발 및 공급"
  },
  "defaultValidityDays": 30,
  "vatRate": 0.1,
  "truncateTo": 10000
}
```
