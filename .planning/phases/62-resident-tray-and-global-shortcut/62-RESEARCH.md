# Phase 62: Resident Tray and Global Shortcut - Research

**Researched:** 2026-04-30
**Status:** Complete

## Research Question

What does planning need to know to implement the smallest safe resident tray/menubar and OS-level global shortcut readiness gate for RealTycoon2 without pulling mobile push, final distribution gate, or native dependency churn into Phase 62?

## Summary

Phase 62 should add a deterministic resident surface evidence gate rather than a full native desktop scaffold. Tauri v2 remains the selected implementation target for future tray and global shortcut APIs, but the current repo still has no `apps/desktop` package or Tauri dependency. Phase 60 and Phase 61 proved the preferred distribution-readiness pattern: credential-free Node evidence gate, focused tests, package scripts, and operator docs.

Official Tauri docs show that the system tray can be created and customized from JavaScript or Rust, with menu actions and tray events. The global shortcut plugin is a dedicated desktop plugin that supports registration APIs and requires explicit project setup. Notification permission APIs and deep-link testing caveats matter for future native UX, but Phase 62 does not need to depend on notification delivery or deep links to close RES-01 through RES-03.

The existing RealTycoon2 capture loop already has the right backend boundary. `source: "native"` is an existing capture source, quick-capture queue items already support `native`, and the inbound draft route creates persistent draft revisions with source evidence, duplicate detection, permission blocking, and review-only promotion. The Phase 62 plan should validate that tray and shortcut captures use these existing paths and never call promote/apply directly.

## Findings

### Tauri tray and shortcut surfaces

- Tauri v2 system tray support is available through tray APIs that can create a tray icon, attach a menu, handle menu item actions, and listen to tray icon mouse events.
- Tauri tray support requires enabling the relevant Tauri feature in the native package. Since this repo has no native package yet, Phase 62 should not add the dependency unless a plan proves it is narrowly required.
- The global shortcut capability is provided by `@tauri-apps/plugin-global-shortcut` / `tauri-plugin-global-shortcut` and has its own setup path.
- The future native implementation should treat shortcut registration as an explicit lifecycle, not a boolean. Operators need accelerator, platform, registration result, conflict, permission, focus, privacy, unregister, and change evidence.
- Tauri notification APIs require checking and requesting permission before notification delivery. Phase 62 may record permission/privacy status, but push notification delivery belongs to Phase 63.
- Tauri desktop deep links have installed-app testing caveats. Phase 62 should not depend on deep links for its first readiness gate unless the implementation can test the behavior deterministically.

### RealTycoon2 resident status contract

- RES-01 requires tray status to show quick capture, sync/queue state, auth/company state, build identity, and release channel.
- Phase 61 already defines installed channel/build identity and update states: `idle`, `checking`, `available`, `downloading`, `downloaded`, `installing`, `relaunch_required`, `failed`, and `rolled_back`.
- The resident status gate should reuse the Phase 61 vocabulary so Phase 64 can combine signing, updater, resident, push, and regression status without translation.
- The manifest should cover `macos` and `windows` as required v3.0 desktop platforms. Linux can remain optional or unsupported evidence for this milestone.

### Capture handoff and approval boundary

- `ui/src/lib/rt2-quick-capture-queue.ts` supports `mobile` and `native` queue items with bounded local storage and statuses `queued`, `sending`, `failed`, and `sent`.
- `ui/src/pages/rt2/QuickCapturePage.tsx` already blocks sending when auth, company, project, or online state is missing, then calls `rt2TasksApi.createInboundDraft`.
- `server/src/routes/rt2-tasks.ts` exposes `POST /companies/:companyId/rt2/one-liner/inbound-draft` for board users and creates activity log entries.
- `server/src/services/rt2-work-board.ts` persists `native` capture drafts, creates revision 1, stores source evidence, blocks invalid/missing signed sources, detects duplicates, and leaves promotion to explicit review actions.
- The resident gate should therefore validate handoff target and approval safety, not create a second native capture store.

### Evidence gate implementation pattern

- `scripts/rt2-native-signing-gate.mjs` and `scripts/rt2-release-channel-gate.mjs` are the implementation analogs. They parse a manifest, collect blockers and passed checks, reject raw secrets, write `summary.json`/`report.md`, and return non-zero when blockers exist.
- `scripts/rt2-native-signing-gate.test.mjs` and `scripts/rt2-release-channel-gate.test.mjs` show the preferred test shape: temporary root fixtures, pure evaluator assertions, run function assertions, report assertions, and CLI assertions.
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` is the canonical operator contract for native distribution capabilities.
- `doc/RELEASE-HOST-VERIFICATION.md` is the correct runbook surface for gate commands, output paths, and interpreting blockers.
- `package.json` should expose one operator command and one focused test command, matching existing `rt2:*` and `test:*` naming.

### Privacy and security pitfalls

- A global shortcut can feel like a system-wide capture affordance, but Phase 62 must not scrape active application context. The shortcut should open/focus a RealTycoon2 capture surface and wait for explicit typed input.
- Tray/shortcut manifests must fail if privacy behavior says the app reads clipboard, selected text, screen contents, active window title, or foreground app data without explicit operator action.
- Raw token, key, password, signing material, or provider credential fields should be rejected unless they are secret references. Even though Phase 62 is not a signing phase, resident native manifests often tempt teams to include app tokens.
- Conflict and permission failures should be operator-readable blockers, not raw plugin error strings hidden in logs.

## Validation Architecture

### Automated validation

Add `scripts/rt2-resident-surface-gate.test.mjs` to cover:

- A complete manifest with tray quick capture, queue/sync state, auth/company state, installed channel/build identity, update state, macOS and Windows tray evidence, shortcut registration/change/unregister evidence, and safe capture handoff produces `status: passed`.
- Missing tray quick capture, queue state, auth state, company state, build identity, release channel, or update lifecycle state produces blockers.
- Invalid update states produce blockers and reuse the Phase 61 vocabulary.
- Missing shortcut accelerator, registration state, conflict state, permission state, focus behavior, privacy behavior, unregister evidence, or change evidence produces blockers.
- Registration conflict or permission-required states are blockers unless accompanied by an explicit operator-visible reason and next action.
- Privacy behavior that auto-reads clipboard, selected text, screen/window title, active app content, or foreground context is a blocker.
- Capture handoff that uses anything other than source `native` or bypasses inbound draft review is a blocker.
- Raw secrets in manifest fields are rejected unless represented as secret references.
- CLI execution writes `summary.json` and `report.md` and exits `0` for pass, non-zero for blocker.

### Commands

- Focused: `pnpm run test:resident-surface-gate`
- Operator gate: `pnpm run rt2:resident-surface-gate -- --manifest <path>`
- Type safety: `pnpm typecheck`
- Do not run `pnpm test:e2e` by default.

### Manual validation

- Inspect generated `report.md` for platform, tray, shortcut, capture handoff, and privacy grouping.
- Inspect docs to ensure Phase 62 does not claim mobile push or full desktop scaffold completion.
- Confirm `pnpm-lock.yaml` remains unchanged.

## External Sources Checked

- Tauri system tray: `https://v2.tauri.app/learn/system-tray/`
- Tauri global shortcut plugin: `https://v2.tauri.app/plugin/global-shortcut/`
- Tauri global shortcut JavaScript API: `https://v2.tauri.app/reference/javascript/global-shortcut/`
- Tauri notification plugin: `https://v2.tauri.app/plugin/notification/`
- Tauri deep linking plugin: `https://v2.tauri.app/plugin/deep-linking/`

## RESEARCH COMPLETE
