ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint
UPDATE "agents" SET "created_by_user_id" = (
  SELECT "activity_log"."actor_id"
  FROM "activity_log"
  WHERE "activity_log"."entity_type" = 'agent'
    AND "activity_log"."entity_id" = "agents"."id"::text
    AND "activity_log"."company_id" = "agents"."company_id"
    AND "activity_log"."action" IN ('agent.created', 'agent.hire_created')
    AND "activity_log"."actor_type" = 'user'
  ORDER BY "activity_log"."created_at" ASC
  LIMIT 1
)
WHERE "created_by_user_id" IS NULL;
