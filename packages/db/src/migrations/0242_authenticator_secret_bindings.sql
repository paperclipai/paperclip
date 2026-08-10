INSERT INTO "company_secret_bindings" (
  "company_id",
  "secret_id",
  "target_type",
  "target_id",
  "config_path",
  "version_selector",
  "required",
  "label"
)
SELECT
  authenticator."company_id",
  authenticator."secret_id",
  'agent',
  assignment."agent_id"::text,
  'authenticators.' || authenticator."id"::text || '.code',
  'latest',
  true,
  authenticator."name"
FROM "company_authenticator_agents" assignment
JOIN "company_authenticators" authenticator
  ON authenticator."id" = assignment."authenticator_id"
ON CONFLICT ("company_id", "target_type", "target_id", "config_path")
DO UPDATE SET
  "secret_id" = excluded."secret_id",
  "version_selector" = excluded."version_selector",
  "required" = excluded."required",
  "label" = excluded."label",
  "updated_at" = now();
