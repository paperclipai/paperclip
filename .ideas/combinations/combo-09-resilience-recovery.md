# Combo 09 — Resilience, Disaster Recovery & Incident Response

**Combines:** 015 Company Point-in-Time Rewind · 051 DR: Backup Verification & Restore Drills ·
057 Incident Management & On-Call · 045 Plugin Versioning, Rollback & Health
· (uses 014 Drain from combo 01)

## The unified idea

A system that runs real businesses 24/7 without a human watching needs a coherent answer to "when
something breaks, how do we recover safely?" Today the pieces are absent or thin: backups exist but
are never verified, there's no per-company undo, no operational incident concept (only internal
budget incidents), and plugin upgrades can wedge a running company at 2am with no rollback. Four
ideas combine into one **resilience stack** spanning three blast radii — a single company, the whole
instance, and the live operation — all sharing the same safe-action discipline.

- **Per-company undo (015).** Lightweight point-in-time snapshots (reusing `company-portability.ts`'s
  serializer) + checkpoints before high-risk events (a CEO re-plan, bulk mutations), with a diff
  before restore and a non-destructive "restore into a new company" fork. Honestly scoped: restores
  *control-plane* state, not the outside world.
- **Trustworthy infra DR (051).** Integrity manifests on backup write, **automated restore drills**
  into a throwaway DB on a routine (the single highest-value piece — an untested backup is a hope),
  and a recovery-posture surface: last *verified-restorable* backup, measured RPO/RTO, off-site copy.
  Distinct from 015 (logical per-company undo); this is instance-wide infrastructure DR.
- **Real incident response (057).** Generalize the existing budget-incident notion into a first-class
  incident `{ severity, source, responder, timeline, relatedIssues }` that can be raised manually or
  **auto-raised** by existing signals — budget hard-stops, reliability-SLO burn (combo 03/07),
  security alerts (combo 08), deadlocks (combo 03). On-call routing pages a designated responder
  *immediately*, bypassing normal heartbeat/concurrency queues; runbooks attach procedures; SEV1 can
  auto-trigger Drain (014); postmortems feed the learnings ledger (combo 11).
- **Safe plugin lifecycle (045).** Version pinning + history, staged upgrade behind a health gate with
  **automatic rollback** on failure, continuous worker/host-service health monitoring with blast-
  radius containment — the plugin analog of agent reliability SLOs.

## Why combining wins

All four are "detect a failure → contain it → recover to a known-good state," and they share the same
primitives: the snapshot/serializer (015 ↔ 052 reorg revert ↔ 057 postmortem capture), the storage
layer (015/051), the Drain control (014) as the safe-action prelude to any heavyweight recovery, and
the incident model (057) as the common *escalation* destination for failures the rest of the system
detects. Build them together and recovery is one consistent, audited discipline; build them apart and
you get four improvised "oh no" paths.

## Phasing

1. Backup integrity manifests + automated restore drills + recovery-posture surface (051) — highest
   assurance for least effort.
2. Incident object + severity + on-call routing, manual raise (057); plugin pinning + manual rollback
   + health status (045).
3. Company snapshots + fork-restore (015, safe before destructive in-place rewind).
4. Auto-raised incidents from existing signals + SEV1 auto-Drain (057); staged auto-upgrade/rollback (045).

## Ratings

- **Difficulty:** Medium–High — restore is the hard part everywhere (transactional integrity, in-flight
  runs, external side effects that can't be un-done), cross-engine nuance (PGlite dev vs Postgres prod),
  stateful-plugin rollback (migrated schema), and a genuine fast-path that bypasses scheduling.
- **Estimated time to complete:** ~5–7 engineer-weeks.
- **Importance:** 7/10 — mostly insurance, but the cost of *not* having it (a silently-corrupt backup
  losing an entire company's operating state) is catastrophic; restore drills (051) alone are high-ROI.
