-- Preserve permission grant revocations across migration re-runs and backup
-- restores by switching `principal_permission_grants` from hard-delete to
-- audit-preserving soft-delete.
--
-- Motivation:
--   Migration 0091_grant_tasks_view_all_default (and any future default-grant
--   backfill) re-applies the same INSERT ... ON CONFLICT DO NOTHING SQL each
--   time it lands under a new tag (rebase, multi-tenant cloud bootstrap,
--   backup restore). If an admin had previously DELETE'd a row to revoke
--   the grant, the re-run quietly re-creates it because the unique index
--   on (company_id, principal_type, principal_id, permission_key) no longer
--   matches anything to conflict against. The revoke is silently lost.
--
-- Fix:
--   - Add `revoked_at` / `revoked_by_user_id` columns mirroring the existing
--     `invites.revokedAt` pattern in the schema (this is an established
--     Paperclip soft-delete convention, not a new invention).
--   - Replace the unconditional UNIQUE index with a partial UNIQUE that
--     covers only active (revoked_at IS NULL) rows. Tombstone rows live
--     forever as audit trail and never block a re-grant.
--   - Backfill (separate migration) becomes `WHERE NOT EXISTS (...)` so
--     it skips when EITHER an active or a tombstoned row already exists
--     for the same (company, principal, key) — preserving the admin's
--     revocation through every subsequent re-run.

ALTER TABLE "principal_permission_grants"
  ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;

ALTER TABLE "principal_permission_grants"
  ADD COLUMN IF NOT EXISTS "revoked_by_user_id" text;

DROP INDEX IF EXISTS "principal_permission_grants_unique_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "principal_permission_grants_active_unique_idx"
  ON "principal_permission_grants"
  ("company_id", "principal_type", "principal_id", "permission_key")
  WHERE "revoked_at" IS NULL;
