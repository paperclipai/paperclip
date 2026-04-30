# RealTycoon2 Native Distribution Foundation

**Status:** Phase 59 foundation contract  
**Requirement:** DIST-01  
**Last updated:** 2026-04-30

이 문서는 RealTycoon2 v3.0 native distribution 작업의 기준선이다. Phase 59는 native app을 구현하지 않는다. 대신 downstream Phase 60-64가 signing, updater, tray, shortcut, push, release gate를 구현할 때 따라야 할 shell 선택, package layout, platform boundary, credential inventory, regression gate를 확정한다.

## Scope

### In scope for Phase 59

- Native shell baseline 결정
- Future package layout 결정
- macOS/Windows signing credential inventory 결정
- Updater key material inventory 결정
- Internal/beta/stable channel evidence fields 결정
- v2.9 DRAFT/NATIVE/MSG/REVIEW regression gate boundary 결정
- Foundation document validation

### Out of scope for Phase 59

- Tauri/Electron dependency 추가
- `apps/desktop` scaffold 생성
- macOS signing/notarization 구현
- Windows MSIX/installer signing 구현
- Signed updater feed 구현
- Tray/menubar 또는 global shortcut 구현
- Mobile/Web Push/APNs 구현
- Public store listing, marketing, reviewer account operations

## Native Shell Baseline

| Decision | Value |
|----------|-------|
| Selected baseline | Tauri v2 |
| Fallback reference | Electron/electron-builder only if Tauri cannot satisfy a required platform gate |
| Current repo state | Web/PWA-first, no Tauri or Electron dependency in current source packages |
| Phase 59 dependency policy | Do not add native dependencies or lockfile churn |

Tauri v2 is selected because RealTycoon2 already has a Vite/React UI and needs a small native host with updater, tray, global shortcut, notification, deep-link, and future mobile capability boundaries. Electron remains useful as a fallback reference, but `_refs/multica` is not current Paperclip/RealTycoon2 source truth.

## Future Package Layout

Future native package layout:

```text
apps/
  desktop/
    package.json
    src-tauri/
      Cargo.toml
      tauri.conf.json
      src/
        lib.rs
```

Rules:

- `ui/` remains the canonical React/Vite UI package.
- Development native shell should use the Vite dev URL from `ui/vite.config.ts`.
- Packaged native shell should consume `ui/dist`.
- Add `apps/*` to `pnpm-workspace.yaml` only when the desktop package is actually created.
- Do not commit `pnpm-lock.yaml` changes for Phase 59.
- Native identity should be RealTycoon2-first: app name `RealTycoon2`, bundle identifier such as `com.isens.realtycoon2`, Korean product-facing labels.

## Runtime Boundary

The first native package is a host/wrapper around existing RealTycoon2 web and API boundaries. It must not rewrite server, embedded Postgres, CLI onboarding, auth, approval, board review, or capture draft persistence.

Allowed future native host responsibilities:

- Launch RealTycoon2 shell
- Display build identity and release channel
- Surface signed updater state
- Surface tray/shortcut permission and conflict state
- Route native capture intent into the existing draft review flow
- Handle deep links back to RT2 board/review targets

Deferred until explicitly planned:

- Bundling or supervising a local server sidecar
- Changing embedded Postgres runtime behavior
- Offline-first sync beyond existing quick capture queue semantics

## Platform Capability Boundary

| Capability | Owner phase | Boundary |
|------------|-------------|----------|
| Native shell/package foundation | 59 | Documented only |
| macOS/Windows signing and notarization/trust | 60 | Build/sign evidence, no updater channel logic |
| Release channels and signed updater | 61 | Metadata, checksum, signature, rollout, rollback |
| Resident tray/menubar | 62 | Status and quick capture entry into review flow |
| OS-level global shortcut | 62 | Register/unregister/change/conflict/permission state |
| Mobile/Web Push/APNs loop | 63 | Company/user/device-scoped token and delivery evidence |
| Final distribution gate | 64 | Blocks unsigned/untrusted/wrong-channel/stale-updater/v2.9-regressed artifacts |

Native capture from tray, shortcut, deep link, or push must enter persistent draft revision and board review. It must never auto-apply work before approval.

## macOS Signing Inventory

| Field | Required owner/evidence |
|-------|-------------------------|
| Developer ID Application identity | Owner and certificate source |
| Apple Team ID | Owner and CI secret reference |
| Apple ID or App Store Connect API key path | Secret reference only |
| Hardened runtime entitlement owner | File/path owner and review owner for hardened runtime settings |
| Notarization submission owner | CI job/evidence owner |
| Ticket stapling evidence owner | CI job/evidence owner |
| Gatekeeper verification evidence | Command output owner |

Official Tauri reference points:

- macOS signing identity can be configured in `tauri.conf.json > bundle > macOS > signingIdentity` or via `APPLE_SIGNING_IDENTITY`.
- Developer ID distribution requires notarization.

## Windows Signing Inventory

| Field | Required owner/evidence |
|-------|-------------------------|
| Installer format | MSIX, MSI, NSIS, or documented alternative |
| Trust path | Store re-signing, Azure Trusted Signing/Azure Code Signing, Azure Key Vault, EV/OV certificate, or custom sign command |
| Certificate source | Issuer, vault, or store path reference |
| Timestamping | TSA URL/reference and timestamping evidence owner |
| Sign command owner | CI command or tool owner |
| SmartScreen/trust evidence | Install/download trust evidence owner |

Official Tauri reference points:

- Tauri supports Windows signing through certificate paths, Azure Key Vault, Azure Code Signing, and custom sign commands.
- Cross-compiling Windows installers generally requires a custom sign command because the default implementation works on Windows hosts.

## Phase 60 Signing Evidence Gate

Phase 60 adds a deterministic native signing gate:

```sh
pnpm run rt2:native-signing-gate -- --manifest path/to/native-signing-evidence.json
```

The gate validates macOS and Windows evidence manifests and writes durable evidence under `.planning/native-signing-runs/`:

- `summary.json` - machine-readable pass/blocker status, platform checks, and blocker codes
- `report.md` - operator-readable blocker table and passed checks

The command exits non-zero when signing or trust evidence is incomplete.

### Manifest Shape

```json
{
  "platforms": {
    "macos": {
      "artifact": "dist/RealTycoon2.dmg",
      "developerIdApplication": "Developer ID Application: iSens Corp. (TEAMID1234)",
      "appleTeamId": "TEAMID1234",
      "hardenedRuntime": { "status": "passed", "evidence": "evidence/macos-hardened-runtime.txt" },
      "codesign": { "status": "passed", "evidence": "evidence/macos-codesign.txt" },
      "notarization": { "status": "passed", "submissionId": "notary-submission-id", "evidence": "evidence/macos-notarization.json" },
      "stapling": { "status": "passed", "evidence": "evidence/macos-stapling.txt" },
      "gatekeeper": { "status": "passed", "evidence": "evidence/macos-gatekeeper.txt" }
    },
    "windows": {
      "artifact": "dist/RealTycoon2.msix",
      "installerFormat": "msix",
      "trustPath": "azure_artifact_signing",
      "certificateSource": "secret-ref:WINDOWS_SIGNING_CERTIFICATE",
      "signing": { "status": "passed", "evidence": "evidence/windows-signing.txt" },
      "timestamping": { "status": "passed", "tsa": "https://timestamp.example", "evidence": "evidence/windows-timestamp.txt" },
      "signatureVerification": { "status": "passed", "evidence": "evidence/windows-verify.txt" },
      "installTrust": { "status": "passed", "evidence": "evidence/windows-install-trust.txt" }
    }
  }
}
```

Supported Windows `trustPath` values are `store_resigning`, `store`, `msix_store`, `azure_artifact_signing`, `azure_trusted_signing`, `azure_code_signing`, `azure_key_vault`, `ev_certificate`, `ov_certificate`, and `custom_sign_command`.

### Required Blocking Behavior

- macOS blocks on missing artifact, Developer ID Application identity, Apple Team ID, hardened runtime, codesign, notarization submission ID/evidence, stapling, or Gatekeeper evidence.
- Windows blocks on missing artifact, installer format, selected trust path, certificate source, signing, timestamping/TSA, signature verification, or install trust evidence.
- Evidence fields may reference local evidence files, URLs, CI artifact references, or inline command output objects.
- Raw private keys, passwords, provider tokens, and certificate private material are rejected. Use `secret-ref:...`, `env:...`, `github-secret:...`, `azure-key-vault:...`, `keychain:...`, or equivalent secret references.

## Phase 61 Release Channel Evidence Gate

Phase 61 adds a deterministic release channel and signed updater metadata gate:

```sh
pnpm run rt2:release-channel-gate -- --manifest path/to/release-channel-evidence.json
```

The gate validates internal/beta/stable channel manifests and writes durable evidence under `.planning/native-updater-runs/`:

- `summary.json` - machine-readable pass/blocker status, installed state, update state, blocker counts, and passed checks
- `report.md` - operator-readable installed/update state, blocker table, and passed-check table

The command exits non-zero when release channel or updater metadata is incomplete.

### Release Channel Manifest Shape

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-30T00:00:00.000Z",
  "installed": {
    "channel": "beta",
    "version": "2026.430.0",
    "buildId": "beta-2026.430.0-current"
  },
  "updateState": {
    "state": "available",
    "checkedAt": "2026-04-30T00:00:00.000Z",
    "latestChannel": "beta",
    "latestVersion": "2026.430.0",
    "failureReason": null
  },
  "channels": {
    "internal": {
      "version": "2026.430.0",
      "buildId": "internal-2026.430.0-build",
      "notes": "Internal rollout notes",
      "pubDate": "2026-04-30T00:00:00.000Z",
      "rollout": { "strategy": "all", "percentage": 100 },
      "rollback": {
        "version": "2026.429.0",
        "buildId": "internal-2026.429.0-rollback",
        "reason": "last known good build"
      },
      "platforms": {
        "darwin-x86_64": {
          "url": "https://releases.example.test/internal/RealTycoon2.app.tar.gz",
          "artifact": "dist/RealTycoon2.app.tar.gz",
          "checksum": "<sha256>",
          "signature": "<contents of generated .sig file>",
          "signingSummary": ".planning/native-signing-runs/<timestamp>/summary.json",
          "signingPlatform": "macos"
        },
        "windows-x86_64": {
          "url": "https://releases.example.test/internal/RealTycoon2.msi.zip",
          "artifact": "dist/RealTycoon2.msi.zip",
          "checksum": "<sha256>",
          "signature": "<contents of generated .sig file>",
          "signingSummary": ".planning/native-signing-runs/<timestamp>/summary.json",
          "signingPlatform": "windows"
        }
      }
    },
    "beta": { "...": "same shape as internal" },
    "stable": { "...": "same shape as internal" }
  }
}
```

Required pass conditions:

- `installed.channel`, `installed.version`, and `installed.buildId` are present.
- `updateState.state` is one of `idle`, `checking`, `available`, `downloading`, `downloaded`, `installing`, `relaunch_required`, `failed`, or `rolled_back`.
- `internal`, `beta`, and `stable` channel entries are all present.
- Every channel has version, build ID, notes or notesUrl, rollout policy, rollback candidate, and platform metadata.
- Every platform has HTTPS artifact URL, SHA-256 checksum, updater signature content, and a passed Phase 60 signing summary for the matching platform.
- If a local `artifact` path is provided, its SHA-256 must match the manifest checksum.
- Updater signature values must be the generated `.sig` content. Paths, URLs, and secret references are blockers.
- Raw updater private keys, updater key passwords, provider tokens, and certificate material are rejected. Use secret references only for private key material.

Supported rollout strategies are `all`, `percentage`, and `paused`. Percentage rollout requires a numeric `percentage` between 0 and 100. Rollback candidate metadata is mandatory for every channel before the feed can pass.

## Updater Key Material

Updater signing is separate from OS code signing.

| Field | Rule |
|-------|------|
| Updater public key | May be committed in config once generated |
| Updater private key | Secret reference only |
| Private key password | Secret reference only if used |
| Rotation owner | Named owner or CI/release role |
| Storage location | Secret store path/reference, not raw value |
| Metadata signature evidence | CI artifact or release evidence path |

Official Tauri reference points:

- The updater verifies signed update artifacts and signature verification cannot be disabled.
- `bundle.createUpdaterArtifacts` controls updater artifact generation.
- Updater config requires `plugins.updater.pubkey` and endpoint URLs.
- Static updater metadata requires version, URL, and signature.

## Release Channels

Future channel records must support:

| Channel | Required fields |
|---------|-----------------|
| internal | version, artifact URL, checksum, signature, notes, rollout policy, rollback candidate |
| beta | version, artifact URL, checksum, signature, notes, rollout policy, rollback candidate |
| stable | version, artifact URL, checksum, signature, notes, rollout policy, rollback candidate |

Phase 61 owns implementation. Phase 59 only fixes the evidence shape so signing/updater planning does not drift.

## v2.9 Regression Gates

v2.9 capture reliability is shipped baseline. Distribution work may only add gates or fix concrete gate failures.

Focused gate bundle:

- `packages/shared/src/rt2-task.test.ts`
- `server/src/__tests__/rt2-task-routes.test.ts`
- `ui/src/lib/rt2-quick-capture-queue.test.ts`
- `ui/src/pages/rt2/QuickCapturePage.test.tsx`
- `ui/src/components/Rt2DailyBoard.test.tsx`
- `pnpm run test:identity-gate`
- `pnpm run rt2:identity-gate`
- `pnpm typecheck`

Default exclusions:

- Do not run `pnpm test:e2e` as the default distribution foundation gate.
- Do not reopen DRAFT/NATIVE/MSG/REVIEW implementation unless a gate fails.

## Secret Hygiene

Never commit:

- Apple passwords, app-specific passwords, API private keys, or tokens
- Windows certificate private keys or vault credentials
- Tauri updater private key material
- Signing key passwords
- Raw provider credentials

Documents may contain only placeholders and secret references, for example:

- `APPLE_SIGNING_IDENTITY=<secret-ref>`
- `TAURI_SIGNING_PRIVATE_KEY=<secret-ref>`
- `WINDOWS_SIGNING_CERTIFICATE=<secret-ref>`

## Local Canonical References

- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- `.planning/phases/59-native-distribution-foundation/59-CONTEXT.md`
- `.planning/phases/59-native-distribution-foundation/59-RESEARCH.md`
- `.github/workflows/release.yml`
- `package.json`
- `pnpm-workspace.yaml`
- `ui/package.json`
- `ui/vite.config.ts`
- `ui/public/site.webmanifest`
- `doc/RELEASING.md`
- `doc/PUBLISHING.md`
- `doc/RELEASE-AUTOMATION-SETUP.md`
- `doc/RELEASE-HOST-VERIFICATION.md`

## External Official References

- Tauri Updater: `https://v2.tauri.app/plugin/updater/`
- Tauri macOS signing: `https://tauri.app/distribute/sign/macos/`
- Tauri Windows signing: `https://v2.tauri.app/distribute/sign/windows/`
- Tauri System Tray: `https://v2.tauri.app/learn/system-tray/`
- Tauri Global Shortcut: `https://v2.tauri.app/reference/javascript/global-shortcut/`
- Tauri Notifications: `https://v2.tauri.app/plugin/notification/`
- Tauri Deep Linking: `https://tauri.app/ko/plugin/deep-linking/`
- Electron autoUpdater: `https://www.electronjs.org/docs/latest/api/auto-updater`
- Electron Code Signing: `https://www.electronjs.org/docs/latest/tutorial/code-signing`

## Phase 60-64 Handoff

Next phase:

- Phase 60 should implement signing/notarization/trust evidence using this inventory.

Later phases:

- Phase 61 implements channels and signed updater feed.
- Phase 62 implements resident tray and global shortcut.
- Phase 63 implements mobile push loop.
- Phase 64 enforces final distribution and v2.9 regression gates.
