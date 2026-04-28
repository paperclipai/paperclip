# Phase 13: Enterprise Rollout and RT2 Terminology - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md.

**Date:** 2026-04-25
**Phase:** 13-Enterprise Rollout and RT2 Terminology
**Mode:** auto assumptions

## Auto-Resolved Areas

| Area | Decision | Evidence |
|------|----------|----------|
| Rollout surface | RT2 전용 `enterprise-rollout` route를 추가한다 | `CompanySettings`는 legacy settings가 많고, RT2 pages는 `ui/src/pages/rt2` 아래에 있다 |
| Template preview | count preview 대신 action 객체 목록을 반환한다 | `ENT-02`가 생성/스킵/오류 객체 preview를 요구한다 |
| Terminology | product-facing RT2 nav와 Plan Map을 갱신하되 compatibility strings는 남긴다 | `AGENTS.md`는 product UI의 Paperclip label 제거를 요구하지만 package/import compatibility는 허용한다 |

## Corrections Made

No corrections — `--auto` requested.

## Deferred Ideas

- 실제 SSO handshake와 SCIM sync.
- native mobile rollout.

