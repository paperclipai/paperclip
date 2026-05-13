# Architecture Changelog

Records significant architectural decisions and transitions in the Paperclip platform.

---

## 2026-05-12 — QSL Review Persistence (PR #5)

**Transition:** File-based bridge state → DB-backed persistent review state

### What changed

- **New DB table:** `qsl_findings` (migration 0071, 0072) stores all QSL scan findings with full review lifecycle.
- **New service:** `server/src/services/qsl-review.ts` — sync, dedup, review, state-machine for findings.
- **Refactored routes:** `server/src/routes/qsl-bridge.ts` — company-scoped endpoints with DB-first strategy and bridge fallback.
- **UI updated:** `ui/src/pages/QslReview.tsx` and `ui/src/api/qsl.ts` — API-driven review workflow replaces client-only state.
- **Migration 0072:** Renamed legacy "acknowledged" state to "approved" for consistency.

### Root cause of original bug

Bridge-file refresh was overwriting DB-backed review state. When findings were re-synced from `issues.json`, the sync logic replaced review decisions (approve/deny) with fresh "new" state. Human review decisions were lost on every scan cycle.

### Fix

- `syncFindings()` now uses fingerprint-based upsert: existing findings update `last_seen` and `occurrence_count` but **never overwrite** `review_state` or `review_decision`.
- Recurring findings transition from `new` → `recurring` without resetting decisions.
- Review history is append-only JSONB, capturing `previous_state`, `previous_decision`, reviewer, notes, timestamp.

### Key architectural principles established

1. **Human review decisions are durable institutional state.** Bridge sync must not overwrite them.
2. **API-level validation is authoritative.** Browser-only validation proved unreliable during debugging; server validates all state transitions.
3. **Fallback hierarchy:** `database` → `bridge_error_fallback` → `bridge` → `empty`. Source is exposed via `X-QSL-Source` header.
4. **Deduplication by fingerprint:** SHA256 of `title + threat_category + severity` prevents duplicate rows across scan cycles.

### Hardening order established

```
persistence → liveness/deadlock → data confidence → backup/recovery → provider routing
```

This order was validated by TrustScore testing which revealed that data confidence classification, deadlock/liveness handling, and continuation-loop prevention are prerequisites for safe provider routing changes.
