# C2 Cycle 4

> **Chapter 2** — superbuilder 출하 엔진화와 첫 유료 전환
> **주간**: 2026-03-30 ~ 2026-04-05
> **상태**: On track
> **초점**: Flotter 엔진 설계 착수 + 기존 프로젝트 병행 운영

---

## 지난주 리뷰 (C2 Cycle 3)

### 개발 출하

| 이슈 | 내용 | 담당 | 상태 |
|------|------|------|------|
| company-agent-desk | ClickUp→노션 이관, 입사자 안내서 전면 개편, n8n DB 전환 | 대환 | ✅ |
| company-agent-desk | 법인 타겟 전환 — 프라이싱 리뉴얼 + Google Ads B2B 전환안 | 대환 | ✅ |

### 마케팅 스냅샷

| 지표 | 값 | 비고 |
|------|-----|------|
| GA4 세션 | — | |
| 문의 전환 | — | |

### 리드/기회 현황

| 건 | 상태 | 예상 금액 | 기한 | 판단 |
|----|------|-----------|------|------|
| KUP Express | 확정 | 2,200만원 | 진행중 | 개발+유지보수 |
| ABADC | 대형 기회 | ~4,000만원 | 5-6월 | 기밀 유지 |

### Carryover

- 리드 1Day POC 플레이북 정비
- 예약관리 SaaS 자산화 계속

---

## 이번 주 Must-win Goals

### 박지수

| # | Goal | 완료 기준 | Linear |
|---|------|-----------|--------|
| J1 | 회사 운영 시스템 — brand-desk | 커맨드+@로 생성되는 수준 도달 → superbuilder 편입 판단 | — |
| J2 | 회사 운영 시스템 — superbuilder-ui | — | — |
| J3 | (외주) 퀀팃 머니터링 투자상품 관리자 | Figma 기반 관리자 화면 구현 | — |
| J4 | (외주) 퀀팃 머니터링 투자상품 실제 사용 방식 구현 | [Figma 스펙](https://www.figma.com/design/MLdIY8zpvIKIRtMRskZN69/-Plantit-Biz--%EB%A8%B8%EB%8B%88%ED%84%B0%EB%A7%81-%ED%88%AC%EC%9E%90-%EC%84%9C%EB%B9%84%EC%8A%A4?node-id=1-3745&t=uzwkQe51cohaigBE-1) 반영 | — |

### 대환

| # | Goal | 완료 기준 | Linear |
|---|------|-----------|--------|
| D1 | (외주) 퀀팃 — 매일 개발 참여 | 일일 커밋/리뷰 유지 | — |
| D2 | superbuilder 안정화 | — | — |
| D3 | Flotter 기획/디자인 | 기획 repo 디자인 스펙 업데이트, 핵심 UX 플로우 정의 | — |
| D4 | Flotter 엔진 개발 | WebGL+WASM 아키텍처 설계, 100만 노드 벤치마크 목표 정의 | — |
| D5 | Flotter 하네스 개발 | 엔진 개발 워크플로우 자동화 하네스 구축 | — |

---

## 핵심 방향: Flotter 엔진

### 비전
- **게임 업계의 Figma** — 세계 최정상급 게임 작가들이 50만+ 노드를 느려짐 없이 관리할 수 있는 도구
- 100만 개 노드도 거뜬히 버티는 엔진을 **WebGL + WASM**으로 구축
- **LLM 적극 활용** — AI-native 설계로 경쟁력 확보

### 이번 주 엔진 마일스톤
- [ ] 렌더링 아키텍처 설계 (WebGL + WASM 역할 분담)
- [ ] 노드 50만~100만 개 성능 목표치 정의 (FPS, 메모리, 응답시간)
- [ ] 기존 graph-engine r1 진행 상황 점검 및 방향 재정렬
- [ ] LLM 연동 포인트 설계 (노드 자동 생성, 구조 추천 등)
- [ ] 하네스: 엔진 개발용 Claude 스킬/워크플로우 세팅

---

## 결정 필요

| 이슈 | 옵션 | 기한 | 담당 |
|------|------|------|------|
| brand-desk superbuilder 편입 기준 | 커맨드+@ 생성 품질 기준 정의 필요 | 이번 주 | 박지수 |
| WASM 런타임 선택 | Rust(wasm-bindgen) vs C++(Emscripten) vs AssemblyScript | 이번 주 | 대환 |

---

## 다음 주 Preview

- Flotter 엔진 프로토타입 (노드 렌더링 POC)
- 퀀팃 외주 중간 체크
- superbuilder 안정화 결과 확인

---

## 금요일 마감 체크

| Goal | 결과 | 완료 |
|------|------|------|
| J1 brand-desk | | |
| J2 superbuilder-ui | | |
| J3-4 퀀팃 외주 | | |
| D1 퀀팃 매일개발 | | |
| D2 superbuilder 안정화 | | |
| D3 Flotter 기획/디자인 | | |
| D4 Flotter 엔진 | | |
| D5 Flotter 하네스 | | |
| Carryover 해소 | | |

---

*이 문서는 매주 Cycle 회의 기록용이다. Linear Cycle과 동일한 이름을 사용한다.*
