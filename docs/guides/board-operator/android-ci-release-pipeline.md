---
title: Android CI + Release Pipeline
summary: CI lanes, secret contract, and internal-track release checklist for Paperclip Mobile
---

This guide defines the Android pipeline introduced in `.github/workflows/mobile-android.yml`.

## Pipeline Lanes

| Lane | Trigger | Purpose | Output |
| --- | --- | --- | --- |
| `verify` | `pull_request`, `push main`, `workflow_dispatch` | Lint, typecheck, run deterministic emulator offline-recovery harness (`OFF-02`, `OFF-03`), and build Android web-export artifact | `mobile-android-artifact`, `mobile-offline-recovery-artifacts` |
| `internal-release` | `workflow_dispatch` with `run_internal_release=true` | Run a non-interactive EAS Android internal build | `mobile-android-release-metadata` |

## Secret Contract

No raw secret values belong in git. Use GitHub Environment secrets (`mobile-internal`) and/or EAS-managed credentials.

| Secret | Required For | Stored In | Notes |
| --- | --- | --- | --- |
| `EXPO_TOKEN` | `internal-release` lane | GitHub Environment `mobile-internal` | Token from Expo account with permission to build this project |
| Android keystore material | First-time signing setup | EAS credentials store (recommended) | Configure once with `eas credentials`; keep out of git and CI logs |
| Play Console service account JSON | Optional automated submit | GitHub Environment secret | Needed only if you automate Google Play internal-track submission |

## Build Profiles

Profiles are defined in `mobile/eas.json`:

- `internal`: internal distribution, Android APK
- `production`: store distribution, Android AAB with auto-increment enabled

## One-Time Setup

1. Ensure `mobile/` is linked to the correct Expo project (`eas project:init` if needed).
2. Configure Android signing once with `eas credentials` (recommended: store in EAS).
3. Create GitHub Environment `mobile-internal` and set `EXPO_TOKEN`.
4. Run workflow once via `workflow_dispatch` with `run_internal_release=true`.

## Internal Release Checklist

1. Confirm `verify` lane passed on the commit to release.
2. Run `Mobile Android CI` manually with `run_internal_release=true`.
3. Wait for successful `Trigger internal Android release build`.
4. Download `mobile-offline-recovery-artifacts` and verify `offline-recovery-report.json` marks `OFF-02` + `OFF-03` as passed.
5. Download `mobile-android-release-metadata` artifact and record build ID/URL.
6. Share release notes using `guides/board-operator/android-release-notes-template`.
7. Execute smoke checks with `guides/board-operator/android-internal-testing-quickstart`.

## Offline Harness Hook Contract

The harness script (`mobile/scripts/ci-offline-recovery-harness.mjs`) supports optional phase hooks for app-level smoke actions:

- `OFFLINE_RECOVERY_PRE_OFFLINE_HOOK`
- `OFFLINE_RECOVERY_OFFLINE_HOOK`
- `OFFLINE_RECOVERY_RECOVERY_HOOK`

Each hook is an executable shell command and runs during that phase if defined.
