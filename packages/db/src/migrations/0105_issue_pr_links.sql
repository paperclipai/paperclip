ALTER TABLE "issues" ADD COLUMN "pr_links" jsonb DEFAULT '[]'::jsonb NOT NULL;
