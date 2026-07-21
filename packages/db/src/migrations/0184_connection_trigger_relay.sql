CREATE TABLE "connection_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"destination_type" text NOT NULL,
	"destination_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_triggers_destination_type_check" CHECK ("connection_triggers"."destination_type" in ('routine', 'issue_wake', 'plugin_worker'))
);
--> statement-breakpoint
CREATE TABLE "connection_trigger_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"provider_slug" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"envelope" jsonb NOT NULL,
	"trigger_snapshot" jsonb,
	"completed_trigger_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"forwarded_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_trigger_deliveries_status_check" CHECK ("connection_trigger_deliveries"."status" in ('received', 'forwarded', 'delivered', 'failed', 'dead_letter'))
);
--> statement-breakpoint
ALTER TABLE "connection_triggers" ADD CONSTRAINT "connection_triggers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connection_triggers" ADD CONSTRAINT "connection_triggers_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connection_trigger_deliveries" ADD CONSTRAINT "connection_trigger_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connection_trigger_deliveries" ADD CONSTRAINT "connection_trigger_deliveries_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "connection_triggers_company_idx" ON "connection_triggers" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "connection_triggers_connection_idx" ON "connection_triggers" USING btree ("connection_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "connection_triggers_destination_uq" ON "connection_triggers" USING btree ("connection_id","destination_type","destination_id");
--> statement-breakpoint
CREATE INDEX "connection_trigger_deliveries_company_idx" ON "connection_trigger_deliveries" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "connection_trigger_deliveries_connection_status_idx" ON "connection_trigger_deliveries" USING btree ("connection_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "connection_trigger_deliveries_connection_delivery_uq" ON "connection_trigger_deliveries" USING btree ("connection_id","delivery_id");
