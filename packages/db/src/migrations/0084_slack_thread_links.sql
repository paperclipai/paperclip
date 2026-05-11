CREATE TABLE IF NOT EXISTS "slack_thread_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_ts" text NOT NULL,
	"channel_id" text NOT NULL,
	"paperclip_resource_type" text NOT NULL,
	"paperclip_resource_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_thread_links_thread_channel_idx"
	ON "slack_thread_links" USING btree ("thread_ts","channel_id");
