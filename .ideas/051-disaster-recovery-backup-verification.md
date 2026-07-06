# 051 — Disaster Recovery: Backup Verification & Restore Drills

## Suggestion

Paperclip can take instance database backups (`routes/instance-database-backups.ts`), but a code
scan finds **no verification, restore-testing, or DR posture** around them — no checksum/integrity
check, no automated restore drill, no RPO/RTO concept. An untested backup is a hope, not a
guarantee: the classic ops failure is discovering at the worst possible moment that backups were
corrupt, incomplete, or never actually restorable. For a system that is the **system-of-record for
autonomous companies** — holding org structure, financials, work history, and audit trails — a
silently-broken backup means losing the entire operating state of one or many businesses.

Add **backup verification and restore drills**: continuously prove that backups exist, are intact,
and can actually be restored, and give operators a clear recovery posture.

## How it could be achieved

1. **Integrity on write.** When a backup is created, record a checksum/size/row-count manifest and
   verify the artifact in the storage layer (`server/src/storage/`) immediately after upload —
   catch truncated/corrupt backups at creation, not at recovery.
2. **Automated restore drills.** On a routine (`routines.ts`), restore the latest backup into an
   ephemeral throwaway database (the dev PGlite path or a temp PG instance) and run smoke checks
   (schema present, key tables non-empty, referential sanity). A backup that fails a drill raises a
   high-severity alert — this is the single highest-value piece.
3. **Recovery posture surface.** Show operators the facts that matter: last successful backup, last
   *verified-restorable* backup, effective RPO (data-loss window) and a measured RTO (how long the
   last drill took to restore). Replace "we have backups" with "we can recover to within N minutes,
   proven M hours ago."
4. **Policy & retention.** Configurable backup frequency and retention, integrated with data-
   retention governance (idea 034), plus optional off-instance/off-site copy via the storage
   provider abstraction (S3) for true disaster isolation.
5. **One-button guided restore.** A documented, guided restore flow (with confirmation + Drain,
   idea 014) so recovery isn't an improvised, error-prone scramble under pressure.

## Perceived complexity

**Medium.** Backup creation and a storage abstraction already exist, so integrity manifests are a
small add. The substantive work is the **automated restore drill** — standing up a throwaway DB,
restoring into it, and smoke-testing — which is the part that turns backups from theoretical to
trustworthy and is worth doing first. Cross-engine nuance (PGlite dev vs real Postgres prod) and
making drills cheap enough to run regularly are the main practical hurdles. Distinct from company
point-in-time rewind (idea 015), which is a *logical* per-company undo; this is *infrastructure*
DR for the whole instance.
