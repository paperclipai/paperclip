CREATE TABLE "company_transfer_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"direction" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"actor_key" text NOT NULL,
	"container_ref" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"manifest_sha256" text,
	"manifest" jsonb,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"blob_count" integer DEFAULT 0 NOT NULL,
	"completed_parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_transfer_runs" ADD CONSTRAINT "company_transfer_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_transfer_runs_company_idx" ON "company_transfer_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_transfer_runs_idempotency_direction_idx" ON "company_transfer_runs" USING btree ("idempotency_key","direction");--> statement-breakpoint
CREATE INDEX "company_transfer_runs_actor_status_idx" ON "company_transfer_runs" USING btree ("actor_key","status");