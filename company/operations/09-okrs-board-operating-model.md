# OKRs 보드 운영 모델

이 문서는 노션 `🎯 OKRs` 보드를 읽고,
현재 회사 운영 체계 안에서 이 보드가 어떤 역할을 해야 하는지 정리하기 위한 문서다.

기준일:

- `2026-03-16`

## 1. 현재 보드 구조 요약

현재 노션 페이지:

- 제목: `🎯 OKRs`
- 한 줄 목적: 측정 가능한 지표와 함께 야심 찬 장기 목표를 설정
- 회사 목적 문구:
  - `전세계 게이머들에게 스토리가 풍부한 게임을 언어의 장벽없이 경험하게 하자`

구성:

- `목표` 데이터베이스
- `핵심 결과지표` 데이터베이스

즉, 구조 자체는 전형적인 `Objective + Key Result` 보드다.

## 2. 좋은 점

- 장기 방향을 잊지 않게 해준다
- 목표와 측정 지표를 연결하려는 의도가 있다
- 회사 목적 문구를 고정해두는 점은 좋다

## 3. 지금 팀에서 생길 수 있는 문제

### 1. Chapter와 역할이 겹친다

지금 회사는 이미 `2개월 Chapter`를 핵심 정렬 단위로 쓰고 있다.

이때 OKRs 보드를 별도 운영 체계로 강하게 돌리면 아래가 겹친다.

- 챕터 목표
- Must-win goals
- OKR objective
- KR

작은 팀에서는 이게 정교함보다 `중복 관리`가 되기 쉽다.

### 2. 회의록/Chapter/Linear와 삼중 구조가 된다

현재 이미 다음이 있다.

- 노션 Chapter 문서
- 노션 회의록
- Linear Project / Issue

여기에 OKRs 보드가 별도의 실운영 시스템으로 들어오면,
실제로는 같은 내용을 다른 이름으로 세 군데 이상 적게 될 위험이 있다.

### 3. 장기 비전과 단기 실행이 섞일 수 있다

OKRs 보드는 본래 장기 방향과 측정 지표를 붙이기 좋지만,
지금 팀은 `현금`, `superbuilder`, `첫 납품형 SaaS`, `게임 투자 시간`처럼
운영 현실이 매우 중요하다.

그래서 OKRs를 예쁘게 쓰는 것보다
`지금 챕터에서 무엇이 달라져야 하는가`가 더 중요하다.

## 4. 결론

지금 팀 기준으로 `OKRs 보드는 메인 운영 체계가 아니라 보조 보드`로 두는 게 맞다.

즉 역할은 아래처럼 정리하는 편이 좋다.

### Chapter

- 이번 2개월의 핵심 상태 변화를 정한다

### Weekly Cycle / Daily Focus

- 이번 주와 오늘의 실행을 정렬한다

### Linear

- 실제 실행 단위를 관리한다

### OKRs 보드

- 장기 방향과 핵심 지표를 느슨하게 관리한다
- Chapter가 어디를 향하고 있는지 상위 문맥을 제공한다

## 5. 권장 역할 정의

### OKRs 보드에서 관리할 것

- 회사 레벨 장기 Objective 2~4개
- 각 Objective의 대표 KR 1~3개
- 분기 또는 반기 수준의 방향성 지표

예:

- Objective: `Superbuilder를 반복 출하 가능한 엔진으로 만든다`
- KR: `1시간 내 데모 생성 가능`
- KR: `표준 범위 내 납품 비율`

### OKRs 보드에서 관리하지 않을 것

- 이번 주 작업
- 상세 프로젝트 목록
- 사람별 할 일
- Daily Focus 내용
- Linear Issue 수준의 실행 단위

## 6. 지금 팀에 맞는 사용법

### 권장 주기

- Chapter 시작 시 업데이트
- Chapter 종료 시 점검

즉, 매주 만지는 보드가 아니라
`챕터 시작/종료에 보는 상위 방향 보드`에 가깝다.

### 권장 개수

- Objective는 최대 3개
- KR은 Objective당 최대 3개

이 이상이면 지금 팀에는 과하다.

## 7. 현재 문서 체계와의 연결

### 회사 목적

OKRs 보드의 회사 목적 문구는 계속 유지해도 좋다.

다만 이 문구는 다음 문서들과 연결돼야 한다.

- [../management/02-about-us.md](../management/02-about-us.md)
- [../strategy/04-north-star.md](../strategy/04-north-star.md)

### Chapter와의 연결

Chapter 문서의 Must-win goals는
OKRs 보드의 Objective/KR를 향해 가는 `이번 챕터의 압축판`으로 보면 된다.

즉:

- OKRs = 장기/상위
- Chapter = 2개월 압축 실행 방향

## 8. 지금 바로 바꾸면 좋은 것

1. OKRs 보드에 Objective를 3개 이하로 줄인다
2. KR은 `측정 가능한 상태 변화`만 남긴다
3. 주간/일간 실행 항목은 이 보드에 넣지 않는다
4. Chapter와 겹치는 문장은 과감히 없앤다

## 9. 연결 문서

- [../roadmap/02-chapter-operating-model.md](../roadmap/02-chapter-operating-model.md)
- [08-meeting-notes-operating-model.md](./08-meeting-notes-operating-model.md)
- [../templates/05-chapter-template.md](../templates/05-chapter-template.md)

## 한 줄 정리

지금 회사에서 OKRs 보드는 `실행 시스템`이 아니라,
Chapter가 어느 방향을 향하는지 보여주는 `상위 방향 보드`로 두는 게 맞다.
