ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "telegram_chat_id" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "telegram_user_id" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "telegram_username" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user" ADD CONSTRAINT "user_telegram_chat_id_unique" UNIQUE ("telegram_chat_id");
EXCEPTION
 WHEN duplicate_object THEN null;
 WHEN duplicate_table THEN null;
END $$;
