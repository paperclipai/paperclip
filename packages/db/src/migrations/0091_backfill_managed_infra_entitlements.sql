-- Seed default ValAdrien Cloud entitlements for managed companies created
-- before migration 0090 (e.g. ValAdrien.DEV). Idempotent via ON CONFLICT.
INSERT INTO "company_infra_entitlements" (
  "company_id",
  "capability",
  "mode",
  "status"
)
SELECT
  companies."id",
  defaults."capability",
  defaults."mode",
  'entitled'
FROM "companies"
CROSS JOIN (
  VALUES
    ('postgres', 'managed_shared'),
    ('email', 'managed_shared'),
    ('llm', 'managed_shared'),
    ('hosting', 'managed_dedicated'),
    ('worker', 'managed_shared')
) AS defaults("capability", "mode")
WHERE companies."infra_mode" = 'managed'
ON CONFLICT ("company_id", "capability") DO NOTHING;
