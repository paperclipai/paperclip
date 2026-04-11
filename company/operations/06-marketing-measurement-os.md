# 마케팅 측정 운영

이 문서는 회사의 마케팅 데이터를 `Google Ads`, `GA4`, `PostHog` 중심으로
포괄 관리하기 위한 운영 기준 문서다.

핵심은 하나다.

`도구를 늘리는 것`이 아니라 `각 도구가 어떤 질문에 답하는지`를 분명히 하는 것이다.

## 왜 이 문서가 필요한가

- 광고비, 유입, 전환, 제품 활성화가 서로 다른 도구에 흩어져 있다
- 같은 숫자라도 도구마다 정의가 달라 대표 판단이 흔들릴 수 있다
- 외주/예약관리 패키지/장기 SaaS/게임 투자 등 회사의 성격이 섞여 있어
  마케팅 숫자를 더 선명하게 나눠서 봐야 한다

## 1. 도구별 역할

### Google Ads

이 도구는 `광고 집행과 광고비 효율`을 본다.

- 캠페인
- 광고그룹
- 키워드
- 검색어
- 클릭
- 광고비
- 광고 기준 전환

이 도구가 답하는 질문:

- 어떤 캠페인이 돈을 쓰고 있는가
- 어떤 키워드/검색어가 낭비를 만들고 있는가
- 어떤 광고가 실제 문의나 전환에 기여하는가

### GA4

이 도구는 `사이트 유입과 웹 전환`을 본다.

- 세션
- 사용자
- source / medium / campaign
- 랜딩 페이지
- 전환 이벤트
- 유입 경로별 사이트 성과

이 도구가 답하는 질문:

- 어떤 채널에서 유입이 오는가
- 어떤 랜딩 페이지가 전환을 만들고 있는가
- 어떤 source / medium / campaign 조합이 좋은가

### PostHog

이 도구는 `제품 행동과 활성화`를 본다.

- 회원가입
- 온보딩
- 핵심 workflow 완료
- 활성 사용자
- 기능 사용
- 유지/이탈

이 도구가 답하는 질문:

- 들어온 사용자가 실제 가치를 느끼는가
- 어떤 행동이 활성화와 유지로 이어지는가
- 제품 안에서 어디서 막히는가

### GTM

이 도구는 `전달 레이어`다.

- 태그 설치
- 이벤트 전달
- 마케팅 픽셀 연결

중요한 원칙:

- GTM은 `전달`을 담당한다
- 진실의 원천(source of truth)은 아니다

## 2. 우리 회사 기준 Source of Truth

| 질문 | 기본으로 볼 도구 | 보조로 볼 도구 |
| --- | --- | --- |
| 광고비를 어디에 썼는가 | Google Ads | GA4 |
| 어떤 채널이 사이트 유입을 만들었는가 | GA4 | Google Ads |
| 어떤 랜딩이 문의/전환을 만들었는가 | GA4 | PostHog |
| 제품 가입 후 실제 활성화가 일어났는가 | PostHog | GA4 |
| 제품 안에서 어떤 행동이 가치 전달인가 | PostHog | 내부 DB |
| 광고 유입이 실제 활성화까지 이어졌는가 | GA4 + PostHog 연결 해석 | Google Ads |

## 3. 우리 팀에 필요한 최소 측정 구조

### 상단 퍼널

- 광고비
- 클릭
- 방문
- 문의
- 미팅
- 제안
- 수주

### 제품 퍼널

- 방문
- 회원가입
- 첫 핵심 행동
- workflow 완료
- 재방문
- 유료 전환

### 공통 원칙

- 상단 퍼널은 `GA4 + Ads`
- 제품 퍼널은 `PostHog`
- 같은 전환이라도 광고 최적화용 정의와 제품 운영용 정의를 분리한다

## 4. 지금 우선 봐야 할 핵심 지표

### 대표 주간 지표

- 광고비
- 유효 리드 수
- 문의 수
- 랜딩 전환율
- 회원가입 수
- 활성화 수
- 유료 전환 수

### 채널 지표

- source / medium / campaign별 세션
- 랜딩 페이지별 문의율
- 광고 캠페인별 CPL
- 검색어별 낭비 지출

### 제품 지표

- signup_completed
- onboarding_completed
- first_value_delivered
- workflow_completed
- retained_team

## 5. 이벤트/이름 원칙

- 이벤트는 `snake_case`
- 되도록 `object_action` 형태로 쓴다
- 같은 의미의 이벤트를 여러 이름으로 만들지 않는다
- 제품의 핵심 가치 이벤트는 하나로 모은다

예:

- `contact_submitted`
- `signup_completed`
- `onboarding_completed`
- `workflow_completed`
- `value_delivered`

## 6. UTM 운영 원칙

- 모든 외부 유입 링크는 UTM을 붙인다
- `utm_source`, `utm_medium`, `utm_campaign`는 반드시 통일된 규칙으로 쓴다
- UTM 규칙은 문서로 관리하고, 사람 기억에 맡기지 않는다

## 7. 대표 운영 리듬

### 매주

- 광고비와 유효 리드 확인
- 랜딩 전환율 확인
- 제품 활성화 확인
- 낭비 채널 1개 끊기 또는 조정하기

### 매월

- 채널별 CAC 관점 검토
- 유입 대비 활성화율 검토
- 어떤 채널이 `문의`가 아니라 `좋은 고객`을 만드는지 검토
- 추적 누락, 이벤트 품질 문제 점검

## 8. 지금 먼저 해야 할 것

1. 현재 쓰는 마케팅 도구 계정 정리
2. 현재 전환 정의 정리
3. 현재 UTM 규칙 정리
4. GA4 / Ads / PostHog 역할 구분 고정
5. 주간 대시보드 포맷 고정

## 8-1. 자동 수집 원칙

- `Google Ads`는 OAuth access token + developer token 기준으로 수집한다
- `GA4`는 Google OAuth 기준으로 `runReport`를 호출한다
- `PostHog`는 personal API key 기준으로 query API를 호출한다
- 결과는 `private-data/marketing-data/` 아래 스냅샷으로 남긴다
- 이후 질의응답은 저장된 스냅샷을 기준으로 빠르게 답한다

## 9. 연결 문서

- [../management/05-marketing-stack-registry.md](../management/05-marketing-stack-registry.md)
- [07-marketing-performance-snapshot.md](./07-marketing-performance-snapshot.md)
- [../templates/03-marketing-weekly-dashboard-template.md](../templates/03-marketing-weekly-dashboard-template.md)
- [../templates/04-marketing-tracking-plan-template.md](../templates/04-marketing-tracking-plan-template.md)
- [../tools/marketing-data/README.md](../tools/marketing-data/README.md)

## 한 줄 정리

마케팅 운영의 핵심은 `광고비`, `유입`, `전환`, `활성화`를
각 도구의 역할에 맞게 분리해서 한 체계로 보는 것이다.
