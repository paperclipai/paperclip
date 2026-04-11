# Superbuilder Source Of Truth

기준일: 2026-03-17

이 문서는 회사가 `superbuilder를 어떤 시스템으로 보고, 어떤 질문에서 먼저 읽어야 하는지`를 고정하는 운영 기준 문서다.

핵심은 하나다.

`superbuilder는 코드 몇 개를 빠르게 만드는 도구가 아니라, 반복 가능한 SaaS 출하 체계의 원본 시스템이다.`

## 목적

- superbuilder 관련 질문의 1차 요약 정본을 고정한다
- 전략, 견적, 리드 판단, 제품 대화에서 같은 정의를 쓰게 만든다
- 외부 설명과 내부 설명을 분리한다
- live repo와 회사 repo의 역할을 분명히 나눈다

## 한 줄 정의

`superbuilder는 랜딩 + 어플리케이션 + 관리자 + 서버를 조합식으로 빠르게 출하하는 내부 SaaS 팩토리다.`

## Source Of Truth

질문 순서는 아래처럼 고정한다.

1. 이 문서
2. [../strategy/02-superbuilder-positioning.md](../strategy/02-superbuilder-positioning.md)
3. [../strategy/03-2026-03-development-view.md](../strategy/03-2026-03-development-view.md)
4. live repo: `/Users/bright/Projects/superbuilder`
5. GitHub: `BBrightcode-atlas/superbuilder`

역할 구분:

- 이 문서: 대표 판단용 운영 기준
- `02-superbuilder-positioning`: 전략 해석
- `03-2026-03-development-view`: 개발/납품 해석
- live repo: 실제 구현 원본

## 구성 레이어

### 1. Composer Layer

역할:

- 랜딩
- 어플리케이션
- 관리자
- 서버

의미:

- 고객별 출하물의 기본 골격을 빠르게 여는 층

### 2. Feature Layer

역할:

- 예약
- 블로그
- 게시판
- 결제
- 커뮤니티
- 기타 도메인 기능

의미:

- 고객 요구를 개별 개발보다 `조합 가능한 재사용 단위`로 흡수하는 층

### 3. Customization Layer

역할:

- 브랜딩
- 카피
- 도메인 정책
- 허용된 범위의 설정값

의미:

- 자유 개발이 아니라 `설정형 납품`으로 끝내기 위한 경계층

### 4. Delivery Layer

역할:

- Git 연결
- DB 연결
- Neon 연결
- Vercel 연결
- 로그인 초기 세팅
- 배포 흐름

의미:

- 생성 이후의 인프라 연결과 실제 납품 가능 상태까지 묶는 층

## 납품 흐름

superbuilder 기반 납품은 아래 흐름으로 본다.

1. composer로 기본 골격을 연다
2. 필요한 feature를 조합한다
3. 브랜드와 정책을 고객 문맥에 맞게 세팅한다
4. Git, DB, Neon, Vercel, 로그인 흐름을 연결한다
5. 데모 또는 실제 출하물로 확인한다
6. 이번 납품에서 생긴 예외를 다음부터 preset, feature, setting으로 흡수한다

즉, 납품의 핵심은 `앱을 하나 완성`하는 것이 아니라
`다음 고객에서 더 빨라지는 구조를 남기는 것`이다.

## 재사용 자산 규칙

### 원칙 1

superbuilder의 목표는 만능 빌더가 되는 것이 아니다.

### 원칙 2

새 납품이 나갈 때마다 엔진이 더 강해져야 한다.

### 원칙 3

고객 요청은 가능하면 아래 셋 중 하나로 흡수한다.

- feature
- preset
- setting

### 원칙 4

직접 코드 수정으로 끝난 요구는 다음 납품 전까지 재사용 가능한 스펙으로 올리는 방향을 우선 검토한다.

### 원칙 5

대표와 핵심 개발자가 매번 깊게 붙어야 하는 구조라면 아직 상품화가 끝난 것이 아니다.

## 견적 / 수주 연결 규칙

견적은 페이지 수가 아니라 `출하 복잡도`와 `재사용 가능 자산 축적` 기준으로 본다.

먼저 아래 3가지를 본다.

1. 이 요청이 superbuilder의 기존 preset / feature / setting으로 흡수되는가
2. 이번 대응이 다음 납품에도 재사용 가능한가
3. 설정형 납품인가, 커스텀 개발인가

### 유형 1. 홍보형 웹

기준:

- 랜딩 중심
- 운영 표면이 거의 없음
- 외부 연동이 단순함
- superbuilder에서 대부분 설정형으로 해결 가능

판단:

- 가장 낮은 복잡도
- 빠른 출하 체계의 골격만 쓰는 유형

### 유형 2. 리드 수집형 웹

기준:

- 문의 흐름
- 웹훅, 알림, 간단한 CRM 수집
- 로그인 1종 또는 단순 외부 연동
- 운영보다는 전환이 핵심

판단:

- 페이지 수보다 `전환 플로우와 연동 안정성`이 더 중요하다

### 유형 3. 운영형 웹

기준:

- 관리자
- 블로그/CMS
- 권한
- 콘텐츠 운영
- 내부 운영 표면이 붙음

판단:

- 운영 표면과 반복 관리 비용이 붙기 때문에 한 단계 높은 복잡도로 본다

### 유형 4. 서비스 / MVP형

기준:

- 고객용 앱 흐름
- 상태 관리
- 회원 기능
- 결제 또는 복잡한 도메인 로직
- 새 feature 추가 가능성 존재

판단:

- 설정형 납품을 넘어 실제 서비스 구축에 가깝다
- 매출보다 `superbuilder 강화 여부`와 `집중 손상`을 같이 봐야 한다

### 수주 판단 원칙

- 기존 엔진을 강화하면 긍정 검토 가능
- 단순 소모형 커스텀으로 끝나면 보수적으로 본다
- 매출만 좋고 superbuilder 적합성이 낮으면 조건부로 본다
- 범위가 커질수록 단계별 견적과 범위 고정이 필수다

## 대외 메시지 원칙

외부에는 `superbuilder` 이름을 전면에 내세우지 않는다.

고객에게는 아래 표현으로 설명한다.

- 빠른 출하 체계
- 반복 가능한 납품 구조
- 안전한 전환 방식
- 랜딩, 앱, 관리자, 서버를 한 흐름으로 정리하는 체계

피해야 할 표현:

- 만능 빌더
- 무엇이든 바로 만들어준다
- 1시간이면 다 된다
- 내부 엔진 이름과 구조를 과하게 상세히 설명

권장 설명:

- 기존 요구를 빠르게 조합하고, 운영 리스크를 낮춘 상태로 출하한다
- 한 번 만들고 끝나는 외주가 아니라 반복 가능한 구조로 정리해 납품한다
- 고객별 요구도 가능하면 재사용 가능한 구조 안에서 반영한다

## 같이 읽어야 하는 문서

- [../strategy/02-superbuilder-positioning.md](../strategy/02-superbuilder-positioning.md)
- [../strategy/03-2026-03-development-view.md](../strategy/03-2026-03-development-view.md)
- [15-current-company-brief.md](./15-current-company-brief.md)
- [16-source-of-truth-map.md](./16-source-of-truth-map.md)
- [../checklists/04-superbuilder-feature-design-checklist.md](../checklists/04-superbuilder-feature-design-checklist.md)
- [../management/06-active-opportunities.md](../management/06-active-opportunities.md)
- [../areas/outsourcing/02-intake-decision-workflow.md](../areas/outsourcing/02-intake-decision-workflow.md)
- [../areas/outsourcing/03-quote-workflow.md](../areas/outsourcing/03-quote-workflow.md)

## 대표용 한 줄

`superbuilder는 빠른 개발 도구가 아니라, 납품할수록 더 강해져야 하는 내부 출하 엔진이다.`
