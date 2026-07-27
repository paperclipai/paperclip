ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "review_acceptance_kind" text;
--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "review_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "same_fingerprint_review_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'issue_watchdogs_review_acceptance_kind_check'
      AND conrelid = 'issue_watchdogs'::regclass
  ) THEN
    ALTER TABLE "issue_watchdogs"
      ADD CONSTRAINT "issue_watchdogs_review_acceptance_kind_check"
      CHECK ("review_acceptance_kind" IS NULL OR "review_acceptance_kind" IN ('terminal', 'conditional'));
  END IF;
END $$;
