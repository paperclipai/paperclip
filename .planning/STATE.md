---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Native Distribution Readiness
status: planning
last_updated: "2026-04-30T19:38:00+09:00"
last_activity: 2026-04-30 -- Phase 59 Native Distribution Foundation completed
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 1
  completed_plans: 1
  percent: 17
---

# RealTycoon2 Planning State

## Current Position

Phase: 60 Signing and Notarization Pipeline
Plan: -
Status: Ready for discussion/planning
Last activity: 2026-04-30 -- Phase 59 Native Distribution Foundation completed

## 현재 위치

v3.0 Native Distribution Readiness milestone이 진행 중이다. Phase 59는 native distribution foundation을 완료했고, v2.9 Native Capture and Draft Reliability는 shipped baseline으로 취급하며 DRAFT/NATIVE/MSG/REVIEW 기능은 regression gate 실패를 고치는 경우에만 다시 연다.

이번 milestone은 `DIST-01` native distribution foundation을 완료했고, 다음으로 macOS/Windows signing/notarization/trust pipeline, release channels/updater, OS-level global shortcut, resident tray app, mobile push notification을 production distribution readiness로 끌어올린다.

## 최근 완료한 마일스톤

v2.9 Native Capture and Draft Reliability는 2026-04-30에 완료되었다.

- **Phase 54**: Persistent Capture Draft Revision - 저장 가능한 draft revision, latest revision promotion, Korean board review edit/state actions
- **Phase 55**: Native and Mobile Quick Capture Entry - PWA/mobile quick capture route, local queue/retry, mobile source handoff
- **Phase 56**: Messaging Capture Source Installation - Slack/Teams/webhook source setup, signed inbound route, malformed/source failure evidence
- **Phase 57**: Capture Review Operations and Reliability - review inbox source/status filters, promoted draft evidence, source-level reliability report
- **Phase 58**: v2.9 Verification and Distribution Readiness Closure - validation/verification artifact sync, traceability closure, future distribution boundary

## 프로젝트 기준

참조: `.planning/PROJECT.md` (2026-04-30 업데이트)

**핵심 가치:** 회사 범위 work signal은 disconnected tool이나 Paperclip-shaped manual workflow를 강요하지 않고 logging -> execution -> knowledge accumulation -> approval -> economic feedback으로 이어져야 한다.

**현재 초점:** signed native distribution pipeline, release channels, updater, resident tray/global shortcut, mobile push가 v2.9 capture/review loop를 깨지 않고 운영 가능한 배포 표면이 되게 한다.

## v3.0 계획

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 59 | Native Distribution Foundation | DIST-01 | Complete |
| 60 | Signing and Notarization Pipeline | DIST-02, DIST-03 | Planned |
| 61 | Release Channels and Signed Updater | DIST-04, DIST-05 | Planned |
| 62 | Resident Tray and Global Shortcut | RES-01, RES-02, RES-03 | Planned |
| 63 | Mobile Push Notification Loop | PUSH-01, PUSH-02, PUSH-03 | Planned |
| 64 | v3.0 Distribution Gate and Capture Regression Closure | DIST-06 | Planned |

## 누적 맥락

- RealTycoon2가 제품 정체성이다. Paperclip/Multica/wikiLLM/Graphify는 reference 또는 infrastructure ingredient다.
- 사용자는 앱을 구동했을 때 Paper Company나 영문 기본값이 보이는 것을 특히 우려한다.
- v2.8은 Korean-first daily work board와 One-Liner review flow를 제품 전면으로 만들었다.
- v2.9는 persistent draft revision, PWA/mobile quick capture, Slack/Teams/webhook signed inbound, review operations reliability를 닫았다.
- 현재 repo는 Electron/Tauri 같은 native shell dependency가 없는 web/PWA-first 상태다. Phase 59는 Tauri v2를 native shell baseline으로 선택하고 `apps/desktop` future package layout, signing/updater/channel inventory, v2.9 regression gate boundary를 확정했다.
- macOS 배포는 Developer ID signing, hardened runtime, notarization, ticket stapling/Gatekeeper verification이 release gate에 들어가야 한다.
- Windows 배포는 MSIX/installer signing, timestamping, Store re-signing 또는 external trusted signing path를 release gate에 반영해야 한다.
- Push는 APNs/Web Push/device token을 company/user/device scope로 관리하고 최소 payload/deep-link 방식으로 board review target에 연결해야 한다.
- Windows sandbox `spawn EPERM`은 계속 환경 제약이다. Vitest/build tooling은 승인된 unsandboxed command execution이 필요할 수 있다.

## Deferred Items

| Category | Item | Status |
|----------|------|--------|
| federation | Cross-company federation full apply | v3.0 범위 밖, distribution readiness 이후 재평가 |
| autonomy | Autonomous Jarvis apply without approval | v3.0 범위 밖, approval-first 원칙 유지 |
| marketplace | Public/open company capture marketplace | v3.0 범위 밖 |
| store_ops | Public store listing launch/marketing/reviewer operations | signing/updater/notarization readiness 이후 후속 scope |
| postgres | Windows default embedded Postgres broader suite execution | accepted debt; closure command is `pnpm rt2:embedded-postgres-host-ready` |
| test | Full `pnpm test` on this host | v2.8/v2.9에서 full-suite timeout residual risk가 있었고 focused gates를 우선 사용 |

## 다음 단계

Phase 60 Signing and Notarization Pipeline을 논의하고 계획한다. Phase 59의 `doc/NATIVE-DISTRIBUTION-FOUNDATION.md`와 `59-CONTEXT.md`를 기준으로 macOS Developer ID/hardened runtime/notarization/stapling/Gatekeeper evidence와 Windows MSIX/installer signing/timestamping/trust path evidence를 구현해야 한다.

다음 세션 지시어: `$gsd-discuss-phase 60 --auto --chain`으로 signing/notarization pipeline 범위를 확정하고 자동 계획/실행한다. 바로 계획하려면 `$gsd-plan-phase 60 --auto`를 실행한다.

---
*상태 업데이트: 2026-04-30, Phase 59 completed*
