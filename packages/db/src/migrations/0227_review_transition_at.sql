ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "review_transition_at" timestamp with time zone;--> statement-breakpoint
-- Backfill only the rows the classifier can actually read: an issue sitting in review
-- right now needs a clock, or it stays exempt from staleness until its next transition —
-- which for a stranded issue is exactly the transition that never comes. `updated_at` is
-- the most recent moment we can defend as "review was still moving", so it starts there.
UPDATE "issues" SET "review_transition_at" = "updated_at" WHERE "status" = 'in_review' AND "review_transition_at" IS NULL;
