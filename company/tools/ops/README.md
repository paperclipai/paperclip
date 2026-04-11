# Ops CLI

이 폴더는 `Daily Focus`, `Cycle`, `Chapter`, 대표 운영 루프처럼
작게 자주 쓰는 운영 커맨드를 모아두는 영역이다.

## 현재 커맨드

모든 커맨드는 `mycompany-` prefix로 통일한다.

### 1. Chapter 생성

```bash
./tools/ops/mycompany-chapter create \
  --year 2026 \
  --number 2 \
  --period "2026-03-01 ~ 2026-04-30" \
  --theme "superbuilder 출하 엔진화와 첫 유료 전환" \
  --initiative "Superbuilder Shipment Engine"
```

기본 출력 위치:

- `roadmap/chapters/YYYY/YYYY-chapter-N.md`

### 2. Cycle 생성

```bash
./tools/ops/mycompany-cycle create \
  --year 2026 \
  --cycle "C2 Cycle 3" \
  --chapter "2026 Chapter 2" \
  --initiative "Superbuilder Shipment Engine" \
  --week "2026-03-16 ~ 2026-03-22" \
  --goal "리드 1Day POC" \
  --goal "예약관리 SaaS 빌드" \
  --goal "UI 컴포넌트 자산화" \
  --update-target "리드 1Day POC 플레이북" \
  --update-target "예약관리 SaaS Starter"
```

기본 출력 위치:

- `operations/cycles/YYYY/c2-cycle-3.md`

### 3. Daily Focus 생성

```bash
./tools/ops/mycompany-daily-focus create \
  --chapter "2026 Chapter 2" \
  --cycle "C2 Cycle 3"
```

기본 출력 위치:

- `daily/YYYY/YYYY-MM-DD-daily-focus.md`

### 4. Cycle 파일을 같이 읽어서 생성

```bash
./tools/ops/mycompany-daily-focus create \
  --chapter "2026 Chapter 2" \
  --cycle "C2 Cycle 3" \
  --cycle-file "/absolute/path/to/c2-cycle-3.md"
```

### 5. 주간 목표를 직접 넣어서 생성

```bash
./tools/ops/mycompany-daily-focus create \
  --chapter "2026 Chapter 2" \
  --cycle "C2 Cycle 3" \
  --goal "리드 1Day POC" \
  --goal "예약관리 SaaS 빌드" \
  --goal "UI 컴포넌트 자산화"
```

### 6. 견적 xlsx 하단 금액 확정

Numbers로 PDF export 할 때 하단 `합계 / 부가세 / 총계` 수식이 비어 나갈 수 있다.
견적 xlsx는 PDF 변환 전에 아래 커맨드로 금액을 숫자로 확정한다.

```bash
./tools/ops/mycompany-quote-finalize /absolute/path/to/quote.xlsx
```

기본 동작:

- 시트: `개발견적서`
- 공급가 계산 범위: `L11:N35`
- 하단 입력 셀:
  - `G37`: 합계
  - `G38`: 부가세
  - `G39`: 총계

## 동작 방식

- 기본 출력 위치: `daily/YYYY/YYYY-MM-DD-daily-focus.md`
- 전일 Daily Focus가 있으면:
  - 전일 목표 체크를 자동으로 채운다
  - 미완료 항목을 오늘 최우선 목표와 내일로 넘길 것에 반영한다
- Cycle 파일이 있거나, 같은 이름의 Cycle 문서가 있으면:
  - 이번 주 Must-win goal 1~3개를 자동으로 채운다

## 목적

이 커맨드들의 목적은 하나다.

`전일 결과 -> 오늘 목표 -> 주간 Progress`를 매일 같은 방식으로 시작하게 만드는 것
