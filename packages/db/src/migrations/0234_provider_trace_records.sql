CREATE TABLE IF NOT EXISTS "provider_trace_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'capturing' NOT NULL,
	"provider" text NOT NULL,
	"trace_ref" text NOT NULL,
	"frame_count" integer DEFAULT 0 NOT NULL,
	"byte_count" bigint DEFAULT 0 NOT NULL,
	"digest" text,
	"reason" text,
	"requested_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "provider_trace_records" ADD CONSTRAINT "provider_trace_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "provider_trace_records" ADD CONSTRAINT "provider_trace_records_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_trace_records_run_unique" ON "provider_trace_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_trace_records_expiry_idx" ON "provider_trace_records" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_trace_records_company_created_idx" ON "provider_trace_records" USING btree ("company_id","created_at");
