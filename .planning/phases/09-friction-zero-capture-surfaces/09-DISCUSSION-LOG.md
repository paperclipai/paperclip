# Phase 9: Friction-Zero Capture Surfaces - Discussion Log

> 감사 추적용 문서다. 실제 결정은 `09-CONTEXT.md`에 정리되어 있다.

**일자:** 2026-04-25  
**Phase:** 9 - Friction-Zero Capture Surfaces  
**Mode:** `/gsd-discuss-phase 9 --auto --chain`

## Capture Surface

| 선택지 | 설명 | 선택 |
|--------|------|------|
| Global floating widget | 현재 페이지를 유지한 채 One-Liner를 그 자리에서 연다 | yes |
| Page-only improvements | `/one-liner` page만 개선한다 | |
| New dashboard surface | Phase 10 전에 별도 cockpit을 만든다 | |

**결정:** Global floating widget.

## Shortcut and Voice

| 선택지 | 설명 | 선택 |
|--------|------|------|
| Reuse `c` shortcut | 기존 global shortcut이 floating capture를 연다 | yes |
| Add new chord | 새 keyboard sequence를 추가한다 | |
| No shortcut change | 기존 navigation-only behavior를 유지한다 | |

**결정:** `c`를 재사용하고, help에 문서화하며, browser voice draft input을 fallback과 함께 추가한다.

## Inbound Messenger Flow

| 선택지 | 설명 | 선택 |
|--------|------|------|
| Authenticated draft API | Slack/Teams-style text를 reviewed draft로 만든다 | yes |
| Full external app install | OAuth/secrets/replay protection을 지금 모두 만든다 | |
| UI only | API integration을 생략한다 | |

**결정:** authenticated company-scoped draft endpoint.

## Reward Feedback

| 선택지 | 설명 | 선택 |
|--------|------|------|
| Immediate proposed evidence | commit 후 task, deliverable, gold, XP, rationale을 보여준다 | yes |
| Silent redirect | issue detail로 즉시 redirect한다 | |
| Actual ledger issuance now | task creation에서 immutable reward settlement를 쓴다 | |

**결정:** immediate proposed reward evidence를 보여준다. 실제 ledger settlement는 governed 상태로 남긴다.
