# Phase 8: Dev Plan Alignment Baseline - Discussion Log

> 감사 추적용 문서다. planning/research/execution agent input으로 쓰지 않는다. 결정은 `08-CONTEXT.md`에 정리되어 있다.

**일자:** 2026-04-25  
**Phase:** 8 - Dev Plan Alignment Baseline  
**Mode:** `/gsd-discuss-phase 8 --auto --chain`

---

## Baseline Shape

| 선택지 | 설명 | 선택 |
|--------|------|------|
| Planning-only checklist | gap map을 markdown에만 둔다 | |
| App-visible static checklist | 현재 audit를 기준으로 경량 app page를 추가한다 | yes |
| Persisted editable checklist | DB/API/editing workflow를 지금 추가한다 | |

**결정:** `--auto`에 따라 recommended option을 선택했다.  
**메모:** Phase 8을 과하게 키우지 않고 `ENT-04`를 충족한다.

---

## Product Framing

| 선택지 | 설명 | 선택 |
|--------|------|------|
| RealTycoon2-first | upstream project는 reference로만 보여준다 | yes |
| Paperclip-compatible wording | 익숙함을 위해 old label을 보존한다 | |

**결정:** `AGENTS.md` 기준으로 recommended option을 선택했다.  
**메모:** Paperclip clone identity를 강화하지 않는다.

---

## Scope

| 선택지 | 설명 | 선택 |
|--------|------|------|
| Visibility baseline only | shipped/partial/missing capability와 phase target을 매핑한다 | yes |
| Implement all missing features | Phase 9-13 scope를 지금 시작한다 | |

**결정:** roadmap boundary 기준 recommended option을 선택했다.  
**메모:** missing feature는 이후 v2.1 Phase에 남긴다.

---

## agent 재량

- 기존 RT2 route/page/sidebar pattern을 사용한다.
- live editable scoring이 필요해질 때까지 static implementation을 유지한다.

## Deferred Ideas

- persisted adoption scoring.
- code scanning 기반 automated drift detection.
