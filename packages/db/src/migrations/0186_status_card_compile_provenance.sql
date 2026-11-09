ALTER TABLE "status_card_updates" ADD COLUMN IF NOT EXISTS "query_version" integer;
--> statement-breakpoint
ALTER TABLE "status_card_updates" ADD COLUMN IF NOT EXISTS "change_summary" text;
