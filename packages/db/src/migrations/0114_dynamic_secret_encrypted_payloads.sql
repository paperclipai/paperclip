ALTER TABLE "company_secret_bindings"
  ADD COLUMN IF NOT EXISTS "static_argv_material" jsonb;

-- The previous experimental implementation stored host command paths and
-- operator-fixed argv in plaintext JSONB. Existing payloads cannot be safely
-- re-encrypted in SQL because the local encryption key is intentionally outside
-- the database, so remove plaintext-at-rest values. New writes store encrypted
-- material and leave only redacted summaries in these metadata columns.
UPDATE "company_secrets"
SET "dynamic_command" = jsonb_build_object(
  'provider', COALESCE("dynamic_command"->>'provider', 'host-command'),
  'command', '***REDACTED***',
  'ttlSeconds', COALESCE(NULLIF("dynamic_command"->>'ttlSeconds', '')::int, 300)
)
WHERE "managed_mode" = 'dynamic_command'
  AND "dynamic_command" IS NOT NULL;

UPDATE "company_secret_bindings"
SET "static_argv" = '[]'::jsonb
WHERE jsonb_typeof("static_argv") = 'array'
  AND jsonb_array_length("static_argv") > 0;
