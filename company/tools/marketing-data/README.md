# Marketing Data Tools

이 폴더는 마케팅/분석 도구의 데이터를 수집하거나 정리하는 도구를 두는 곳이다.

## 목적

- Google Ads, GA4, PostHog 등에서 핵심 숫자를 반복 수집한다
- 주간 대시보드 작성 시간을 줄인다
- 채널/유입/전환/활성화 숫자를 같은 포맷으로 정리한다

## 권장 구조

- `google-ads/`
- `ga4/`
- `posthog/`
- `snapshots/`

## 현재 수집 스크립트

- [fetch_marketing_snapshot.py](./fetch_marketing_snapshot.py)

예시:

```bash
python3 tools/marketing-data/fetch_marketing_snapshot.py \
  --from-date 2026-03-01 \
  --to-date 2026-03-16 \
  --save-dir private-data/marketing-data/2026-03-16
```

환경변수 예시는:

- [.env.example](./.env.example)

현재 로컬 운영 기준:

- repo 루트의 `.env`에 실제 값을 넣고 사용한다

## 우선순위

1. 광고비와 전환이 붙는 도구
2. 제품 활성화와 연결되는 도구
3. 운영 리듬에 바로 쓰이는 요약 스크립트

## 운영 원칙

- 실제 자격증명은 저장소에 두지 않는다
- 수집 결과는 원본과 요약을 같이 남긴다
- 주간/월간 리듬에 맞는 숫자부터 가져온다

## 연결 문서

- [../../operations/06-marketing-measurement-os.md](../../operations/06-marketing-measurement-os.md)
- [../../management/05-marketing-stack-registry.md](../../management/05-marketing-stack-registry.md)
- [../../templates/03-marketing-weekly-dashboard-template.md](../../templates/03-marketing-weekly-dashboard-template.md)
- [../../templates/04-marketing-tracking-plan-template.md](../../templates/04-marketing-tracking-plan-template.md)
