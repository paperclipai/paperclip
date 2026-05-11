CREATE TABLE IF NOT EXISTS "slack_thread_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"thread_ts" text NOT NULL,
	"channel_id" text NOT NULL,
	"paperclip_resource_type" text NOT NULL,
	"paperclip_resource_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_thread_links_company_id_companies_id_fk') THEN
		ALTER TABLE "slack_thread_links" ADD CONSTRAINT "slack_thread_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_thread_links_company_idx"
	ON "slack_thread_links" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_thread_links_company_thread_channel_idx"
	ON "slack_thread_links" USING btree ("company_id","thread_ts","channel_id");
