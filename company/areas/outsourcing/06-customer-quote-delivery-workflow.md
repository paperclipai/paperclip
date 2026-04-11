# Customer Quote Delivery Workflow

기준일: 2026-03-18

이 문서는 `고객에게 실제로 견적서를 어떻게 전달할지` 정리한 운영 기준이다.

핵심은 하나다.

`고객 발송물은 이해하기 쉬워야 하고, 항상 같은 흐름으로 정리되어야 한다.`

## 언제 이 문서를 쓰는가

- 고객에게 견적 PDF를 실제로 보내야 할 때
- 블로그 포함안 / 제외안 같은 `복수 안`을 같이 보내야 할 때
- IT를 모르는 고객에게 쉬운 말로 설명해야 할 때
- 구축 이후 유지보수 옵션까지 함께 설명해야 할 때

## Source

- 내부 견적 기준: [03-quote-workflow.md](./03-quote-workflow.md)
- 내부 단가 체계: [05-pricing-framework.md](./05-pricing-framework.md)
- 고객 메일 템플릿: [../../templates/14-customer-quote-template.md](../../templates/14-customer-quote-template.md)
- 시트 원본 템플릿(Numbers 마스터): [../../templates/xlsx/견적서_템플릿.numbers](../../templates/xlsx/견적서_템플릿.numbers)
- 시트 작업용 템플릿(플레이스홀더): [../../templates/xlsx/견적서_템플릿_placeholder.xlsx](../../templates/xlsx/견적서_템플릿_placeholder.xlsx)
- 견적서 수정 체크리스트: [../../checklists/05-customer-quote-edit-checklist.md](../../checklists/05-customer-quote-edit-checklist.md)

## 기본 흐름

### 1. 고객이 실제로 말한 요구를 먼저 다시 정리한다

- 고객이 만든 참고 사이트
- 꼭 넣고 싶은 페이지
- 꼭 필요한 운영 기능
- 관리자 포함 여부
- 블로그 포함 여부
- 커뮤니케이션 선호 방식

원칙:

- 고객이 한 말을 우리가 잘 들었다는 느낌이 먼저 나야 한다
- 우리가 임의로 해석한 기술 용어를 앞세우지 않는다

### 2. 내부적으로는 범위와 가격을 먼저 고정한다

- 기본 골격
- 선택 feature
- 핵심요구 기능
- 포함 범위
- 제외 범위
- 예상 일정
- 외부 심사 리스크

원칙:

- 내부 계산은 `기본 골격 + feature + 핵심요구 기능`
- 고객이 요청한 비교안이 있으면 같이 만든다
- 예: 블로그 포함안 / 블로그 제외안

### 3. 견적서는 항상 xlsx 원본을 유지한다

- 기존 KUP 형식 xlsx를 기준으로 작업한다
- 값만 바꾼다
- 최종 발송은 PDF 기준으로 한다
- 수정할 때는 [../../checklists/05-customer-quote-edit-checklist.md](../../checklists/05-customer-quote-edit-checklist.md) 기준으로 필드를 하나씩 확인한다

xlsx 작업 순서:

1. 원본 템플릿을 복사해서 openpyxl로 값 수정한다
2. **항목 영역(`B12:C23`)의 `{{분류_N}}`, `{{항목_N}}` 플레이스홀더를 치환한다**
   - 항목별 단위금액은 넣지 않는다 — 총 공급가만 `K12`(`{{공급가액}}`)에 기재
   - 항목별 기간/개월차 설명은 넣지 않는다
   - 긴 부연 설명, 기능 상세, 일정 흐름, 별도 사항은 모두 하단 `A24`(`{{일정_설명}}`)에 넣는다
3. `./tools/ops/mycompany-quote-finalize {절대경로}.xlsx`로 하단 금액(F37/F38/F39)을 숫자로 확정한다
4. Numbers 앱으로 PDF 변환한다 (Excel은 매개변수 오류 발생, Numbers만 사용)
5. xlsx + PDF 둘 다 Google Drive `견적서` 폴더에 업로드한다
6. 노션 CRM 본문에 Drive 링크를 남긴다

Numbers PDF 변환 방법:

```
tell application "Numbers"
    open xlsxFile
end tell
delay 5
-- import dialog 자동 닫기
tell application "Numbers"
    export front document to pdfFile as PDF
    close front document saving no
    quit
end tell
```

- Numbers xlsx import 시 확인 dialog가 뜰 수 있어 delay를 충분히 준다
- Excel AppleScript `save as PDF`는 매개변수 오류(-50)가 발생하므로 사용하지 않는다

원칙:

- 포맷은 함부로 바꾸지 않는다
- 고객이 익숙한 형태를 유지한다
- xlsx는 내부 작업본, PDF는 고객 발송본이다
- 하단 `합계 / 부가세 / 총계`(F37/F38/F39)는 수식 의존 없이 최종 숫자를 넣는다
- 파일명은 `{고객명}{사람이면 "님", 회사면 생략}-개발견적서-{YYYYMMDD}.{확장자}` 형식으로 고정한다
  - 예: `이원재님-개발견적서-20260322.pdf`, `코메디닷컴-개발견적서-20260322.pdf`
- 견적서 제목 줄 `A1`은 사람 이름이면 `님`을 붙인다
- `최종`, `수정본`, `new` 같은 임시 표현은 파일명에서 쓰지 않는다
- 유지보수 견적이 없는 기본 발송본은 고객 발송용 작업본에서 `유지보수견적서`를 제거한다
- `유지보수견적서`는 유지보수 제안이 실제로 필요할 때만 고객 발송본에 함께 남긴다

xlsx 머지 셀 주의:

- A1:O3, A4:D8, A11:O11, C12:H12, I12:J23, K12:M23, N12:O23, A24:O36 등 큰 머지 영역이 있다
- 앵커 셀(A1, A4, A11, C12, I12, K12, N12, A24)만 수정한다
- 머지된 하위 셀에 직접 값을 넣으면 오류가 발생한다

### 4. 일정은 고객용 기준으로 적는다

- 내부 구현 완료 시점과 고객 안내 일정을 분리한다
- 고객용 일정은 `착수 후 3~4주` 기준으로 쓴다

고객용 설명 원칙:

- 내부 구현은 빠르게 끝내더라도 그대로 쓰지 않는다
- 고객에게는 `테스트`, `프리뷰`, `피드백 반영`, `최종 안정화`까지 포함한 일정으로 안내한다

권장 문구:

`개발은 빠르게 진행하되, 테스트와 확인 과정을 거친 뒤 먼저 보실 수 있는 화면을 공유드리고, 이후 피드백 반영과 마무리까지 포함해 전체 일정을 3~4주 기준으로 안내드립니다.`

### 5. 외부 기관 심사 지연 가능성을 반드시 넣는다

대상 예시:

- 카카오싱크 등 소셜 인증
- 결제사
- 외부 연동 서비스
- 도메인 연결 과정

고객용 문구 원칙:

- 기술 용어보다 결과 중심으로 쓴다
- 일정이 늦어질 수 있는 이유를 미리 설명한다

권장 문구:

`다만 카카오나 결제사 같은 외부 서비스의 확인 절차, 도메인 연결 과정 등에 따라 일부 기능의 반영 시점은 조금 달라질 수 있습니다.`

배치 원칙:

- `일정 / 유의사항`은 견적 항목 리스트에 넣지 않는다
- 푸터 바로 위 전체 머지 메모 블록에 넣는다
- 현재 표준 포맷 기준 위치는 `A24:O36`이다 — `{{일정_설명}}`

### 6. 고객 메일은 항상 두 단으로 쓴다

#### 윗부분

짧은 결론만 쓴다.

- 어떤 안을 보냈는지
- 얼마인지
- 언제 끝나는지

#### 아랫부분

쉬운 말로 상세 설명을 붙인다.

- 고객이 원한 방향을 어떻게 이해했는지
- 왜 이 범위로 구성했는지
- 옵션별 차이가 무엇인지
- 일정과 유의사항이 무엇인지

원칙:

- IT를 모르는 고객도 읽을 수 있어야 한다
- `SSL`, `DNS`, `리드 수집 구조`, `워크플로우` 같은 기술 용어는 고객 메일에서 줄인다
- 고객이 체감하는 표현으로 바꾼다

노션 CRM 본문 작성 원칙:

- 마크다운 포맷을 최대한 자제한다
- 노션에서 복사해서 이메일에 바로 붙여넣기 편해야 한다
- 표, 헤딩, 볼드 등은 구조 정리에만 최소한으로 쓴다
- 메일 본문 영역은 줄바꿈과 들여쓰기만으로 구성한다
- 고객에게 보내는 메시지 본문은 복붙 후 바로 발송 가능한 상태로 만든다

### 7. 복수 안을 보내야 하면 한 번에 비교되게 만든다

예시:

- 블로그 포함안
- 블로그 제외안

원칙:

- 각 안의 차이는 한 줄로 설명한다
- 가격 차이와 포함 범위 차이가 바로 보이게 한다
- 고객이 무엇을 선택하면 되는지 마지막에 다시 정리한다

### 8. 유지보수는 할인 대신 옵션으로 안내한다

원칙:

- 초기 사업자 할인처럼 바로 깎지 않는다
- 운영이 필요한 고객에게만 `월 관리 및 유지보수`를 옵션으로 말한다
- 구축 단가를 먼저 지키고, 운영 계약은 별도 논의한다

권장 문구:

`구축 이후 운영까지 함께 원하시면 월 관리 및 유지보수 방식도 별도로 안내드릴 수 있습니다.`

### 9. 최종안이 나오면 CRM도 같이 업데이트한다

- 최종 제안 메시지를 CRM 항목 본문에 넣는다
- 최종 견적 파일(xlsx + PDF)은 Google Drive `견적서` 폴더에 저장한다
- CRM 항목 본문에는 로컬 파일 경로 대신 `Drive 링크 + 파일명`을 남긴다
- 마지막 연락일을 갱신한다
- 상태를 `제안 준비완료`로 바꾼다

Google Drive 업로드:

- Google Drive `견적서` 폴더 URL: `https://drive.google.com/drive/folders/1MU-4RHfxiLwcepAeAZas0hl4NvN86_Xa`
- 폴더 ID: `1MU-4RHfxiLwcepAeAZas0hl4NvN86_Xa`
- 이 폴더에만 업로드한다. 새 폴더를 만들지 않는다
- xlsx 원본과 PDF를 둘 다 업로드한다
- 업로드는 `gcloud` ADC 인증 + `google-api-python-client`로 수행한다
- 인증이 안 되어 있으면 먼저 인증을 요청한다

gcloud ADC 인증 방법:

```
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/cloud-platform
```

- 기본 gcloud 토큰에는 Drive scope가 없어서 ADC 별도 인증이 필수다
- 인증 후 `~/.config/gcloud/application_default_credentials.json`이 생성된다
- 필요 패키지: `google-api-python-client`, `google-auth`

업로드 코드:

```python
from google.auth import default
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

creds, _ = default(scopes=['https://www.googleapis.com/auth/drive.file'])
creds.refresh(Request())
service = build('drive', 'v3', credentials=creds)

folder_id = '1MU-4RHfxiLwcepAeAZas0hl4NvN86_Xa'
file_meta = {'name': '파일명.pdf', 'parents': [folder_id]}
media = MediaFileUpload('경로/파일명.pdf', mimetype='application/pdf')
result = service.files().create(body=file_meta, media_body=media, fields='id,name,webViewLink').execute()
```

- 수정 시에는 `files().update(fileId=id, media_body=media)`로 기존 파일을 덮어쓴다

운영 원칙:

- 견적 PDF와 고객용 메시지는 CRM에 같이 남아 있어야 한다
- Notion 본문에는 로컬 절대경로를 남기지 않는다
- `제안 준비완료`는 고객 발송 직전의 내부 준비 상태다
- 현재 Notion API로는 status 옵션을 새로 추가할 수 없을 수 있으므로, 옵션이 없다면 Notion UI에서 먼저 한 번 추가해야 한다

## 고객 메일 문구 원칙

- 앞부분은 짧고 간결하게
- 아래에는 쉬운 상세 설명
- 고객이 실제로 말한 요구를 다시 반영
- 기술 용어 최소화
- 메일만 읽어도 무엇을 받는지 이해 가능해야 한다

## 하지 말아야 할 것

- 기술 용어를 그대로 메일에 넣기
- 옵션 차이가 있는데 한 안만 보내기
- 내부 구현 기간을 그대로 고객 일정으로 쓰기
- 외부 심사 지연 가능성을 빼기
- 고객이 왜 이 견적이 나왔는지 이해하지 못하게 쓰기

## 한 줄 규칙

`고객 견적 발송은 xlsx 원본 유지 + PDF 발송 + 짧은 결론 + 쉬운 상세 설명 + 옵션 비교 + CRM 업데이트로 고정한다.`
