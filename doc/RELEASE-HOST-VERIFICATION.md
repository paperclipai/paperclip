# Release Host Verification

Phase 44 adds a release-host verification harness for RT2 release confidence. Phase 45 adds embedded Postgres host-readiness evidence for Windows release hosts.

## Normal Run

```sh
pnpm run rt2:release-host-verify
```

The harness runs `pnpm typecheck` and the stable Vitest slice layout used by `pnpm test`. Evidence is written under:

```text
.planning/release-host-runs/<timestamp>/
```

Each run writes:

- `summary.json` - machine-readable slice attempts
- `report.md` - human-readable status table
- `logs/*.stdout.log` and `logs/*.stderr.log` - per-slice logs

## Rerun Failed Slices

```sh
pnpm run rt2:release-host-rerun -- .planning/release-host-runs/<timestamp>/summary.json
```

Rerun mode selects the latest failed, timed-out, or harness-error slices from the previous summary and appends new attempts to the same audit trail. It does not overwrite the original full-suite evidence.

## Embedded Postgres Host-Ready Coverage

Default Windows `pnpm test` keeps embedded Postgres suites skipped unless explicitly enabled. The release-host harness reports that default skip as `accepted_debt` instead of treating it as hidden pass confidence.

Run the focused host-ready path when validating embedded Postgres runtime coverage on a Windows release host:

```sh
pnpm run rt2:embedded-postgres-host-ready
```

To include that focused path directly in release-host verification:

```sh
pnpm run rt2:release-host-verify -- --include-embedded-postgres-host-ready
```

The focused path sets `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true` and runs DB persistence plus RT2 route persistence suites.

## Useful Options

```sh
node scripts/rt2-release-host-verify.mjs --timeout-ms 900000
node scripts/rt2-release-host-verify.mjs --only typecheck
node scripts/rt2-release-host-verify.mjs --include-embedded-postgres-host-ready
node scripts/rt2-release-host-verify.mjs --json
```

## Report Fields

- `suite` - verification slice family, such as `typecheck`, `vitest-project`, `server`, or `server-route`
- `durationMs` - wall-clock duration for the slice attempt
- `owner` - deterministic owner classification, such as `workspace`, `server`, `server-route`, `ui`, `db`, or `shared`
- `status` - `passed`, `accepted_debt`, `failed`, `timeout`, or `error`
- `retryRecommendation` - operator action for the slice

Browser E2E and release-smoke suites remain separate commands and are not part of the default release-host gate.

## Native Signing Gate

Phase 60 adds a separate native distribution signing gate:

```sh
pnpm run rt2:native-signing-gate -- --manifest path/to/native-signing-evidence.json
```

This gate is intentionally separate from the release-host Vitest/typecheck harness. It validates signing and trust evidence for native release artifacts and writes:

```text
.planning/native-signing-runs/<timestamp>/
```

Each run writes:

- `summary.json` - machine-readable status, blocker counts, platform checks, and evidence sources
- `report.md` - operator-readable blocker and passed-check tables

The command returns a non-zero exit code when required evidence is missing or failed. Required checks are:

- macOS: artifact, Developer ID Application identity, Apple Team ID, hardened runtime, codesign, notarization submission ID/evidence, ticket stapling, and Gatekeeper verification.
- Windows: artifact, installer format, selected trust path, certificate source, signing, timestamping/TSA, signature verification, and install trust evidence.

Native signing manifests must use secret references rather than raw credentials or private key material. The gate rejects obvious private key blocks, raw token patterns, and sensitive password/private-key fields that are not secret references.

## Runtime Confidence Report

Phase 47 adds a consolidated runtime confidence report that consumes release-host evidence and the milestone artifact gate:

```sh
pnpm run rt2:runtime-confidence
```

The report discovers the latest `.planning/release-host-runs/<timestamp>/summary.json` by default. To inspect a specific release-host run:

```sh
pnpm run rt2:runtime-confidence -- --release-host-summary .planning/release-host-runs/<timestamp>/summary.json
```

Evidence is written under:

```text
.planning/runtime-confidence/<timestamp>/
```

Each run writes:

- `summary.json` - machine-readable blocker, accepted debt, deferred scope, release-host, milestone-gate, and requirement evidence.
- `report.md` - human-readable operations report.

The report uses the same operational taxonomy as the milestone gate and release-host harness:

- `blocker` - release cannot be trusted until an action is taken.
- `accepted_debt` - known debt with owner, reason, and closure command.
- `deferred_scope` - future work outside the v2.7 confidence close.
- `pending` - planned requirement or evidence not complete yet.
- `passed` - evidence-backed pass signal.
