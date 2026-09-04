DELETE FROM "tool_profile_entries" AS "entry"
USING "tool_profiles" AS "profile"
WHERE "entry"."profile_id" = "profile"."id"
  AND "entry"."company_id" = "profile"."company_id"
  AND "entry"."selector_type" = 'connection'
  AND "entry"."effect" = 'include'
  AND "entry"."connection_id" IS NOT NULL
  AND "profile"."profile_key" = 'app:' || "entry"."connection_id"::text
  AND "profile"."metadata" ->> 'source' IN ('app_gallery_finish', 'tool_connection_install')
  AND "profile"."metadata" ->> 'connectionId' = "entry"."connection_id"::text;
