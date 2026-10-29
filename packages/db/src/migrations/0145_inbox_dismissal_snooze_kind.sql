ALTER TABLE "inbox_dismissals" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
UPDATE "inbox_dismissals" SET "kind" = 'dismiss' WHERE "kind" IS NULL;--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ALTER COLUMN "kind" SET DEFAULT 'dismiss';--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_kind_check" CHECK ("kind" IN ('dismiss', 'snooze'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_kind_snooze_until_check" CHECK (("kind" = 'dismiss' AND "snoozed_until" IS NULL) OR ("kind" = 'snooze' AND "snoozed_until" IS NOT NULL));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
