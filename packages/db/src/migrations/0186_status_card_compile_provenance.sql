ALTER TABLE "status_card_updates" ADD COLUMN "query_version" integer;
--> statement-breakpoint
ALTER TABLE "status_card_updates" ADD COLUMN "change_summary" text;
