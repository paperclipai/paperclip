---
phase: 60
slug: signing-and-notarization-pipeline
status: passed
verified: 2026-04-30
requirements_verified:
  - DIST-02
  - DIST-03
plans_verified:
  - 60-01-PLAN.md
---

# Phase 60 Verification: Signing and Notarization Pipeline

## Result

Status: `passed`

Phase 60 delivered a native signing evidence gate that validates macOS Developer ID/hardened runtime/codesign/notarization/stapling/Gatekeeper evidence and Windows trust path/signing/timestamping/signature verification/install trust evidence. Missing or failed checks produce stable blockers and a non-zero command exit.

## Requirement Evidence

| Requirement | Evidence | Status |
|-------------|----------|--------|
| DIST-02 | `scripts/rt2-native-signing-gate.mjs` validates macOS artifact, Developer ID Application identity, Apple Team ID, hardened runtime, codesign, notarization submission ID/evidence, stapling, and Gatekeeper evidence. Focused tests cover complete and missing-notarization cases. | passed |
| DIST-03 | `scripts/rt2-native-signing-gate.mjs` validates Windows artifact, installer format, selected trust path, certificate source, signing, timestamping/TSA, signature verification, and install trust evidence. Focused tests cover complete and missing-timestamp cases. | passed |

## Automated Checks

| Command | Result |
|---------|--------|
| `pnpm run test:native-signing-gate` | passed |
| `pnpm run test:native-distribution-foundation` | passed |
| `pnpm typecheck` | passed |
| `git diff -- pnpm-lock.yaml` | clean |

## Coverage Notes

- Complete fixture manifests pass and write `summary.json` plus `report.md`.
- Missing macOS notarization produces `MACOS_NOTARIZATION_MISSING`.
- Missing Windows timestamping produces `WINDOWS_TIMESTAMP_NOT_PASSED`.
- Missing evidence files produce platform-specific file blockers.
- Raw private key text and non-reference sensitive password fields are rejected.
- The gate is credential-free in local dev; real Apple notarization and Windows install trust evidence must be provided by operators through manifest evidence paths/references.

## Residual Risk

- This phase validates evidence contracts and failure behavior. It does not perform real Apple notarization or Windows signing on this host because production credentials and native artifacts are not committed to the repo.
- Phase 61 must keep updater artifact signatures and channel metadata separate from OS signing evidence.
- Phase 64 should aggregate this signing gate with updater/channel/v2.9 regression gates into the final distribution gate.

## Self-Check

PASSED - all Phase 60 must-haves and success criteria are represented in code, tests, docs, and planning artifacts.
