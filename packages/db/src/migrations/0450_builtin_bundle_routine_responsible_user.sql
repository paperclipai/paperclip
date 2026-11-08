UPDATE "routines" AS "routine"
SET "responsible_user_id" = "resolved"."user_id"
FROM (
  SELECT "company"."id" AS "company_id",
    coalesce(
      "company"."default_responsible_user_id",
      (
        SELECT "membership"."principal_id" FROM "company_memberships" AS "membership"
        WHERE "membership"."company_id" = "company"."id"
          AND "membership"."principal_type" = 'user'
          AND "membership"."status" = 'active'
          AND "membership"."membership_role" = 'owner'
        ORDER BY "membership"."created_at", "membership"."id"
        LIMIT 1
      )
    ) AS "user_id"
  FROM "companies" AS "company"
) AS "resolved"
WHERE "routine"."company_id" = "resolved"."company_id"
  AND "routine"."responsible_user_id" = 'built-in-bundles'
  AND "resolved"."user_id" IS NOT NULL
  AND "resolved"."user_id" <> 'built-in-bundles';--> statement-breakpoint
UPDATE "routine_revisions" AS "revision"
SET "responsible_user_id" = "routine"."responsible_user_id",
  "snapshot" = jsonb_set(
    "revision"."snapshot",
    '{routine,responsibleUserId}',
    to_jsonb("routine"."responsible_user_id")
  )
FROM "routines" AS "routine"
WHERE "routine"."id" = "revision"."routine_id"
  AND "revision"."responsible_user_id" = 'built-in-bundles'
  AND "routine"."responsible_user_id" <> 'built-in-bundles'
  AND "routine"."responsible_user_id" IS NOT NULL;
