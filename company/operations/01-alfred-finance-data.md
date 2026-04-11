# Alfred 회계 데이터 수집

이 문서는 `Alfred`에서 매출/매입 세금계산서, 매입 신용카드, 계좌 입출금 데이터를 반복적으로 가져와서,
회사 운영 논의에 사용할 수 있게 하는 기준 문서다.

## 목적

- 매출, 매입, 카드 사용, 계좌 입출금 흐름을 수시로 확인한다
- 월말 정산 전에도 숫자를 미리 본다
- 대표 판단을 감이 아니라 실제 데이터로 보정한다
- 필요할 때 바로 데이터를 뽑아 전략, 운영, 현금흐름 논의에 쓴다

## 현재 확인된 흐름

Alfred 앱의 실제 흐름은 아래 순서다.

1. `https://nexus-api.alfred.kr/api/login/` 으로 로그인
2. `https://nexus-api.alfred.kr/api/user/me/` 로 사용자/회사 정보 확인
3. `https://nexus-api.alfred.kr/api/user/me/jwt/` 로 회사 JWT 발급
4. `https://transaction-api.heumtax.com/...` 로 거래 데이터 조회

핵심 포인트:

- 회사 식별은 현재 `nexus company id = 9828`
- JWT 발급 payload는 `company_id = 9828`
- 세금계산서 거래 API 경로는 `company/9828`
- 계좌 입출금 API는 경로형 회사 ID가 아니라 query string의 `company_id=9828`를 사용한다
- 프런트 화면 파라미터는 camelCase처럼 보이지만, 실제 거래 API는 `from_date`, `to_date`, `page_size` 형식을 사용한다

## 현재 확인된 주요 엔드포인트

### 매출 세금계산서

- 목록: `GET /api/company/{company_id}/tax-invoices/sales`
- 요약: `GET /api/company/{company_id}/tax-invoices/sales/aggregation`

### 매입 세금계산서

- 목록: `GET /api/company/{company_id}/tax-invoices/purchases`
- 요약: `GET /api/company/{company_id}/tax-invoices/purchases/aggregation`

### 매입 신용카드

- 목록: `GET /api/company/{company_id}/card/purchases`
- 요약: `GET /api/company/{company_id}/card/purchases/aggregation`

### 계좌 입출금

- 목록: `GET /api/evidences/bank-transaction`
- 요약: `GET /api/evidences/bank-transaction/summary`

## 반복 조회용 스크립트

경로:

- `tools/alfred/fetch_tax_invoices.py`

이 스크립트는 아래를 한 번에 수행한다.

- Alfred 로그인
- 회사 정보 조회
- 회사 JWT 발급
- 매출 세금계산서 요약/목록 조회
- 매입 세금계산서 요약/목록 조회
- 매입 신용카드 요약/목록 조회
- 계좌 입출금 요약/목록 조회
- Markdown 또는 JSON 출력
- 필요하면 로컬 스냅샷 저장

## 실행 방식

환경변수:

- `ALFRED_EMAIL`
- `ALFRED_PASSWORD`

예시:

```bash
export ALFRED_EMAIL="..."
export ALFRED_PASSWORD="..."

python3 tools/alfred/fetch_tax_invoices.py \
  --from-date 2026-03-01 \
  --to-date 2026-03-31
```

스냅샷 저장 예시:

```bash
python3 tools/alfred/fetch_tax_invoices.py \
  --from-date 2026-03-01 \
  --to-date 2026-03-31 \
  --save-dir private-data/alfred
```

입출금 검색/특정 계좌 필터 예시:

```bash
python3 tools/alfred/fetch_tax_invoices.py \
  --from-date 2026-03-01 \
  --to-date 2026-03-31 \
  --search "쿠쿠" \
  --account-number "1005204609879"
```

## 출력물 활용 방식

이 스크립트의 출력은 아래 논의에 바로 쓸 수 있다.

- 이번 달 매출 인식 현황
- 아직 미분류된 거래가 있는지
- 매입 누적 속도와 현금 압박
- 법인카드 지출 패턴과 반복 지출 추이
- 카드 취소/환불성 거래 확인
- 입금/출금 패턴과 자금 흐름
- 반복 지출, 구독성 지출, 큰 출금 건 확인
- 특정 프로젝트/고객 관련 매출 타이밍
- 월말 전에 세무상 누락 가능성 점검

## 운영 원칙

- 자격증명은 문서나 코드에 직접 쓰지 않는다
- 저장소에는 운영 문서와 도구만 남기고, 실제 데이터 스냅샷은 `private-data/` 아래에 둔다
- 숫자 해석은 반드시 기간을 같이 본다
- 전략 논의에 쓸 때는 `매출`, `매입`, `카드지출`, `입금`, `출금`, `현금 유입 예상`, `미분류 거래`를 같이 본다

## 다음 확장 후보

현재는 세금계산서, 매입 신용카드, 계좌 입출금까지 연결했다.
이후 필요하면 아래 순서로 확장한다.

1. PG 매출
2. 온라인 쇼핑몰 매출
3. 계정과목 자동 분류 상태
4. 법인카드별 집계
5. 현금흐름 대시보드용 요약 스냅샷
