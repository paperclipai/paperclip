# Outsourcing Quote Workflow

기준일: 2026-03-18

이 문서는 `외주개발 견적을 어떻게 준비하는지` 정리한 워크플로우다.

핵심은 하나다.

`견적은 바로 보내지 않고, 먼저 내부에서 정리한다.`

## Source

- 견적 초안 템플릿: [../../templates/13-quote-draft-to-daehwan-template.md](../../templates/13-quote-draft-to-daehwan-template.md)
- 고객 발송 템플릿: [../../templates/14-customer-quote-template.md](../../templates/14-customer-quote-template.md)
- 내부 단가 체계: [05-pricing-framework.md](./05-pricing-framework.md)
- 고객 발송 흐름: [06-customer-quote-delivery-workflow.md](./06-customer-quote-delivery-workflow.md)
- Drive 양식:
  - [견적서 양식 (자동계산)](https://docs.google.com/spreadsheets/d/1Xbry0ulNh1UK5Ts6VCMBXfPAYfzT0ltAWQ8UMQnLCFk/edit?usp=drivesdk)

## 워크플로우

### 1. 견적 범위를 고정한다

- 기본 범위
- 옵션 범위
- 제외 범위

### 2. 금액 구조를 나눈다

- 기본안
- 옵션안
- 단계별 안
- 내부 단가 체계 기준으로 계산한다

### 3. 일정과 전제를 적는다

- 예상 기간
- 필요한 인력
- 고객이 확정해줘야 하는 것
- 우리가 가정한 전제

### 4. 견적서를 만든다

- 로컬 xlsx 원본 템플릿을 복사해서 openpyxl로 값을 수정한다
- `./tools/ops/mycompany-quote-finalize`로 하단 금액을 확정한다
- Numbers 앱으로 PDF를 변환한다
- xlsx + PDF 둘 다 Google Drive `견적서` 폴더에 업로드한다
- 내부 설명은 `견적 초안 템플릿`으로 정리한다
- 상세 절차는 [06-customer-quote-delivery-workflow.md](./06-customer-quote-delivery-workflow.md)를 따른다

### 5. 노션 CRM에 등록한다

- 견적서 Drive 링크를 CRM 본문에 남긴다
- 고객 메일 본문을 CRM 본문에 넣는다
- 메일 본문은 복사해서 이메일에 바로 붙여넣기 편하게 작성한다
- 마크다운 포맷을 최대한 자제한다
- 상태를 `제안 준비완료`로 바꾼다

### 6. 대환에게 전달한다

- 고객에게 바로 보내지 않는다
- 아래를 같이 전달한다
  - 범위
  - 옵션 차이
  - 금액 초안
  - 일정 초안
  - 확인 필요한 점

### 7. 최종 발송은 대환이 한다

- 대환이 확인한다
- 수정이 있으면 반영한다
- 최종 메일은 대환이 직접 보낸다
- 고객 발송물은 [06-customer-quote-delivery-workflow.md](./06-customer-quote-delivery-workflow.md) 기준으로 맞춘다

## 하지 말아야 할 것

- 범위가 안 잡혔는데 금액부터 말하기
- 옵션 차이를 빼고 한 금액만 던지기
- 연구 리스크를 고정가로 그대로 받기

## 한 줄 규칙

`견적은 먼저 만든다. 발송은 대환이 직접 한다.`
