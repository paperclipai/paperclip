ALTER TABLE "mcp_oauth_tokens" ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint
-- Active Dot connections keep working without another consent flow. Expired
-- or consumed credentials stay invalid, revoked grants stay revoked, and
-- personal assistant connections retain their expiry.
UPDATE "mcp_oauth_tokens" AS tokens
SET "expires_at" = NULL
FROM "mcp_oauth_grants" AS grants
WHERE tokens."grant_id" = grants."id"
  AND tokens."kind" = 'refresh'
  AND tokens."used_at" IS NULL
  AND tokens."expires_at" > now()
  AND grants."purpose" = 'agent'
  AND grants."resource" LIKE '%/mcp/runner'
  AND grants."revoked_at" IS NULL;
