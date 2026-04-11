# Calendar Tools

이 폴더는 Google Calendar를 읽고, 일정 추가/수정에 쓰는 도구를 둔다.

핵심은 하나다.

`브라우저 로그인은 빠른 확인용, OAuth API는 안정적인 일정 조작용이다.`

## 들어있는 도구

- [google_calendar_oauth_bootstrap.py](./google_calendar_oauth_bootstrap.py)
- [google_calendar_cli.py](./google_calendar_cli.py)

## 환경변수

루트 `.env`에 아래 값을 둔다.

- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `GOOGLE_CALENDAR_REFRESH_TOKEN`
- `GOOGLE_CALENDAR_PRIMARY_ID`
- `GOOGLE_CALENDAR_COMPANY_CALENDAR_ID`
- `GOOGLE_CALENDAR_TIMEZONE`

## 가능한 작업

- OAuth refresh token 발급
- 캘린더 목록 보기
- 특정 기간 일정 목록 보기
- 일정 추가하기

## 예시

```bash
set -a; source /Users/bbright/Projects/company/.env; set +a

python3 /Users/bbright/Projects/company/tools/calendar/google_calendar_oauth_bootstrap.py
python3 /Users/bbright/Projects/company/tools/calendar/google_calendar_cli.py calendars
python3 /Users/bbright/Projects/company/tools/calendar/google_calendar_cli.py list --calendar-id primary --from-date 2026-03-16 --to-date 2026-03-17
python3 /Users/bbright/Projects/company/tools/calendar/google_calendar_cli.py insert \
  --calendar-id primary \
  --summary "미팅" \
  --start "2026-03-17T15:00:00+09:00" \
  --end "2026-03-17T16:00:00+09:00"
```

## 운영 원칙

- 일정 추가 전에는 가능한 한 충돌을 먼저 확인한다
- 회사 일정은 `비브라이트코드 일정` 캘린더를 우선 사용한다
- 개인 일정과 회사 공통 일정을 섞지 않는다

## OAuth 연결 순서

1. Google Cloud에서 Calendar API를 켠다
2. OAuth Client를 만든다
3. `.env`에 `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`를 넣는다
4. `google_calendar_oauth_bootstrap.py`를 실행해 refresh token을 발급받는다
5. 출력된 refresh token을 `.env`의 `GOOGLE_CALENDAR_REFRESH_TOKEN`에 저장한다
6. 이후 `google_calendar_cli.py`로 일정 조회/추가를 한다

## 한 줄 정리

이 도구는 `일정 조회`와 `대표 비서형 일정 추가`를 위한 최소 운영 도구다.
