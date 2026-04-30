# Phase 59: Native Distribution Foundation - Research

**Researched:** 2026-04-30
**Status:** Complete

## Research Question

What does planning need to know to implement the smallest safe Native Distribution Foundation for RealTycoon2 without pulling Phase 60-64 implementation scope forward?

## Summary

Phase 59 should be implemented as a narrow foundation artifact plus a deterministic validation check. The repo has no current Electron/Tauri dependency, but it already has release-host evidence scripts, npm/GitHub release workflows, RealTycoon2 PWA identity, and v2.9 capture/review regression assets. The safest plan is therefore to document and validate the native distribution contract now, then let Phase 60-64 add signing, updater, tray/shortcut, push, and final gates.

Recommended implementation for Phase 59:

1. Add `doc/NATIVE-DISTRIBUTION-FOUNDATION.md`.
2. Add a focused repo-local validation script/test that verifies the foundation document contains the locked shell choice, future package layout, credential inventory, updater key inventory, platform boundary, and v2.9 regression bundle.
3. Add a package script for that focused validation.
4. Close DIST-01 with planning artifacts and verification evidence only after the document/test/typecheck pass.

## Findings

### Native shell and package layout

- The current repo is web/PWA-first: root `package.json` exposes server/UI/CLI/release scripts, `ui/package.json` is a Vite/React package, and `pnpm-workspace.yaml` does not include `apps/*`.
- No current source package depends on Tauri or Electron. Electron references are present under `_refs/multica`, but `_refs` is reference material and not the current Paperclip/RealTycoon2 source of truth.
- Tauri v2 is the better foundation baseline because it can wrap the existing Vite UI while exposing updater, tray, global shortcut, notification, deep-link, and mobile-capable plugin surfaces. It keeps Phase 59 from inheriting Electron's larger runtime and reference-app assumptions.
- `apps/desktop` is the clean future package boundary. Keep `ui/` canonical and have native packaging consume `ui/dist`.

### Signing and updater evidence

- Tauri updater requires signed update artifacts and a public/private updater key pair. Official docs state that update signature verification cannot be disabled and that build signing variables for updater artifacts must come from environment variables, not `.env` files.
- Tauri updater configuration needs `bundle.createUpdaterArtifacts`, `plugins.updater.pubkey`, and endpoint URLs. Static update JSON requires version, URL, and signature.
- macOS signing must account for Developer ID identity, hardened runtime, notarization, and stapling/Gatekeeper evidence. Tauri supports signing identity through config or `APPLE_SIGNING_IDENTITY`.
- Windows signing must account for the selected trust path. Tauri docs cover OV certificates, Azure Key Vault, Azure Code Signing, custom sign commands, and SmartScreen/trust concerns for unsigned apps.
- Updater key material is separate from OS signing identities. Phase 59 should explicitly inventory both so Phase 60 and Phase 61 do not conflate them.

### Platform capability boundary

- Tauri has official system tray and global shortcut APIs that map to Phase 62.
- Tauri notification and deep-link plugins map to Phase 63 push/deep-link behavior, but real APNs/Web Push/device token delivery remains server/platform work and should not be implemented in Phase 59.
- Phase 59 should define the capability matrix but not add native runtime code. This keeps signing/updater/tray/push scope in their intended phases.

### Existing RT2 release and regression assets

- Release evidence already exists:
  - `scripts/rt2-release-host-verify.mjs`
  - `scripts/rt2-runtime-confidence.mjs`
  - `.github/workflows/release.yml`
  - `doc/RELEASING.md`
  - `doc/PUBLISHING.md`
  - `doc/RELEASE-HOST-VERIFICATION.md`
- RT2 identity and capture regression assets already exist:
  - `scripts/rt2-identity-gate.mjs`
  - `scripts/rt2-identity-gate.test.mjs`
  - `packages/shared/src/rt2-task.test.ts`
  - `server/src/__tests__/rt2-task-routes.test.ts`
  - `ui/src/lib/rt2-quick-capture-queue.test.ts`
  - `ui/src/pages/rt2/QuickCapturePage.test.tsx`
  - `ui/src/components/Rt2DailyBoard.test.tsx`
- Phase 59 should list these as gates, not re-open their implementation.

### Tooling caveats

- `gsd-sdk query` is not available in this environment.
- `node ~/.codex/get-shit-done/bin/gsd-tools.cjs init plan-phase 59` can find the manually created phase directory after CONTEXT.md exists.
- `gsd-tools phase complete 59` is unsafe here because it mis-parses the current table-form v3.0 roadmap/status shape. Do not use it for Phase 59 closure; update planning docs narrowly if needed.

## Validation Architecture

### Automated validation

- Add `scripts/rt2-native-distribution-foundation.test.mjs`.
- Add root package script `test:native-distribution-foundation`.
- The script should parse `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` as text and check for required sections and high-signal terms:
  - Tauri v2 baseline
  - `apps/desktop`
  - `ui/dist`
  - macOS Developer ID / hardened runtime / notarization / Gatekeeper
  - Windows MSIX or installer signing / timestamping / trust path
  - updater public/private key material and signed metadata
  - internal/beta/stable channels
  - v2.9 DRAFT/NATIVE/MSG/REVIEW regression bundle
  - explicit deferral of Phase 60-64 implementations
- This test is intentionally documentation-focused. It prevents Phase 59 from being marked complete with vague distribution prose.

### Commands

- Focused: `pnpm run test:native-distribution-foundation`
- Type safety: `pnpm typecheck`
- Optional existing identity gate: `pnpm run test:identity-gate`
- Do not run `pnpm test:e2e` by default.

### Manual validation

- Verify the foundation document contains no real secrets, tokens, certificates, private keys, or credential values.
- Verify the selected package layout does not modify `pnpm-lock.yaml`.
- Verify Phase 60-64 scope remains deferred.

## External Sources Checked

- Tauri Updater: `https://v2.tauri.app/plugin/updater/`
- Tauri macOS signing: `https://tauri.app/distribute/sign/macos/`
- Tauri Windows signing: `https://v2.tauri.app/distribute/sign/windows/`
- Tauri System Tray: `https://v2.tauri.app/learn/system-tray/`
- Tauri Global Shortcut: `https://v2.tauri.app/reference/javascript/global-shortcut/`
- Tauri Notifications: `https://v2.tauri.app/plugin/notification/`
- Tauri Deep Linking: `https://tauri.app/ko/plugin/deep-linking/`
- Electron autoUpdater: `https://www.electronjs.org/docs/latest/api/auto-updater`
- Electron Code Signing: `https://www.electronjs.org/docs/latest/tutorial/code-signing`

## RESEARCH COMPLETE
