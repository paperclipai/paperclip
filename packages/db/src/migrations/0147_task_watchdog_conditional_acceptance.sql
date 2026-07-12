ALTER TABLE "issue_watchdogs" ADD COLUMN "review_acceptance_kind" text;
--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "review_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "same_fingerprint_review_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_review_acceptance_kind_check" CHECK ("review_acceptance_kind" is null or "review_acceptance_kind" in ('terminal', 'conditional'));
