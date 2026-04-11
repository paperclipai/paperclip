# Sales CRM Source Of Truth

이 문서는 회사의 영업 CRM 데이터를 어디서 읽고, 어떤 기준으로 해석할지 정리하는 문서다.

핵심은 하나다.

`CRM 관련 질문은 이 노션 DB를 먼저 읽고 답한다.`

## 기준 DB

- 이름: `👟 영업 CRM`
- Notion URL: [영업 CRM](https://www.notion.so/bbrightcode/d946b819646446b486d489ae5eaa9e2c?v=687226c455f2499192a2dfa618336d31&source=copy_link)
- Data source ID: `collection://31553d5f-2207-4320-8aa5-c23160d0601a`

## 이 DB를 source of truth로 보는 항목

- 현재 리드 목록
- 상태별 파이프라인
- 예상 가치
- 우선순위
- 마지막 연락일
- 예상 종료일
- 고객 담당자
- 문의내용
- 메모

## 상태 체계

- `리드`
- `잠재 고객`
- `제안 준비완료`
- `제안`
- `협상`
- `논의 중`
- `성공`
- `실패`
- `종결`

주의:

- `제안 준비완료`는 최종 제안 메시지와 견적서가 CRM 항목에 반영된 내부 준비 상태다
- 현재 Notion API로는 status 옵션 추가가 제한될 수 있어, 이 상태는 Notion UI에서 먼저 한 번 생성해야 한다

## 주요 필드

- `이름`
- `회사`
- `이메일`
- `전화번호`
- `우선순위`
- `상태`
- `예상 가치`
- `마지막 연락일`
- `예상 종료일`
- `고객 담당자`
- `문의내용`
- `메모`
- `추가 일시`

## 운영 원칙

- CRM 관련 질문은 이 DB를 먼저 읽고 답한다
- 기억이나 별도 메모보다 CRM DB 값을 우선한다
- 파이프라인 해석은 `상태`, `우선순위`, `예상 가치`, `마지막 연락일`을 함께 본다
- 영업 기회 문서와 CRM이 충돌하면 CRM을 먼저 확인한다
- 최종 제안 메시지와 견적안은 CRM 항목 본문에 남긴다
- CRM 본문의 메일 내용은 복사해서 이메일에 바로 붙여넣기 편하게 작성한다 (마크다운 포맷 최대한 자제)
- 견적 원본(xlsx + PDF)은 Google Drive `견적서` 폴더에 저장하고, CRM 본문에는 Drive 링크를 남긴다
  - Drive 폴더 ID: `1MU-4RHfxiLwcepAeAZas0hl4NvN86_Xa`
- 견적서 수정 필드 점검은 [../checklists/05-customer-quote-edit-checklist.md](../checklists/05-customer-quote-edit-checklist.md) 기준으로 맞춘다

## 연결 문서

- [06-active-opportunities.md](./06-active-opportunities.md)
- [07-project-intake-matrix.md](./07-project-intake-matrix.md)

## 한 줄 정리

회사의 영업 파이프라인은 `노션 영업 CRM`을 기준으로 읽고 말한다.
