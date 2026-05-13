ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "rate_limit_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
-- The `governanceAssigneeAgentId` here is the CTO agent id for the current
-- single-company instance (per ADR-008 §2.3.3, the breach alert MUST land on
-- CTO so the heartbeat fires). Hard-coded today; multi-company resolution is a
-- follow-up ADR. If this key is missing the route falls back to a `backlog` +
-- unassigned alert and the guard wake path silently breaks — see
-- `parseIssueCreateRateLimitConfig` + `createAlertIssue` for the failure mode.
UPDATE "companies"
SET "rate_limit_settings" = jsonb_build_object(
  'issueCreation',
  jsonb_build_object(
    'enabled', true,
    'windowMinutes', 10,
    'maxIssuesPerWindow', 30,
    'exemptAgentIds', '[]'::jsonb,
    'exemptAgentRoles', '[]'::jsonb,
    'governanceAssigneeAgentId', '2fe5c471-69e3-4593-b2d8-e58f229d9812'
  )
)
WHERE NOT ("rate_limit_settings" ? 'issueCreation');
