CREATE TABLE IF NOT EXISTS "cost_event_seat_attributions" (
	"cost_event_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"attribution_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_event_seat_attributions_cost_event_id_cost_events_id_fk') THEN
  ALTER TABLE "cost_event_seat_attributions" ADD CONSTRAINT "cost_event_seat_attributions_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_event_seat_attributions_company_id_companies_id_fk') THEN
  ALTER TABLE "cost_event_seat_attributions" ADD CONSTRAINT "cost_event_seat_attributions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_event_seat_attributions_seat_id_seats_id_fk') THEN
  ALTER TABLE "cost_event_seat_attributions" ADD CONSTRAINT "cost_event_seat_attributions_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_event_seat_attributions_company_seat_idx" ON "cost_event_seat_attributions" USING btree ("company_id","seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_event_seat_attributions_company_source_idx" ON "cost_event_seat_attributions" USING btree ("company_id","attribution_source");
