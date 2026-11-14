CREATE TABLE "cloud_product_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transaction_id" bigint DEFAULT txid_current() NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"responsible_user_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_product_events" ADD CONSTRAINT "cloud_product_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_product_events_event_id_uq" ON "cloud_product_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "cloud_product_events_company_cursor_idx" ON "cloud_product_events" USING btree ("company_id","transaction_id","id");--> statement-breakpoint
CREATE INDEX "cloud_product_events_occurred_at_idx" ON "cloud_product_events" USING btree ("occurred_at");