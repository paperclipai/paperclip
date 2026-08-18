CREATE TABLE "workflow_extension_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"extension_key" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"generation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_extension_requests_run_extension_idempotency_unique" UNIQUE("workflow_run_id","extension_key","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "workflow_handoffs" ADD COLUMN "review_stage" text;--> statement-breakpoint
ALTER TABLE "workflow_handoffs" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_handoffs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
UPDATE "workflow_run_events"
SET "idempotency_key" = 'legacy:' || "id"::text
WHERE "idempotency_key" IS NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_extension_requests" ADD CONSTRAINT "workflow_extension_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_extension_requests" ADD CONSTRAINT "workflow_extension_requests_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_extension_requests_run_created_idx" ON "workflow_extension_requests" USING btree ("workflow_run_id","created_at");--> statement-breakpoint
ALTER TABLE "workflow_handoffs" ADD CONSTRAINT "workflow_handoffs_run_idempotency_unique" UNIQUE("workflow_run_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_run_idempotency_unique" UNIQUE("workflow_run_id","idempotency_key");
