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

## Release Channel Gate

Phase 61 adds a separate native updater/release channel gate:

```sh
pnpm run rt2:release-channel-gate -- --manifest path/to/release-channel-evidence.json
```

This gate validates internal/beta/stable channel metadata before an update feed can be considered publishable. It writes:

```text
.planning/native-updater-runs/<timestamp>/
```

Each run writes:

- `summary.json` - machine-readable status, installed channel/build identity, update state, blocker counts, and passed checks
- `report.md` - operator-readable installed/update state plus blocker and passed-check tables

The command returns a non-zero exit code when release channel or updater metadata is incomplete. Required checks include:

- Installed state: channel, version, and build ID.
- Update state: one of `idle`, `checking`, `available`, `downloading`, `downloaded`, `installing`, `relaunch_required`, `failed`, or `rolled_back`.
- Channels: `internal`, `beta`, and `stable` are all present.
- Channel metadata: version, build ID, notes or notesUrl, rollout policy, and rollback candidate.
- Platform metadata: HTTPS artifact URL, SHA-256 checksum, updater signature content, and Phase 60 signing summary reference.
- Signing prerequisite: referenced native signing gate summary exists, has `status: passed`, and includes the matching macOS or Windows platform.
- Local artifact checksum: when an `artifact` path is provided, the file hash matches the manifest checksum.
- Secret hygiene: raw private keys, passwords, provider tokens, and updater private key values are rejected.

The `signature` field must contain the generated `.sig` file contents. A path, URL, or secret reference is a blocker because Tauri updater metadata expects signature content in the feed.

## Resident Surface Gate

Phase 62 adds a separate resident tray/menubar and global shortcut gate:

```sh
pnpm run rt2:resident-surface-gate -- --manifest path/to/resident-surface-evidence.json
```

This gate validates the native resident surface before tray or shortcut behavior can be treated as release-ready. It writes:

```text
.planning/native-resident-runs/<timestamp>/
```

Each run writes:

- `summary.json` - machine-readable status, installed/update state, tray status, shortcut lifecycle, capture handoff, blocker counts, and passed checks
- `report.md` - operator-readable tray status, shortcut state, capture handoff, blocker table, and passed-check table

The command returns a non-zero exit code when resident surface evidence is incomplete. Required checks include:

- Installed state: channel, version, and build ID.
- Update state: one of `idle`, `checking`, `available`, `downloading`, `downloaded`, `installing`, `relaunch_required`, `failed`, or `rolled_back`.
- Tray status: quick capture availability, queue/sync state, auth state, company state, release channel, build identity, update lifecycle state, failure reason when failed, and macOS/Windows evidence.
- Tray identity match: tray release channel, build identity, and update state match the top-level installed/update state.
- Shortcut lifecycle: accelerator, registration, conflict, permission, focus behavior, unregister support, change support, and macOS/Windows evidence.
- Shortcut readiness: registration is `registered`, conflict is `none`, and permission is `granted`; blocked states require explicit reasons and still fail.
- Shortcut privacy: capture is explicit-input-only and does not implicitly read clipboard, selected text, screen, window title, or foreground app context.
- Native capture handoff: source is `native`, channels include `native:tray` and `native:global-shortcut`, route is `/companies/:companyId/rt2/one-liner/inbound-draft`, and capture creates a reviewed persistent draft without auto-apply or auto-promote.
- Secret hygiene: raw private keys, passwords, provider tokens, and sensitive fields that are not secret references are rejected.

## Push Notification Gate

Phase 63 adds a separate Mobile/Web Push/APNs evidence gate:

```sh
pnpm run rt2:push-notification-gate -- --manifest path/to/push-notification-evidence.json
```

This gate validates the push loop before push notifications can be treated as release-ready. It writes:

```text
.planning/native-push-runs/<timestamp>/
```

Each run writes:

- `summary.json` - machine-readable status, registration/signal/delivery/click counts, reliability metrics, blocker counts, and passed checks
- `report.md` - operator-readable registration, signal, delivery, click, capture reliability, blocker, and passed-check tables

The command returns a non-zero exit code when push loop evidence is incomplete. Required checks include:

- Registrations: company ID, user identity, device ID, provider, platform, registration state, permission evidence, and provider-specific endpoint/token hash.
- Subscription lifecycle: revoked, invalid, expired, failed, or permission-denied registrations must include an explicit reason and block readiness until remediated.
- Signals: only `approval_waiting`, `failed_sync`, and `review_requested` are accepted.
- Payloads: minimal route/event metadata only, with sensitive task content and raw secrets rejected.
- Targets: deep-link to capture draft, work board, or review routes; auto-apply and auto-promote targets are blocked.
- Delivery evidence: provider status, attempt count, timestamp, failure code, retry decision, and invalid-token revocation handling.
- Click-through evidence: notification clicks must reach the original target route.
- Capture reliability: permission denied, token invalid, delivery failure, retry, and click-through metrics must appear in reliability evidence.

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
