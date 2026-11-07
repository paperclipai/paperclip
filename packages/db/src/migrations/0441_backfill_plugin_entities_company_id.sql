UPDATE "plugin_entities"
SET "company_id" = "scope_id"::uuid
WHERE "company_id" IS NULL
  AND "scope_kind" = 'company'
  AND "scope_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND "scope_id"::uuid IN (SELECT "id" FROM "companies");
