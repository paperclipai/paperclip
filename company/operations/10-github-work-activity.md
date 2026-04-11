# GitHub 작업 상태 운영

이 문서는 GitHub 활동을 이용해
회사의 `실제 작업 상태`를 매일 확인하기 위한 운영 기준 문서다.

핵심은 하나다.

`계획은 Linear에 있고, 실제 코드 움직임은 GitHub에 있다.`

## 왜 필요한가

- 대표는 팀의 실제 실행 상태를 매일 볼 수 있어야 한다
- Linear에는 계획이 있고, GitHub에는 실제 코드 활동이 남는다
- 둘을 함께 봐야 `계획 대비 실제 움직임`이 보인다

## 이 문서에서 보는 것

- 누가 오늘 어떤 저장소에서 움직였는가
- 커밋이 있었는가
- PR이 열리거나 업데이트되었는가
- 머지된 PR이 있었는가
- 저장소별 실제 활동량은 어땠는가

## 중요한 원칙

- GitHub 활동은 `실제 코드 움직임`을 보여준다
- 하지만 이것만으로 사람을 평가하지 않는다
- 고객 대응, 기획, 조사, 회의, 문서화는 GitHub에 그대로 남지 않을 수 있다
- 그래서 `Linear + GitHub + 회의록`을 같이 봐야 한다

## 현재 수집 구조

도구:

- [../tools/github/fetch_daily_work_status.py](../tools/github/fetch_daily_work_status.py)

환경변수:

- `GITHUB_TOKEN`
- `GITHUB_WORK_ORGS`
- `GITHUB_WORK_REPOS`
- `GITHUB_REPO_EXCLUDE_PATTERNS`

현재 기본 범위:

- `BBrightcodeDev`
- `BBrightcode-atlas`

제외 패턴:

- `sb-gen-e2e-test`

## 대표가 매일 볼 항목

### 사람별

- 커밋 수
- PR 변화 수
- 머지된 PR 수
- 작업한 저장소
- 최근 커밋 메시지

### 저장소별

- 오늘 실제로 움직인 저장소
- 커밋 발생 수
- PR 변화 수

## 운영 리듬

### 매일

- 오늘 작업 상태 스냅샷 확인
- GitHub 활동이 0인 사람을 바로 문제로 해석하지 않음
- 대신 `Linear 계획`, `회의록`, `고객 대응`과 같이 해석

### 매주 Cycle

- 이번 주 실제 코드 이동이 있었는지 확인
- 계획 대비 실제 출하/머지 흐름이 있는지 확인

## 지금 해석할 때 주의할 것

- 커밋 수가 많다고 좋은 것은 아니다
- 커밋 수가 적다고 일하지 않은 것도 아니다
- 중요한 건 `핵심 저장소에서 실제 변화가 있었는가`다
- PR이 오래 열려 있거나 머지가 안 되는 상태는 병목 신호일 수 있다

## 연결 문서

- [08-meeting-notes-operating-model.md](./08-meeting-notes-operating-model.md)
- [../checklists/02-weekly-ceo-checklist.md](../checklists/02-weekly-ceo-checklist.md)
- [../tools/github/README.md](../tools/github/README.md)

## 한 줄 정리

GitHub는 팀을 감시하는 도구가 아니라,
대표가 `실제 작업 움직임`을 읽는 운영 보드다.
