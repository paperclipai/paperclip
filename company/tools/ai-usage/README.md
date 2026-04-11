# AI Usage Tools

이 폴더는 AI 벤더별 `사용량`과 `비용` 데이터를 가져오기 위한 도구를 두는 곳이다.

## 목적

- 벤더별 usage/billing 데이터를 반복적으로 수집한다
- 프로젝트별 비용 해석에 필요한 원본 숫자를 남긴다
- 월간 AI 사용량 보고서 작성 시간을 줄인다

## 권장 출력 구조

- `private-data/ai-usage/{vendor}/{YYYY-MM}/raw.json`
- `private-data/ai-usage/{vendor}/{YYYY-MM}/summary.md`

## 우선순위

1. 비용이 가장 큰 벤더
2. 고객 프로젝트에 직접 붙는 벤더
3. 대표 개인 계정 의존이 큰 벤더

## 운영 원칙

- 실제 Key는 저장소에 두지 않는다
- 도구는 `env var` 기준으로 동작하게 만든다
- 수집 결과는 원본과 요약을 같이 남긴다
- 월 단위 스냅샷을 남긴다

## 연결 문서

- [../../operations/05-ai-usage-management.md](../../operations/05-ai-usage-management.md)
- [../../management/04-ai-vendor-registry.md](../../management/04-ai-vendor-registry.md)
- [../../templates/02-ai-usage-report-template.md](../../templates/02-ai-usage-report-template.md)
