ALTER TABLE "issues" ADD COLUMN "wake_policy" jsonb;
--> statement-breakpoint
COMMENT ON COLUMN "issues"."wake_policy" IS 'Per-issue wake opt-out policy. { suppressChildrenCompleted: true } suppresses children_completed wakes for long-lived standing issues.';
