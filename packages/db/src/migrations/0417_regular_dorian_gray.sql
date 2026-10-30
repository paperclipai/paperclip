DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'issue_comments_agent_client_request_uq'
      AND conrelid = 'issue_comments'::regclass
  ) THEN
    ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_agent_client_request_uq"
      UNIQUE("issue_id", "author_agent_id", "client_request_id");
  END IF;
END $$;
