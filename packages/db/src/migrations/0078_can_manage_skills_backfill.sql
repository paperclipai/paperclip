-- Backfill canManageSkills onto agents that already have canCreateAgents.
-- Existing CEO/admin agents must keep skill-install rights when the
-- assertCanMutateCompanySkills gate is narrowed to canManageSkills.
UPDATE "agents"
SET "permissions" = COALESCE("permissions", '{}'::jsonb) || jsonb_build_object('canManageSkills', true)
WHERE
  COALESCE("permissions"->>'canCreateAgents', 'false') = 'true'
  AND ("permissions" ? 'canManageSkills') = false;
