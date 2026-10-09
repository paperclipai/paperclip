ALTER TABLE "issue_thread_interactions" ALTER COLUMN "requested_resolver_policy" SET DEFAULT 'anyone';--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "effective_resolver_policy" SET DEFAULT 'anyone';--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "resolver_policy_provenance" text;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "effective_resolver_policy_source" text;--> statement-breakpoint
-- Existing rows predate provenance, so their explicit-vs-default origin cannot
-- be proven. Preserve the old creator-excluding board_or_agents behavior as
-- not_creator and the old board_only behavior as human_only. This deliberately
-- avoids widening any ambiguous pending card during migration.
UPDATE "issue_thread_interactions"
SET
  "requested_resolver_policy" = CASE "requested_resolver_policy"
    WHEN 'board_or_agents' THEN 'not_creator'
    WHEN 'board_only' THEN 'human_only'
    ELSE "requested_resolver_policy"
  END,
  "effective_resolver_policy" = CASE "effective_resolver_policy"
    WHEN 'board_or_agents' THEN 'not_creator'
    WHEN 'board_only' THEN 'human_only'
    ELSE "effective_resolver_policy"
  END,
  "resolver_policy_provenance" = COALESCE(
    "resolver_policy_provenance",
    'legacy_inherited_restriction'
  ),
  "effective_resolver_policy_source" = COALESCE(
    "effective_resolver_policy_source",
    CASE
      WHEN "kind" = 'request_confirmation' AND "payload" ? 'toolAction' THEN 'governed_action'
      WHEN "effective_resolver_policy" IS DISTINCT FROM "requested_resolver_policy" THEN 'company_cap'
      ELSE 'requested'
    END
  )
WHERE "resolver_policy_provenance" IS NULL
   OR "effective_resolver_policy_source" IS NULL;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "resolver_policy_provenance" SET DEFAULT 'inherited';--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "resolver_policy_provenance" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "effective_resolver_policy_source" SET DEFAULT 'requested';--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ALTER COLUMN "effective_resolver_policy_source" SET NOT NULL;
