# 마케팅 실적 스냅샷

이 문서는 `Google Ads`, `GA4`, `PostHog`의 최신 마케팅 실적과
대표 판단에 필요한 해석을 짧게 남기는 운영 스냅샷이다.

## 기준일

- 작성일: `2026-03-17`
- 최신 비교 기간: `2026-02-16 ~ 2026-03-16`
- 직전 비교 기간: `2026-01-17 ~ 2026-02-15`

## 1. 수집 출처

- API 스냅샷: `private-data/marketing-data/2026-03-17/`
- Google Ads: API 호출 시도 결과 `DEVELOPER_TOKEN_NOT_APPROVED`로 실패
- Google Ads 보조 출처: `2026-03-16` 브라우저 화면 스냅샷
- GA4 Property ID: `447365681`
- PostHog Project ID: `335427`

## 2. Google Ads

API 수집 상태:

- `2026-03-17` 기준 Google Ads API 자동 수집 실패
- 에러: `DEVELOPER_TOKEN_NOT_APPROVED`
- 의미: 현재 developer token이 실계정 조회 권한이 없어 정기 스냅샷 자동화가 막혀 있다

브라우저 화면 기준 최근 30일 수치:

- 기간: `2026-02-12 ~ 2026-03-13`
- 클릭수: `22`
- 노출수: `855`
- 평균 CPC: `₩3.55천`
- 비용: `₩78,091`
- 최적화 점수: `93%`
- 가용 잔액: `₩412,377`
- 마지막 결제: `₩500,000` (`2026-03-10`)

대표 캠페인:

- 캠페인명: `모바일 앱 외주개발`
- 비용: `₩78,091`
- 클릭수: `22`
- 클릭률: `2.57%`
- 원시 리드: `1.00`

해석:

- Paid Search가 실제 유입과 문의를 만들고 있는 정황은 `GA4`에서 확인된다
- 다만 Ads API가 막혀 있어 `검색어 낭비`, `키워드별 CPL`, `전환당 비용`을 자동으로 보지 못한다
- 현 단계의 가장 큰 문제는 집행 효율보다 `광고 최적화용 원본이 자동 수집되지 않는 상태`다

## 3. GA4

최근 30일 요약:

- 세션: `150` (`직전 30일 78`, `+92.3%`)
- 총 사용자: `125` (`직전 30일 76`, `+64.5%`)
- 이벤트 수: `1,468` (`직전 30일 400`, `+267.0%`)

채널별 세션:

- `Direct`: `68`
- `Paid Search`: `50`
- `Referral`: `12`
- `Organic Search`: `10`
- `Unassigned`: `6`
- `Cross-network`: `2`
- `Organic Social`: `2`

source / medium 상위:

- `(direct) / (none)`: `68`
- `google / cpc`: `50`
- `google / organic`: `10`

랜딩 페이지:

- `/`: `124` 세션
- `(not set)`: `8`
- `/aboutus`: `4`
- `/contact/success`: `4`
- `/contact`: `3`

핵심 이벤트:

- `cta_click`: `18`
- `form_start`: `6`
- `contact_submit_success`: `5`

이벤트 source / medium:

- `contact_submit_success`
- `(direct) / (none)`: `3`
- `google / cpc`: `2`
- `form_start`
- `(direct) / (none)`: `4`
- `google / cpc`: `2`

문의 관련 페이지뷰:

- `/contact`: `16`
- `/contact/success`: `7`

해석:

- 최근 30일 성장은 분명하다. 특히 `Paid Search 50세션`이 신규 볼륨 대부분을 만들었다
- 실제 문의 성공 이벤트도 `google / cpc`에서 `2건` 잡혀 있어 광고가 완전히 헛돌고 있지는 않다
- 다만 직전 30일에는 `cta_click`, `form_start`, `contact_submit_success`가 아예 없어
  성과 개선과 함께 `측정 세팅이 최근에 붙은 영향`도 같이 섞여 있다
- `(not set)`와 `contact_success_page / (not set)` 같은 값이 보여
  source / medium 정합성과 리퍼러 분류를 더 정리해야 한다

## 4. PostHog

최근 30일 요약:

- 페이지뷰: `132`
- `section_view`: `266`
- `scroll_depth`: `70`
- `nav_click`: `30`
- `cta_click`: `15`
- `contact_submit_success`: `3`

품질 신호:

- `$dead_click`: `178`
- `$rageclick`: `2`
- `$exception`: `2`

해석:

- 마케팅 퍼널 이벤트는 이미 들어오고 있다
- 하지만 `GA4 contact_submit_success 5` vs `PostHog contact_submit_success 3` 차이가 있어
  이벤트 정의 또는 유실률이 아직 완전히 정리되지 않았다
- PostHog 화면 경고대로 ad blocker 영향이 있을 가능성이 높고,
  `1st-party proxy` 적용 가치가 있다
- `$dead_click` 비중이 높아 CTA 주변 UI 클릭 실패 경험이 있는지 확인이 필요하다

## 5. 대표 판단

1. 최근 30일은 `유입 증가`가 실제로 있었다
2. 그 증가의 중심은 `google / cpc`다
3. 문의 이벤트도 일부 확인돼 광고 채널 자체를 끊을 단계는 아니다
4. 하지만 지금 숫자는 `성과 개선`과 `측정 세팅 완료`가 섞여 있어 과대해석하면 안 된다
5. 가장 큰 병목은 `전환 정의 불일치`와 `Ads API 권한 미해결`이다

## 6. 지금 바로 해야 할 것

1. Google Ads developer token을 `Basic` 이상으로 승인받아 자동 수집을 복구한다
2. `contact_submit_success`를 GA4와 PostHog 공통 핵심 전환으로 고정하고 QA한다
3. `contact_success_page / (not set)`와 `(not set)` source / medium 원인을 추적해 UTM 규칙을 바로잡는다
4. 검색 캠페인 검색어 보고서 기준으로 낭비 검색어와 느슨한 매치타입을 정리한다
5. Paid Search 전용 랜딩/카피 실험을 1개만 설계해 `/` 홈 의존도를 낮춘다
6. PostHog `1st-party proxy` 또는 reverse proxy를 검토해 이벤트 유실을 줄인다

## 7. 연결 문서

- [06-marketing-measurement-os.md](./06-marketing-measurement-os.md)
- [../management/05-marketing-stack-registry.md](../management/05-marketing-stack-registry.md)
- [../tools/marketing-data/fetch_marketing_snapshot.py](../tools/marketing-data/fetch_marketing_snapshot.py)

## 한 줄 정리

최근 30일 마케팅은 `유입은 늘었고 문의도 일부 늘었지만`,
지금 가장 먼저 고칠 것은 `전환 정의 정합성`과 `Ads 자동 수집 복구`다.
