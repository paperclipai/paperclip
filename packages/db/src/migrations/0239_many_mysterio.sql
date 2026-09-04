CREATE TABLE "connection_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" text,
	"repository_id" text,
	"normalized_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"provider_created_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_event_deliveries" ADD CONSTRAINT "connection_event_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_event_deliveries_company_provider_id_uq" ON "connection_event_deliveries" USING btree ("company_id","provider","provider_delivery_id");--> statement-breakpoint
CREATE INDEX "connection_event_deliveries_company_status_idx" ON "connection_event_deliveries" USING btree ("company_id","status","created_at");