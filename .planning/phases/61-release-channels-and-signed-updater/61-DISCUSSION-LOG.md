# Phase 61: Release Channels and Signed Updater - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-04-30T20:11:43.0460530+09:00
**Phase:** 61-release-channels-and-signed-updater
**Mode:** auto
**Areas discussed:** Channel feed contract, Signed updater validation, Operator-visible update state, Release and runtime evidence integration

---

## Channel Feed Contract

| Option | Description | Selected |
|--------|-------------|----------|
| Native channel manifests | Create distinct internal/beta/stable native channel metadata with per-platform artifact, checksum, signature, rollout, rollback, and signing prerequisite fields. | selected |
| Reuse npm tags only | Treat npm canary/latest as enough channel truth for native updater decisions. | |
| Defer channel contract | Leave channel shape for the native shell scaffold. | |

**Auto choice:** Native channel manifests.
**Notes:** Existing npm release channels are package publication surfaces, not enough for signed native updater rollout/rollback metadata.

---

## Signed Updater Validation

| Option | Description | Selected |
|--------|-------------|----------|
| Evidence-first gate | Add a deterministic repo-local updater/channel gate with fail-closed validation and durable evidence. | selected |
| Add native dependency first | Create the full Tauri desktop package before validating updater metadata. | |
| Docs only | Document desired feed fields without executable validation. | |

**Auto choice:** Evidence-first gate.
**Notes:** This matches Phase 60 and avoids dependency/lockfile churn until the native package has a narrow reason to exist.

---

## Operator-Visible Update State

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit state model | Record installed/latest build identity, rollout decision, update lifecycle state, rollback candidate, and failure reason in JSON and Markdown evidence. | selected |
| CI logs only | Let operators inspect workflow logs for updater state. | |
| UI first | Build a UI surface before the signed updater contract exists. | |

**Auto choice:** Explicit state model.
**Notes:** Phase 61 can make update state observable through durable evidence first; app/native UI can consume the same vocabulary later.

---

## Release And Runtime Evidence Integration

| Option | Description | Selected |
|--------|-------------|----------|
| Consume Phase 60 signing gate | Require referenced native signing gate evidence before updater/channel metadata can pass. | selected |
| Independent updater gate | Validate updater fields without checking OS signing/trust prerequisite evidence. | |
| Full workflow publishing change | Wire updater publishing into release workflow immediately. | |

**Auto choice:** Consume Phase 60 signing gate.
**Notes:** Phase 61 should not claim a safe update if the underlying artifact signing/trust evidence is missing or blocked.

---

## the agent's Discretion

- Exact manifest filename and JSON field names.
- Exact timestamped evidence directory name.
- Whether first implementation performs full cryptographic signature verification or strict signature/key-reference validation, provided the pass criteria are explicit.
- Whether runtime-confidence aggregation is updated in Phase 61 or left documented for Phase 64 if it would broaden scope.

## Deferred Ideas

- Resident tray/menubar and OS-level shortcut behavior - Phase 62.
- Mobile/Web Push/APNs loop - Phase 63.
- Final all-up distribution gate and v2.9 regression aggregation - Phase 64.
- Public store listing and marketing operations - future store-operations scope.
