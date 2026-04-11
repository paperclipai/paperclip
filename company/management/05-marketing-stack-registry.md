# 마케팅 스택 레지스트리

이 문서는 회사가 사용하는 마케팅/분석 도구의 계정, 속성, 소유자, 접근 위치를
정리하는 레지스트리다.

핵심은 하나다.

`도구를 쓰는 것`과 `도구를 관리하는 것`은 다르다.

## 목적

- 어떤 마케팅 도구를 실제로 쓰는지 한 번에 본다
- 계정, property, access를 잃어버리지 않는다
- 대표 1인 의존을 줄인다
- 지표를 어느 도구에서 봐야 하는지 흔들리지 않게 만든다

## 기록 원칙

- 실제 비밀번호나 민감 토큰은 쓰지 않는다
- 계정명, property, container, ad account, owner만 적는다
- 접근 위치와 권한 수준을 같이 적는다
- 새 채널이나 도구를 붙일 때 이 문서부터 갱신한다

## 등록 표

| 도구 | 역할 | 계정/속성 | 연결 사이트/앱 | 담당자 | 접근 위치 | 핵심 지표 | 상태 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Google Ads | 광고비 집행/최적화 | 고객 ID `728-412-2998` | `bbrightcode.com` 외주 모집 랜딩 | 대표 | `ads.google.com` / 로컬 `.env` | 비용, 클릭, 전환 | 운영중 |
| GA4 | 사이트 유입/웹 전환 | Property ID `447365681` | `bbrightcode.com` | 대표 | `analytics.google.com` / 로컬 `.env` | 세션, 전환, source/medium | 운영중 |
| PostHog | 제품 행동/활성화 | Project ID `335427` / Dashboard `1341533` | 랜딩 / 제품 행동 분석 | 대표 | `us.posthog.com` / 로컬 `.env` | 가입, 활성화, 유지 | 운영중 |
| GTM | 태그 전달 |  |  |  |  | 태그/이벤트 전달 상태 | 선택 |

## 도구별 꼭 적을 것

### Google Ads

- 고객 ID
- developer token 저장 위치
- 결제 주체
- 연결 전환
- 운영 캠페인

### GA4

- property 이름
- measurement ID
- OAuth 자격증명 저장 위치
- 주요 전환
- 연결된 사이트

### PostHog

- project 이름
- api host
- personal API key 저장 위치
- 주요 이벤트
- 연결 앱

### GTM

- container 이름
- container ID
- 연결된 사이트
- 발행 담당자

## 위험 신호

- 대표만 알고 있는 계정
- 어떤 property가 실제 운영용인지 불분명한 상태
- 광고 전환 정의와 제품 전환 정의가 섞인 상태
- UTM 규칙 없이 채널이 늘어나는 상태
- 아무도 안 보는 도구에 비용만 나가는 상태

## 운영 규칙

- 월 1회 레지스트리를 검토한다
- 새 도구/새 채널은 이 문서에 먼저 등록한다
- 중요 계정은 최소 2명이 접근 위치를 안다
- 역할이 겹치는 도구는 source of truth를 명확히 적는다

## 연결 문서

- [../operations/06-marketing-measurement-os.md](../operations/06-marketing-measurement-os.md)
- [../operations/07-marketing-performance-snapshot.md](../operations/07-marketing-performance-snapshot.md)
- [../templates/03-marketing-weekly-dashboard-template.md](../templates/03-marketing-weekly-dashboard-template.md)
- [../templates/04-marketing-tracking-plan-template.md](../templates/04-marketing-tracking-plan-template.md)

## 한 줄 정리

마케팅 스택 레지스트리는 회사가 `무슨 도구를 쓴다`를 넘어서,
`누가 어떤 숫자를 어디서 책임지고 보는가`를 정리하는 문서다.
