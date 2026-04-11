# GitHub Work Tools

이 폴더는 GitHub 활동 데이터를 가져와
회사의 `실제 작업 상태`를 읽기 위한 도구를 두는 곳이다.

## 목적

- 하루 기준 실제 코드 작업 상태를 본다
- 누가 어떤 저장소에서 움직였는지 본다
- 커밋, PR, 업데이트 흐름을 통해 팀의 실제 실행 상태를 읽는다
- Linear의 계획과 GitHub의 실제 움직임을 같이 본다

## 핵심 원칙

- GitHub 활동은 `실제 코드 움직임`을 보여준다
- 하지만 이것만으로 사람을 평가하지는 않는다
- `커밋 수`가 아니라 `어디서 무엇이 움직였는지`를 읽어야 한다

## 현재 도구

- [fetch_daily_work_status.py](./fetch_daily_work_status.py)

예시:

```bash
python3 tools/github/fetch_daily_work_status.py \
  --date 2026-03-16 \
  --save-dir private-data/github/2026-03-16
```

## 필요한 환경변수

- `GITHUB_TOKEN`
- `GITHUB_WORK_ORGS`
- `GITHUB_WORK_REPOS`
- `GITHUB_REPO_EXCLUDE_PATTERNS`

## 연결 문서

- [../../operations/10-github-work-activity.md](../../operations/10-github-work-activity.md)
