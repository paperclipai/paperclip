# Tools

이 폴더는 회사 운영을 자동화하는 `수집기`, `조회 CLI`, `운영 스크립트`를 모아두는 영역이다.

핵심은 하나다.

`대표가 물으면 바로 답할 수 있게, 운영 데이터를 수집하는 도구를 여기서 관리한다.`

## 하위 영역

- `alfred/`: 회계, 세금계산서, 카드, 입출금 수집
- `ops/`: Daily Focus, Cycle 등 운영 루프용 CLI
- `setup/`: 새 컴퓨터에서 repo 기반 스킬/환경 연결
- `calendar/`: 구글 캘린더 조회 / 추가 CLI
- `drive/`: 구글 드라이브 조회 CLI
- `github/`: GitHub 작업 상태 수집
- `marketing-data/`: Google Ads, GA4, PostHog 실적 수집
- `ai-usage/`: AI 벤더 사용량 수집용 자리

## 운영 원칙

- 도구는 source of truth를 긁어오는 역할만 한다
- 해석과 판단은 `operations/` 문서에서 한다
- 민감한 자격증명은 `.env`나 외부 시크릿 저장소에 두고, 코드에는 남기지 않는다

## 빠른 입구

- `./tools/ops/mycompany-chapter`
- `./tools/ops/mycompany-cycle`
- `./tools/ops/mycompany-daily-focus`
- `./tools/setup/mycompany-install-skills`
