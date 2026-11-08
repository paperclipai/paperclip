UPDATE "plugin_entities" AS "target"
SET
  "title" = CASE
    WHEN "source"."updated_at" > "target"."updated_at" THEN COALESCE("source"."title", "target"."title")
    ELSE COALESCE("target"."title", "source"."title")
  END,
  "status" = CASE
    WHEN "source"."updated_at" > "target"."updated_at" THEN COALESCE("source"."status", "target"."status")
    ELSE COALESCE("target"."status", "source"."status")
  END,
  "data" = (
    CASE
      WHEN "source"."updated_at" > "target"."updated_at" THEN "target"."data" || "source"."data"
      ELSE "source"."data" || "target"."data"
    END
  )
  || CASE
    WHEN ("target"."data"->>'paperclipIssueId') IS NULL AND ("source"."data"->>'paperclipIssueId') IS NOT NULL
      THEN jsonb_build_object('paperclipIssueId', "source"."data"->'paperclipIssueId')
    ELSE '{}'::jsonb
  END
  || CASE
    WHEN ("target"."data"->>'clientExternalId') IS NULL AND ("source"."data"->>'clientExternalId') IS NOT NULL
      THEN jsonb_build_object('clientExternalId', "source"."data"->'clientExternalId')
    ELSE '{}'::jsonb
  END,
  "created_at" = LEAST("target"."created_at", "source"."created_at"),
  "updated_at" = GREATEST("target"."updated_at", "source"."updated_at")
FROM "plugin_entities" AS "source"
WHERE "source"."company_id" IS NULL
  AND "source"."scope_kind" = 'company'
  AND "source"."scope_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND "target"."company_id" = "source"."scope_id"::uuid
  AND "target"."plugin_id" = "source"."plugin_id"
  AND "target"."entity_type" = "source"."entity_type"
  AND "target"."external_id" IS NOT DISTINCT FROM "source"."external_id";
--> statement-breakpoint
DELETE FROM "plugin_entities" AS "source"
USING "plugin_entities" AS "target"
WHERE "source"."company_id" IS NULL
  AND "source"."scope_kind" = 'company'
  AND "source"."scope_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND "target"."company_id" = "source"."scope_id"::uuid
  AND "target"."plugin_id" = "source"."plugin_id"
  AND "target"."entity_type" = "source"."entity_type"
  AND "target"."external_id" IS NOT DISTINCT FROM "source"."external_id";
--> statement-breakpoint
UPDATE "plugin_entities"
SET "company_id" = "scope_id"::uuid
WHERE "company_id" IS NULL
  AND "scope_kind" = 'company'
  AND "scope_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND "scope_id"::uuid IN (SELECT "id" FROM "companies");
