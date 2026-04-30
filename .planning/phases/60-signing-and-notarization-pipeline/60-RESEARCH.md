# Phase 60: Signing and Notarization Pipeline - Research

**Researched:** 2026-04-30
**Status:** Complete

## Research Question

What does planning need to know to implement the smallest safe signing/notarization/trust evidence pipeline for RealTycoon2 without pulling Phase 61 updater channels or Phase 64 final distribution gate scope forward?

## Summary

Phase 60 should add a deterministic native signing evidence gate, not a full native packaging scaffold. The repo already has strong release evidence patterns (`rt2-release-host-verify`, `rt2-runtime-confidence`, focused Node assertion tests, and Markdown operator docs). Phase 59 selected Tauri v2 and documented the credential inventory, but the repo still has no `apps/desktop` package and no real signing credentials. The safest Phase 60 implementation is therefore:

1. Add a repo-local `rt2-native-signing-gate` script that validates structured macOS and Windows evidence manifests.
2. Emit `.planning/native-signing-runs/<timestamp>/summary.json` and `report.md`.
3. Fail closed when macOS Developer ID/hardened runtime/notarization/stapling/Gatekeeper evidence or Windows trust path/signing/timestamp/install trust evidence is missing or failed.
4. Add focused tests and package scripts.
5. Update native/release docs so operators know how to provide evidence without committing secrets.

This closes `DIST-02` and `DIST-03` as an evidence contract and release gate. It does not implement release channels, updater metadata, tray/shortcut, mobile push, public store operations, or native capture behavior.

## Findings

### macOS signing and notarization

- Tauri's current macOS signing docs state that macOS code signing is required for App Store listing and to avoid downloaded-app launch warnings. Developer ID Application is the outside-App-Store certificate type and notarization is required when using it.
- Tauri can use `bundle.macOS.signingIdentity` or `APPLE_SIGNING_IDENTITY`; CI signing requires secret-backed Apple certificate material.
- Notarization can use App Store Connect API credentials or Apple ID/app-specific password plus Team ID. These are secret references only for this repo.
- Phase 60 should not attempt to run notarization on the current Windows host. It should require durable evidence fields and fail closed when they are missing.

Recommended macOS manifest shape:

```json
{
  "platform": "macos",
  "artifact": "dist/RealTycoon2.dmg",
  "developerIdApplication": "Developer ID Application: ...",
  "appleTeamId": "TEAMID1234",
  "hardenedRuntime": { "status": "passed", "evidence": "..." },
  "codesign": { "status": "passed", "evidence": "..." },
  "notarization": { "status": "passed", "submissionId": "...", "evidence": "..." },
  "stapling": { "status": "passed", "evidence": "..." },
  "gatekeeper": { "status": "passed", "evidence": "..." }
}
```

### Windows signing and trust

- Microsoft MSIX docs state that app package signing is required for deployable MSIX packages and that the package must be trusted on the device via a trusted certificate chain.
- Microsoft lists production signing options including Azure Artifact Signing, OV certificate, and Microsoft Store signing.
- Microsoft SignTool signs, timestamps, and verifies files; current SDK guidance requires explicit digest algorithm options for signing and timestamping.
- Tauri Windows signing docs cover certificate thumbprint/digest/timestamp URL, custom sign commands, Azure Key Vault, and Azure Code Signing/Trusted Signing CLI-style flows. They also note SmartScreen reputation differences between OV/EV paths.

Recommended Windows manifest shape:

```json
{
  "platform": "windows",
  "artifact": "dist/RealTycoon2.msix",
  "installerFormat": "msix",
  "trustPath": "azure_artifact_signing",
  "certificateSource": "secret-ref:WINDOWS_SIGNING_CERTIFICATE",
  "signing": { "status": "passed", "evidence": "..." },
  "timestamping": { "status": "passed", "tsa": "https://...", "evidence": "..." },
  "signatureVerification": { "status": "passed", "evidence": "..." },
  "installTrust": { "status": "passed", "evidence": "..." }
}
```

### Existing repo implementation pattern

- `scripts/rt2-release-host-verify.mjs` provides the closest script pattern: parse args, produce a timestamped evidence directory, write `summary.json` and `report.md`, return non-zero on blockers, and expose pure functions for tests.
- `scripts/rt2-runtime-confidence.mjs` provides report table and aggregation style.
- `scripts/rt2-native-distribution-foundation.test.mjs` shows that simple Node assertion scripts are acceptable for focused docs/evidence gates.
- Package scripts should follow `rt2:*` for runnable operator commands and `test:*` for focused tests.

### Security and secret hygiene

- Evidence manifests must not embed raw Apple passwords, API private keys, certificate private keys, PFX passwords, Azure client secrets, or updater private keys.
- The gate can accept secret references such as `secret-ref:APPLE_CERTIFICATE` or CI environment variable names, but should reject obvious raw private key blocks and common token/certificate password assignments.
- Test fixtures should use dummy paths and secret references only.

## Validation Architecture

### Automated validation

Add `scripts/rt2-native-signing-gate.test.mjs` to cover:

- A complete macOS + Windows fixture passes and writes `summary.json`/`report.md`.
- Missing notarization/stapling/Gatekeeper evidence produces macOS blockers.
- Missing Windows trust path or timestamping evidence produces Windows blockers.
- Missing referenced artifact/evidence files are blockers.
- Obvious raw secret patterns are rejected or redacted.
- CLI exits `0` for pass and non-zero for blocker status.

### Commands

- Focused: `pnpm run test:native-signing-gate`
- Operator gate: `pnpm run rt2:native-signing-gate -- --manifest <path>`
- Type safety: `pnpm typecheck`
- Do not run `pnpm test:e2e` by default.

### Manual validation

- Inspect generated `report.md` for platform/check grouping and useful next actions.
- Inspect docs to ensure they contain no real credentials.
- Confirm `pnpm-lock.yaml` remains unchanged.

## External Sources Checked

- Tauri macOS signing: `https://tauri.app/distribute/sign/macos/`
- Tauri Windows signing: `https://v2.tauri.app/distribute/sign/windows/`
- Tauri updater artifact signatures: `https://v2.tauri.app/plugin/updater/`
- Apple notarization documentation: `https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution`
- Microsoft MSIX signing overview: `https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview`
- Microsoft SignTool reference: `https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool`
- Microsoft SignTool MSIX package signing: `https://learn.microsoft.com/en-us/windows/msix/package/sign-app-package-using-signtool`
- Microsoft Azure Artifact Signing overview: `https://learn.microsoft.com/en-us/azure/artifact-signing/overview`

## RESEARCH COMPLETE
