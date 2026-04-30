# Phase 55: Native and Mobile Quick Capture Entry - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 55-native-and-mobile-quick-capture-entry
**Areas discussed:** Entry channel boundary, Local queue and retry, Connection and auth state, Draft review handoff, PWA identity and navigation, Verification
**Mode:** auto

---

## Entry Channel Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| PWA/mobile quick entry first | Build an installable/mobile-friendly quick-capture route and launcher surface. | ✓ |
| Full native tray binary | Build resident OS tray/app-store-level native packaging now. | |
| Reuse only existing floating modal | Keep quick capture only as the current in-app floating modal. | |

**User's choice:** Auto-selected recommended default: PWA/mobile quick entry first.
**Notes:** Full native distribution is explicitly deferred in `.planning/PROJECT.md` and `.planning/REQUIREMENTS.md`. Phase 55 should satisfy quick entry and local queue reliability without implying app-store/tray packaging is done.

---

## Local Queue And Retry

| Option | Description | Selected |
|--------|-------------|----------|
| Bounded local browser queue | Store a capped, validated local queue and retry in the foreground/manual flow. | ✓ |
| IndexedDB plus background sync | Use heavier browser offline primitives and Background Sync. | |
| Server-side retry queue only | Require the server before anything is queued. | |

**User's choice:** Auto-selected recommended default: bounded local browser queue.
**Notes:** Existing UI already uses guarded `localStorage` for small persisted state. Background sync and larger offline storage are future hardening if this outgrows lightweight capture.

---

## Connection And Auth State

| Option | Description | Selected |
|--------|-------------|----------|
| Local save with send blocked until connected | Allow local device draft saving, but require auth/company/project before API send. | ✓ |
| Hard block all input | Prevent typing until all connection context is valid. | |
| Anonymous server draft | Allow unauthenticated server-side drafts. | |

**User's choice:** Auto-selected recommended default: local save with send blocked until connected.
**Notes:** This preserves operator speed while maintaining company boundary and approval/audit safety.

---

## Draft Review Handoff

| Option | Description | Selected |
|--------|-------------|----------|
| Existing inbound draft review flow | Submit through `createInboundDraft` and board review inbox. | ✓ |
| Direct board card creation | Create a daily board card without review. | |
| Separate mobile queue API | Build a new server queue distinct from capture drafts. | |

**User's choice:** Auto-selected recommended default: existing inbound draft review flow.
**Notes:** Phase 54 already made capture drafts and revisions durable. Phase 55 should feed that system, not bypass it.

---

## PWA Identity And Navigation

| Option | Description | Selected |
|--------|-------------|----------|
| RealTycoon2 PWA shortcut and route | Add RealTycoon2-branded manifest/shortcut and quick route. | ✓ |
| No manifest changes | Leave install identity as-is. | |
| Wait for full native distribution | Do not expose install/shortcut entry yet. | |

**User's choice:** Auto-selected recommended default: RealTycoon2 PWA shortcut and route.
**Notes:** `site.webmanifest` currently says Paperclip, which becomes product-facing when Phase 55 introduces PWA/mobile entry.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Focused tests plus typecheck | Cover queue utility, quick route UI, source/event handoff, identity gate, and typecheck. | ✓ |
| Broad e2e only | Rely primarily on browser e2e. | |
| Manual verification only | No focused automated coverage. | |

**User's choice:** Auto-selected recommended default: focused tests plus typecheck.
**Notes:** Broad `pnpm test` remains subject to the known Windows host timeout; focused tests and typecheck are required.

---

## the agent's Discretion

- Exact route path and component decomposition.
- Exact bounded queue storage key and parse guard implementation.
- Exact retry timing and last-sync copy, provided state remains visible and Korean-first.

## Deferred Ideas

- Full app-store signing/updater/notarization and resident OS tray app.
- Slack/Teams/webhook source installation and signed inbound setup.
- Review operations filters, source reliability report, and promotion latency aggregation.
- Background push notifications and production mobile push.
