UPDATE "agents" AS a
SET
  "status" = 'paused',
  "pause_reason" = 'company_archived',
  "paused_at" = now(),
  "updated_at" = now()
FROM "companies" AS c
WHERE c."id" = a."company_id"
  AND c."status" = 'archived'
  AND a."status" NOT IN ('paused', 'terminated', 'pending_approval');
