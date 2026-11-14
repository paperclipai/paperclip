CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_agent_client_request_uq"
  ON "issue_comments" ("issue_id", "author_agent_id", "client_request_id");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'issue_comments_agent_client_request_uq'
      AND conrelid = 'issue_comments'::regclass
  ) THEN
    INSERT INTO "issue_read_states" ("company_id", "issue_id", "user_id", "last_read_at")
    SELECT i."company_id", i."id", i."conversation_user_id", max(c."created_at")
    FROM "issues" i
    JOIN "issue_comments" c ON c."company_id" = i."company_id" AND c."issue_id" = i."id"
    WHERE i."conversation_agent_id" IS NOT NULL AND i."conversation_user_id" IS NOT NULL
      AND c."deleted_at" IS NULL AND c."author_agent_id" IS NOT NULL
      AND c."author_type" IS DISTINCT FROM 'system'
      AND c."presentation" ->> 'kind' IS DISTINCT FROM 'system_notice'
      AND c."origin" = 'comment'
    GROUP BY i."company_id", i."id", i."conversation_user_id"
    ON CONFLICT ("company_id", "issue_id", "user_id") DO NOTHING;
    ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_agent_client_request_uq"
      UNIQUE USING INDEX "issue_comments_agent_client_request_uq";
  END IF;
END $$;
