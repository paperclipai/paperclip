# C2 Cycle 5

> **Chapter 2** — superbuilder 출하 엔진화와 첫 유료 전환
> **주간**: 2026-04-06 ~ 2026-04-12
> **상태**: On track
> **초점**: Flotter 엔진 QA 안정화 + Platform App Foundation + Reservia SaaS 기초

---

## 지난주 리뷰 (C2 Cycle 4: 3/30~4/05)

### 개발 출하

| 프로젝트 | 내용 | 담당 | 상태 |
|----------|------|------|------|
| Flotter-Engine | Graph Engine M4(인터랙션), M8(통합+스케일 100K), M9(WASM 준비+1M) 완료 | 대환 | ✅ |
| Flotter-Engine | WebGL 텍스트 에디터 아키텍처 설계 (ADR 6개) | 대환 | ✅ |
| Flotter-Engine | TE.1 텍스트 에디터 — 인라인 서식 + 블록 구조 + 50페이지 데모 (PR #6) | 대환 | 🔄 QA 중 |
| Flotter-Engine | TE.1 QA 버그 6건 수정 — 첫글자 순서, 포커스/IME, Bold/Italic, 한글→영문, 글자간격, Enter키 | 대환 | ✅ |
| Flotter-Engine | 노드 컨텍스트 메뉴 ActionArea 설계+구현 | 대환 | 🔄 리뷰 중 |
| Flotter-Platform | 누락 디자인 화면 4개 추가 (감정디버거, Player, Lore, Flag Table) | 대환 | ✅ |
| Flotter-Platform | 신규 디자인 8개 Critic 검증 (HR-01~12) | 대환 | ✅ |
| Flotter-Platform | 이벤트/트리거 시스템 디자인 | 대환 | ✅ |
| Flotter-Platform | 전체 화면별 상세 UX 정의서 작성 | 대환 | ✅ |
| Flotter-Platform | 프로토타입 리뷰 도구 구축 (Linear 코멘트 연동) | 대환 | ✅ |
| Flotter-Marketing | 랜딩 콘텐츠 리서치 + 방향 수립 (경쟁사 15곳 분석) → CEO 승인 | 대환 | ✅ |
| Flotter-Marketing | 랜딩페이지 Draft 1 구현 (철학+스케일) | 대환 | ✅ |
| Company-OS | QA Agent Group — Iris(QA Lead) 인프라 구축 | 대환 | ✅ |
| Company-OS | cos-add-agent 자동화 스크립트 | 대환 | ✅ |
| Company-OS | QA 에이전트 파일 작성 (Iris, Blitz, qa-team) | 대환 | ✅ |
| Company-OS | flotter-qa 전용 CLAUDE.md 작성 | 대환 | ✅ |
| Company-OS | QA E2E 검증 파이프라인 완료 | 대환 | ✅ |
| Company-OS | 모니터 조직도 + gateway 외부 접근 허용 | 대환 | ✅ |
| SuperBuilder | Reservia 프로젝트 초기 설정 (Vite+, TanStack, Shadcn) | 지수 | ✅ |
| SuperBuilder | Reservia 랜딩페이지 구현 | 지수 | ✅ |
| SuperBuilder | Foundation & Storage — Repository 추상화, 타임존, ID 생성기 | 지수 | ✅ |
| SuperBuilder | Flotter 랜딩페이지 제작 (Firecrawl 클론) | 지수 | ✅ |
| SuperBuilder | Reservia 예약 SaaS 랜딩페이지 제작 | 지수 | ✅ |
| SuperBuilder | landing-page-workflow 스킬 개선 + 리팩터 | 지수 | ✅ |

### C2 Cycle 4 금요일 마감 체크

| Goal | 결과 | 완료 |
|------|------|------|
| J1 brand-desk | → Reservia 전환. 초기설정+랜딩+Foundation 완료 | ✅ |
| J2 superbuilder-ui | Flotter/Reservia 랜딩 3개 + 스킬 리팩터 | ✅ |
| J3-4 퀀팃 외주 | 이번 주 확인 필요 | ⏳ |
| D1 퀀팃 매일개발 | 확인 필요 | ⏳ |
| D2 superbuilder 안정화 | landing-page-workflow 개선, 갤러리 필터링 | ✅ |
| D3 Flotter 기획/디자인 | 디자인 화면 12개+, UX 정의서, 리뷰 도구 | ✅ |
| D4 Flotter 엔진 | M4/M8/M9 완료, 텍스트 에디터 TE.1 | ✅ |
| D5 Flotter 하네스 | QA Agent Group (Iris) 구축 완료 | ✅ |
| Carryover 해소 | Feature Gallery → 갤러리 필터링으로 부분 해소 | 부분 |

### 마케팅 스냅샷

| 지표 | 값 | 비고 |
|------|-----|------|
| GA4 세션 | — | 확인 필요 |
| 문의 전환 | — | 확인 필요 |
| Flotter 랜딩 | Draft 1 완료 | 경쟁사 15곳 분석 기반 |

### 리드/기회 현황

| 건 | 고객 | 상태 | 예상 금액 | 비고 |
|----|------|------|-----------|------|
| KUP Express | 김도형 | 확정 | 2,200만원 | 개발+유지보수 진행중 |
| ABADC | — | 대형 기회 | ~4,000만원 | 5-6월 예상, 기밀 유지 |
| 에이전트 시스템 | 이원재 (코메디닷컴) | 제안완료 | 7,000~8,000만원 | 견적 제출 후 응답 대기 |
| 뷰티 컨설팅 사이트 | 주나래 (VicsLab) | 제안완료 | 420만원 | 이메일 제안 후 응답 대기 |
| 번역 서비스 | 민아리 | 장기 미응답 | — | 3주+ 미응답 |
| 웹사이트 제작 | 이은혜 | 장기 미응답 | — | 3주+ 미응답 |
| 웹사이트 제작 | 엄희승 | 장기 미응답 | — | 3주+ 미응답 |

**파이프라인 가중치 적용 금액:**

| 단계 | 건수 | 가중치 | 가중 금액 |
|------|------|--------|-----------|
| 확정 (100%) | 1건 | KUP 2,200만 | 2,200만원 |
| 대형 기회 (50%) | 1건 | ABADC ~4,000만 | ~2,000만원 |
| 제안완료 (50%) | 2건 | 7,420만~8,420만 | ~3,710만~4,210만원 |
| 장기 미응답 (5%) | 3건 | 미정 | ~0원 |
| **합계** | | | **~7,910만~8,410만원** |

**연간 목표 대비:**
- 목표 2.6억 대비: 확정 2,200만원 = 8.5%
- 가중 파이프라인 포함: ~1억원 = 38.5%
- 방어선 2.2억까지 잔여: ~1.98억원

### 캐피탈 보드 한줄

자금보드 기준일 3/16 — 3주 경과, 업데이트 필요. 3월 순유출 1,486만원 상태. 투자자산 1.322억 안전판 유지.

### Carryover

- 장기 미응답 제안 3건 (민아리·이은혜·엄희승) — 마감 판단 미완료
- 이원재·주나래 후속 확인
- 예약관리 SaaS 타깃 선정 (유선 논의만 진행)
- 퀀팃 외주 이번 주 참여 확인 필요

---

## Linear 이슈 현황 (4/06 기준)

### 팀별 7일간 업데이트

| 팀 | 이슈 수 | 주요 상태 |
|----|---------|-----------|
| Flotter-Platform | 26건 | 디자인, UX 정의서, App Foundation |
| Flotter-Engine | 11건 | 텍스트 에디터, 엔진 M4~M9 |
| Company-OS | 7건 | QA Agent Group 구축 |
| SuperBuilder | 4건 | Reservia 프로젝트 시작 |
| Flotter-Marketing | 2건 | 랜딩페이지 리서치+구현 |

### 현재 In Progress / In Review

| 이슈 | 내용 | 팀 | 담당 |
|------|------|----|------|
| FLT-251 | 인증 시스템 (Better Auth + 소셜 로그인) | Platform | 대환 → Felix |
| FLT-253 | 디자인 시스템 토큰 + 테마 설정 | Platform | 대환 → Felix |
| FLE-64 | TE.1 텍스트 에디터 (QA-Failed → 버그 수정 후 재리뷰) | Engine | 대환 → Cyrus |
| FLE-65 | 노드 컨텍스트 메뉴 (In Review) | Engine | 대환 |
| FLE-63 | WebGL 텍스트 에디터 아키텍처 (In Review) | Engine | 대환 |
| FLE-44 | VFX.3 시각 검증 + Playground 통합 | Engine | 대환 → Cyrus |
| FLE-9 | M7 React 바인딩 + Story Canvas 어댑터 | Engine | 대환 → Cyrus |
| COM-4 | 로컬 Postgres Docker 환경 (QA용) | COS | 대환 |
| COM-3 | cos-add-agent로 Iris 인프라 생성 | COS | 대환 |

### Git 커밋 (company-os, 3/30~4/06)

30 commits — gateway 외부접근, QA 에이전트 인프라, 모니터 조직도, 아키텍처 문서

---

## 이번 주 Must-win Goals

### 박지수

| # | Goal | 완료 기준 | Linear |
|---|------|-----------|--------|
| J1 | (외주) 퀀팃 — 머니터링 투자상품 관리자+사용방식 API 연결 | 상품목록+배너 API 연동 완료 | — |
| J2 | Reservia — 예약 핵심 기능 구현 | 예약 생성/조회 플로우 동작 | SBD-191+ |
| J3 | SuperBuilder — 랜딩페이지 스킬 고도화 | 클론 워크플로우 완성도 향상 | — |

### 대환

| # | Goal | 완료 기준 | Linear |
|---|------|-----------|--------|
| D1 | Flotter Engine — TE.1 QA 통과 + In Review 이슈 정리 | FLE-64 Done, FLE-65 Done | FLE-64, FLE-65 |
| D2 | Flotter Platform — App Foundation (인증+테마) 완료 | 소셜 로그인 동작, 다크/라이트 토글 | FLT-251, FLT-253 |
| D3 | Flotter Engine — M7 React 바인딩 진행 | Phase 7.1~7.3 완료 | FLE-9 |
| D4 | (외주) 퀀팃 — 매일 개발 참여 | 일일 커밋/리뷰 | — |
| D5 | 영업 — 장기 미응답 3건 마감 판단 + 이원재·주나래 후속 | 재접촉 or 종결 결정 | — |

---

## 핵심 방향: Flotter 엔진 → 앱

### 이번 주 마일스톤
- [ ] TE.1 텍스트 에디터 QA 통과 (QA-Failed 6건 수정 완료 → 재검증)
- [ ] 노드 컨텍스트 메뉴 리뷰 완료
- [ ] M7 React 바인딩 Phase 7.1~7.3
- [ ] App Foundation (인증+테마) 완료 → 첫 배포 가능 상태
- [ ] VFX.3 시각 검증 마무리

---

## 결정 필요

| 이슈 | 옵션 | 기한 | 담당 |
|------|------|------|------|
| 장기 미응답 3건 처분 | 종결 vs 마지막 재접촉 | 이번 주 | 대환 |
| 자금보드 업데이트 | 3/16 이후 3주 경과 — 4월 법인계좌+카드 확인 필요 | 이번 주 | 대환 |
| 예약관리 SaaS 타깃 | Reservia 기초 구축 중 — ICP 확정 필요 | 이번 주 | 대환 |
| Flotter 첫 배포 시점 | App Foundation 완료 후 스테이징 배포 판단 | 이번 주 | 대환 |

---

## 다음 주 Preview

- Flotter 앱 스테이징 첫 배포 (인증+테마+기본 라우팅)
- M7 React 바인딩 완료 → Story Canvas 어댑터 시작
- Reservia 예약 핵심 기능 (생성/조회/관리)
- 퀀팃 외주 중간 체크

---

## 금요일 마감 체크

| Goal | 결과 | 완료 |
|------|------|------|
| J1 퀀팃 외주 API 연결 | | |
| J2 Reservia 예약 기능 | | |
| J3 랜딩 스킬 고도화 | | |
| D1 TE.1 QA 통과 | | |
| D2 App Foundation | | |
| D3 M7 React 바인딩 | | |
| D4 퀀팃 매일개발 | | |
| D5 영업 미응답 처분 | | |
| Carryover 해소 | | |

---

*이 문서는 매주 Cycle 회의 기록용이다. Linear Cycle과 동일한 이름을 사용한다.*
