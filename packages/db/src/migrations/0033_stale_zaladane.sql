CREATE TABLE "event_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid,
	"source" text DEFAULT 'webhook' NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cooldown_sec" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"provider" text DEFAULT 'generic' NOT NULL,
	"secret" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"event_count" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid,
	"matched_rule_id" uuid,
	"source" text DEFAULT 'webhook' NOT NULL,
	"provider" text DEFAULT 'generic' NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"headers" jsonb,
	"result_action" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_routing_rules" ADD CONSTRAINT "event_routing_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_routing_rules" ADD CONSTRAINT "event_routing_rules_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_matched_rule_id_event_routing_rules_id_fk" FOREIGN KEY ("matched_rule_id") REFERENCES "public"."event_routing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_routing_rules_company_enabled_priority_idx" ON "event_routing_rules" USING btree ("company_id","enabled","priority","created_at");--> statement-breakpoint
CREATE INDEX "event_routing_rules_endpoint_idx" ON "event_routing_rules" USING btree ("endpoint_id","enabled","priority");--> statement-breakpoint
CREATE INDEX "event_routing_rules_source_idx" ON "event_routing_rules" USING btree ("company_id","source","enabled","priority");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_company_status_idx" ON "webhook_endpoints" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_company_provider_idx" ON "webhook_endpoints" USING btree ("company_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_company_slug_uidx" ON "webhook_endpoints" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "webhook_events_company_created_idx" ON "webhook_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_endpoint_created_idx" ON "webhook_events" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_company_status_created_idx" ON "webhook_events" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_company_type_created_idx" ON "webhook_events" USING btree ("company_id","event_type","created_at");