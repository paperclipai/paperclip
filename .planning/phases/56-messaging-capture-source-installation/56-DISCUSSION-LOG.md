# Phase 56: Messaging Capture Source Installation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 56-messaging-capture-source-installation
**Areas discussed:** Capture source setup surface, Public messaging inbound and signing, Source metadata and payload normalization, Review and audit evidence, Verification
**Mode:** auto

---

## Capture Source Setup Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse RT2 capture source model | Extend `rt2_capture_sources`, existing source APIs, and One-Liner/daily capture UI for Slack/Teams/webhook setup. | ✓ |
| Build generic plugin settings | Treat messaging capture as a plugin/webhook installation problem first. | |
| Only document API setup | Leave operators with route docs and no setup/health UI. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Existing source records already carry label, install state, signing status, secret hash, last event, last error, and blocked reason. This satisfies MSG-01 with the smallest compatible scope.

---

## Public Messaging Inbound And Signing

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated public RT2 messaging route | Add an external-callable route that resolves/verifies RT2 capture source records and reuses `createInboundDraft`. | ✓ |
| Reuse board-auth inbound route | Require Slack/Teams/webhook callers to act like a signed-in board user. | |
| Route through plugin webhooks | Make plugin webhook delivery own RT2 capture ingestion. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Current authenticated inbound route remains right for first-party UI/PWA/native sends. Messaging systems need a signed public route, with company/source evidence attached to normal capture drafts.

---

## Source Metadata And Payload Normalization

| Option | Description | Selected |
|--------|-------------|----------|
| Normalize into existing draft fields plus redacted source evidence | Map provider payloads to `text`, `channel`, `externalUserId`, `eventId`, `eventTimestamp`, `signature`, and source metadata. | ✓ |
| Store raw provider payloads | Preserve every provider field verbatim for later analysis. | |
| Use only freeform text | Drop provider metadata after extracting the message text. | |

**User's choice:** Auto-selected recommended default.
**Notes:** This preserves review/audit value while avoiding secrets, auth headers, and unnecessary raw payload storage.

---

## Review And Audit Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Compact board evidence chips | Show messaging source, duplicate, authorization/signature, and malformed failure states in the existing board inbox. | ✓ |
| Build a new messaging review page | Create a separate source review workflow outside the daily board. | |
| Defer all UI evidence to Phase 57 | Let operators inspect failures only through logs until reliability reports exist. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Phase 54/55 locked the board capture inbox as the review authority. Phase 56 can add distinguishable failure labels without implementing Phase 57 filters/reports.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Focused shared/server/UI tests plus typecheck | Cover source config, signed inbound, failure evidence, source health, setup UI, and board chips. | ✓ |
| Broad e2e-first verification | Use Playwright/browser flows as the main proof. | |
| Typecheck only | Trust existing source tests and skip new behavior tests. | |

**User's choice:** Auto-selected recommended default.
**Notes:** Repo guidance prefers `pnpm typecheck && pnpm test`, but this host has known broad-suite timeout debt. Focused Vitest plus typecheck is the pragmatic gate.

---

## the agent's Discretion

- Exact public inbound route path.
- Exact setup UI layout and copy.
- Exact metadata field shape, provided audit/review can distinguish provider, event, channel, user, signing, duplicate, authorization, and malformed evidence.

## Deferred Ideas

- Phase 57 review filters, source/status reports, retry metrics, and promotion latency.
- Slack/Teams marketplace OAuth distribution and generic integration marketplace.
- Plugin webhook delivery history as the canonical RT2 capture owner.
