CREATE TABLE "channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issue_id" uuid,
	"agent_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_messages_direction_check" CHECK ("channel_messages"."direction" IN ('outbound','inbound')),
	CONSTRAINT "channel_messages_status_check" CHECK ("channel_messages"."status" IN ('pending','delivered','failed','received'))
);
--> statement-breakpoint
CREATE TABLE "channel_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"filter" jsonb,
	"template" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_platform_check" CHECK ("channels"."platform" IN ('slack','discord','telegram','email','webhook')),
	CONSTRAINT "channels_status_check" CHECK ("channels"."status" IN ('active','disconnected','error')),
	CONSTRAINT "channels_direction_check" CHECK ("channels"."direction" IN ('outbound','inbound','bidirectional'))
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_routes" ADD CONSTRAINT "channel_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_routes" ADD CONSTRAINT "channel_routes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_messages_company_created_idx" ON "channel_messages" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "channel_messages_channel_created_idx" ON "channel_messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "channel_messages_issue_idx" ON "channel_messages" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "channel_routes_company_channel_idx" ON "channel_routes" USING btree ("company_id","channel_id");--> statement-breakpoint
CREATE INDEX "channels_company_idx" ON "channels" USING btree ("company_id","created_at");