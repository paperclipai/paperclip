# Phase 61: Release Channels and Signed Updater - Research

**Researched:** 2026-04-30
**Status:** Complete

## Research Question

What does planning need to know to implement the smallest safe internal/beta/stable release channel and signed updater evidence gate for RealTycoon2 without pulling resident tray, global shortcut, mobile push, or final distribution gate scope forward?

## Summary

Phase 61 should add a deterministic release-channel/updater evidence gate, not a full native desktop scaffold. Tauri v2 is already selected as the native baseline, but the current repo still has no `apps/desktop` package and no native updater runtime. The most reliable next step is to validate the update feed contract with Node scripts, fixtures, and operator docs, then let a future native shell consume the same channel/update state.

Official Tauri updater docs show that the updater relies on generated signing keys, updater artifacts, and static or dynamic JSON metadata. The public key is safe to configure, the private key must stay protected, `.env` files are not accepted for build signing variables, and `bundle.createUpdaterArtifacts` controls generation of updater bundles and `.sig` files. Static JSON metadata uses `version`, `notes`, `pub_date`, and `platforms`, where each platform entry has a `url` and a `signature` whose value is the content of the generated `.sig` file, not a path or URL. Dynamic updater responses similarly require `url`, `version`, and `signature`; `204 No Content` means no update is available.

The existing repo pattern is already strong enough for Phase 61: `rt2-native-signing-gate` validates Phase 60 signing evidence and writes `summary.json`/`report.md`; release-host/runtime-confidence scripts use timestamped evidence directories; package scripts expose focused operator gates. Phase 61 should mirror those patterns for release channel metadata, required rollback candidates, signature/checksum fields, rollout policy, installed/latest build identity, and signing gate prerequisites.

## Findings

### Tauri v2 updater contract

- Tauri updater key generation creates a public key and private key. The public key can be configured/shared; the private key signs installer/update files and must never be shared.
- Build signing variables are environment variables such as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; `.env` files are not accepted for this build-time signing path.
- `bundle.createUpdaterArtifacts: true` causes Tauri to create updater bundles and signatures.
- Tauri v2 updater artifacts include platform-specific update bundles and `.sig` files. On macOS, Tauri creates an app `.tar.gz` and `.sig`; on Windows, updater bundles are `.zip` files derived from MSI/NSIS outputs plus `.sig`.
- `plugins.updater.pubkey` must contain the generated public key content, not a file path. Production endpoints must use TLS unless dangerous insecure transport is explicitly enabled.
- Static update JSON supports platform entries keyed by `OS-ARCH`, such as `windows-x86_64` or `darwin-aarch64`.
- Static JSON required keys are `version`, `platforms.[target].url`, and `platforms.[target].signature`; `notes` and `pub_date` are optional in Tauri but required by RealTycoon2 Phase 61 decisions for operator clarity.
- The `signature` field is the content of the generated `.sig` file, not a path or URL.
- Dynamic update server responses require `url`, `version`, and `signature`, and can support rollback by overriding the updater version comparison or allowing downgrades deliberately.
- JavaScript updater API exposes `check()`, `download()`, `install()`, and `downloadAndInstall()` plus progress events. `check()` returns `Update | null`.

### RealTycoon2 channel contract

- Native release channels should be separate from npm dist-tags. Existing npm `canary`/`latest` is package publishing truth, not enough for native platform artifact rollout, rollback, checksum, and updater signatures.
- Every channel should include `internal`, `beta`, and `stable` entries, even if a pre-release channel is paused. Missing channel entries are blockers because operators need explicit visibility.
- Each channel entry needs per-platform artifact metadata because macOS and Windows can have different signing/trust evidence and different update bundles.
- Rollback candidate metadata should be required even for internal/beta. A channel with no rollback candidate is not publishable; it can be represented only as a blocker or paused state.
- The feed should cite a Phase 60 native signing gate `summary.json` for each platform artifact. Updater metadata should not pass when OS signing/trust evidence is blocked.

### Existing repo implementation pattern

- `scripts/rt2-native-signing-gate.mjs` is the closest implementation analog: parse args, validate JSON, collect blockers/passed checks, write `summary.json` and `report.md`, return non-zero for blockers, and export pure functions for tests.
- `scripts/rt2-native-signing-gate.test.mjs` shows fixture creation, temporary evidence roots, CLI invocation, and blocker assertions.
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` already owns the canonical native distribution contract. Phase 61 docs should extend this file rather than creating a second canonical operator contract.
- `doc/RELEASE-HOST-VERIFICATION.md` is the right runbook surface for operator commands and evidence locations.
- Package scripts use `rt2:*` for operator commands and `test:*` for focused tests.

### Security and secret hygiene

- Release channel manifests may include updater public key material or a public key reference. Private updater key material, updater key passwords, Apple credentials, Windows certificate private keys, and provider tokens must be rejected if raw values appear.
- Fixture tests may generate dummy artifact files and dummy signatures, but real private keys must not be committed.
- Signature validation in the repo-local gate should at minimum reject missing signatures and path/URL signature values because Tauri expects signature content. Full Minisign verification can remain native runtime/tooling responsibility unless a plan adds a small verified verifier without dependencies.

## Validation Architecture

### Automated validation

Add `scripts/rt2-release-channel-gate.test.mjs` to cover:

- A complete manifest with internal/beta/stable channels, installed state, per-platform artifacts, checksums, signature content, rollback candidates, rollout policies, and passed Phase 60 signing summaries produces `status: passed`.
- Missing required channel entries produce blockers.
- Missing checksum, URL, signature, notes, rollout policy, or rollback candidate produces channel/platform blockers.
- Signature values that look like paths or URLs are rejected because Tauri expects `.sig` file contents.
- Local artifact checksum mismatches are blockers when an artifact path is provided.
- Referenced Phase 60 signing summaries that are missing, blocked, or lack the target platform are blockers.
- Raw updater private key or password fields are rejected unless represented as secret references.
- CLI execution writes `summary.json` and `report.md` and exits `0` for pass, non-zero for blocker.

### Commands

- Focused: `pnpm run test:release-channel-gate`
- Operator gate: `pnpm run rt2:release-channel-gate -- --manifest <path>`
- Type safety: `pnpm typecheck`
- Do not run `pnpm test:e2e` by default.

### Manual validation

- Inspect generated `report.md` for channel/platform grouping and clear next actions.
- Inspect docs to ensure updater private keys and credentials are never shown as raw values.
- Confirm `pnpm-lock.yaml` remains unchanged.

## External Sources Checked

- Tauri updater plugin: `https://v2.tauri.app/plugin/updater/`
- Tauri updater JavaScript API: `https://v2.tauri.app/reference/javascript/updater/`

## RESEARCH COMPLETE
