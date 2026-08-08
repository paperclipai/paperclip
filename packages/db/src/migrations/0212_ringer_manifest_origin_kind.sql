-- Migration: ringer_manifest_origin_kind
-- Adds a unique index for active ringer_manifest issues to support 1:1 tracking
-- between Ringer swarm manifests and Paperclip issues.

CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_ringer_manifest_uq"
ON "issues" USING btree ("company_id","origin_kind","origin_id")
WHERE (origin_kind = 'ringer_manifest'
  AND origin_id IS NOT NULL
  AND hidden_at IS NULL
  AND status NOT IN ('done', 'cancelled'));
