# Governance Risks Register

Active and mitigated risks to Paperclip platform governance, institutional integrity, and operational safety.

---

## Mitigated Risks

### GR-001: Review state lost on bridge resync (MITIGATED — PR #5, 2026-05-12)

- **Severity:** Critical
- **Category:** Data integrity / institutional memory
- **Root cause:** Bridge-file refresh overwrote DB-backed review decisions. Approve/deny actions were silently discarded every scan cycle.
- **Fix:** Fingerprint-based upsert in `syncFindings()` preserves `review_state` and `review_decision`. Occurrence count increments; decisions are never overwritten.
- **Verification:** End-to-end test confirmed deny persists across sync cycles, active filter excludes denied findings, `X-QSL-Source: database` confirmed on refresh.

---

## Active Risks

### GR-002: Liveness/deadlock detection gaps

- **Severity:** High
- **Category:** Operational continuity
- **Description:** Run liveness classification (`server/src/services/run-liveness.ts`) uses evidence-based heuristics with hardcoded thresholds (`ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 1h`, `CRITICAL_THRESHOLD_MS = 4h`). Continuation attempts are capped at `DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS = 2`. However:
  - Stale active runs with no evidence output may not be detected until the 1-hour suspicion threshold.
  - Issue-graph liveness auto-recovery requires 24h of staleness (`ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_MIN_STALE_MS`).
  - No alerting mechanism beyond log output; relies on heartbeat recovery at startup.
- **Recommended action:** Audit liveness thresholds, add proactive alerting for stuck runs, validate continuation-loop guards under edge cases.

### GR-003: Data confidence classification not implemented

- **Severity:** Medium
- **Category:** Decision quality
- **Description:** QSL findings carry `risk_score` from scan output but no confidence classification on the data itself. There is no distinction between high-confidence findings (verified by multiple scan passes) and low-confidence findings (single observation, no corroboration). TrustScore testing revealed this as a gap for governance reporting.
- **Recommended action:** Add `confidence_level` field to `qsl_findings` schema. Classify based on `occurrence_count`, scan source diversity, and time-span between `first_seen` and `last_seen`.

### GR-004: Continuation-loop prevention relies on attempt cap only

- **Severity:** Medium
- **Category:** Operational safety
- **Description:** `decideRunLivenessContinuation()` uses a max-attempt guard (`DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS = 2`) and idempotency keys to prevent unbounded retries. However, the loop-prevention is purely count-based — it does not detect semantic repetition (same error, same empty output pattern). A failing agent could exhaust attempts producing no useful work.
- **Recommended action:** Add output-similarity detection to continuation decisions. If consecutive runs produce identical error signatures, skip rather than retry.

### GR-005: Backup/recovery not validated end-to-end

- **Severity:** Medium
- **Category:** Disaster recovery
- **Description:** Automatic DB backups are enabled (60-minute interval, 30-day retention) via embedded PostgreSQL. Restore path exists in `server/src/services/recovery/` but has not been validated with the new `qsl_findings` table. Review state durability depends on backup integrity.
- **Recommended action:** Run a restore-from-backup test including QSL findings table. Validate that review decisions survive backup/restore cycle.

### GR-006: Provider routing changes premature without liveness hardening

- **Severity:** High
- **Category:** Sequencing / dependency
- **Description:** Provider routing changes touch the adapter registry, sandbox runtime, and workspace operations — all of which depend on healthy liveness detection and recovery. Modifying routing before liveness/deadlock hardening risks introducing stuck-state scenarios that current detection cannot catch.
- **Recommended action:** Complete liveness/deadlock hardening (GR-002) before any provider routing work. Hardening order: `persistence (done) → liveness/deadlock → data confidence → backup/recovery → provider routing`.
