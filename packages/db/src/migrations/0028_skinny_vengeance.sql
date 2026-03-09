CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel_type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"event_filter" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_channels_company_enabled_idx" ON "notification_channels" USING btree ("company_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_company_name_idx" ON "notification_channels" USING btree ("company_id","name");