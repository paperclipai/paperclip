ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "rate_limit_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "companies"
SET "rate_limit_settings" = jsonb_build_object(
  'issueCreation',
  jsonb_build_object(
    'enabled', true,
    'windowMinutes', 10,
    'maxIssuesPerWindow', 30,
    'exemptAgentIds', '[]'::jsonb,
    'exemptAgentRoles', '[]'::jsonb
  )
)
WHERE NOT ("rate_limit_settings" ? 'issueCreation');
