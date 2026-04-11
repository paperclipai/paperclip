# Google Calendar 운영 방식

이 문서는 회사 일정 운영을 위해 Google Calendar를 어떻게 읽고, 추가하고,
수정할지를 정리하는 기준 문서다.

핵심은 하나다.

`지금은 브라우저 로그인으로 빠르게 읽고, 안정적인 일정 추가/수정은 OAuth API로 붙인다.`

## 결론

- 단순한 `API 키`만으로는 private Google Calendar의 읽기/쓰기 운영에 부족하다
- public calendar 조회 정도는 API 키로 가능하지만, 대표 일정과 회사 일정의 읽기/추가는
  `OAuth 2.0` 연결이 기본이다
- 따라서 회사 운영 기준은 아래 2단계로 간다
  - 1단계: 로그인된 크롬 탭으로 빠르게 읽기
  - 2단계: OAuth 연결 후 일정 조회/추가/수정/삭제 자동화

## 지금 가능한 것

현재 로그인된 크롬 탭 기준으로 아래는 바로 가능하다.

- 월간/주간에 보이는 일정 읽기
- 반복되는 회사 운영 리듬 확인
- 오늘/이번 주 일정 빠른 요약
- 특정 일정이 이미 보이는지 확인

## 안정적으로 하고 싶은 것

OAuth 연결 후에는 아래를 안정적으로 처리할 수 있다.

- `오늘 일정 읽어줘`
- `이번 주 중요한 일정만 정리해줘`
- `내일 15시에 누구랑 미팅 추가해줘`
- `비브라이트코드 일정 캘린더에 팀 회의 넣어줘`
- `기존 일정 시간만 30분 뒤로 미뤄줘`
- `반복 일정으로 Daily Focus 등록해줘`

## 현재 확인된 일정 운영 리듬

2026-03-16 기준, 로그인된 캘린더 화면에서 아래 운영 리듬이 보였다.

- 계정: `bright@bbrightcode.com`
- 캘린더:
  - `개인일정`
  - `Tasks`
  - `비브라이트코드 일정`
  - `생일`
  - `대한민국의 휴일`
- 월간 표시 기준 일정 수: `2026년 3월, 41개`

현재 보이는 반복 리듬은 아래와 같다.

- `[전체] Sync Meeting`
  - 매주 월요일
  - `10:00 ~ 11:00`
- `[전체] Daily Focus`
  - 평일 반복
  - `13:00 ~ 13:10`

즉, Google Calendar는 이미 회사 운영 리듬의 일부다.

## 브라우저 세션에서 확인한 실제 정보

2026-03-16 기준, 로그인된 브라우저 세션에서 아래를 확인했다.

- Google 계정: `bright@bbrightcode.com`
- 회사 캘린더 이름: `비브라이트코드 일정`
- 회사 캘린더 ID: `c_8de9ce46159896b07b421af0e8fea7388333a6ace0641296d7735f863b50a4e6@g`

즉, OAuth를 나중에 붙이더라도 회사 캘린더 식별값은 이미 확보된 상태다.

## 추천 운영 방식

### 1. 캘린더 역할 구분

- `비브라이트코드 일정`
  - 회사 공통 회의
  - 마감
  - 급여/세금/관리 일정
- `개인일정`
  - 개인 약속
  - 대표 개인 리마인더

### 2. 대표 비서 동작 기준

- 읽기 요청은 우선 캘린더에서 본다
- 일정 추가/수정은 항상 아래를 먼저 확인한다
  - 날짜
  - 시작/종료 시각
  - 종일 여부
  - 어느 캘린더에 넣을지
  - 참석자 초대 여부
- 겹치는 일정이 있으면 먼저 알려준다

### 3. 운영상 주의할 것

- 회사 일정과 개인 일정을 섞어 넣지 않는다
- 반복 일정은 반드시 캘린더를 지정한다
- `[]`, 빈 제목, 임시 메모 일정은 정리 대상이다
- 월 1회 캘린더 구조를 점검한다

## 권장 인증 방식

### 브라우저 로그인 기반

장점:

- 지금 바로 읽기 가능
- 로그인된 세션에서 실제 캘린더 식별 정보도 일부 확보 가능
- 준비 비용이 없다

단점:

- 화면에 보이는 범위만 읽기 쉽다
- 안정적인 추가/수정/삭제에는 약하다
- 브라우저 구조가 바뀌면 깨질 수 있다

### Google Calendar API + OAuth

장점:

- 일정 조회/추가/수정/삭제를 안정적으로 할 수 있다
- 날짜 범위별 질의가 쉽다
- 나중에 일간 브리핑 자동화로 이어가기 좋다

단점:

- OAuth 설정이 필요하다
- refresh token 관리가 필요하다

## 필요한 환경변수

실제 비밀값은 `.env`에서 관리한다.

- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `GOOGLE_CALENDAR_REFRESH_TOKEN`
- `GOOGLE_CALENDAR_PRIMARY_ID`
- `GOOGLE_CALENDAR_COMPANY_CALENDAR_ID`
- `GOOGLE_CALENDAR_TIMEZONE`

## 연결 후 가능한 대표 비서 워크플로우

- 아침마다 `오늘 일정 + 중요한 마감 + 비는 시간` 요약
- 회의 추가 전 충돌 확인
- 회의 전 관련 문서 링크 모으기
- Daily Focus, Sync Meeting 같은 운영 리듬 유지 점검

## 연결 문서

- [./08-meeting-notes-operating-model.md](./08-meeting-notes-operating-model.md)
- [../templates/06-weekly-cycle-template.md](../templates/06-weekly-cycle-template.md)
- [../tools/calendar/README.md](../tools/calendar/README.md)
- [../tools/calendar/google_calendar_oauth_bootstrap.py](../tools/calendar/google_calendar_oauth_bootstrap.py)
- [../tools/calendar/google_calendar_cli.py](../tools/calendar/google_calendar_cli.py)

## 한 줄 정리

Google Calendar는 단순 참고용 일정판이 아니라,
`대표 일정 관리`와 `회사 운영 리듬`을 함께 담는 실행 캘린더다.
