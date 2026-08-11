CREATE TABLE "enrichment_cap_pause_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"queue_row_id" uuid,
	"notification_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"amount_cents" integer NOT NULL,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrichment_promotion_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_count" integer NOT NULL,
	"approver_agent_id" text,
	"approver_user_id" text,
	"payload_json" jsonb NOT NULL,
	"promoted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_row_id" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrichment_reviewer_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"queue_row_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"reserved_cents" integer NOT NULL,
	"actual_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrichment_staging" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_row_id" text NOT NULL,
	"primary_output_json" jsonb,
	"fallback_output_json" jsonb,
	"validator_result" jsonb,
	"anomaly_score" numeric(5, 4),
	"reviewer_verdict" text,
	"human_approved_at" timestamp with time zone,
	"human_approved_by" text,
	"promoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrichment_cap_pause_events" ADD CONSTRAINT "enrichment_cap_pause_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_cap_pause_events" ADD CONSTRAINT "enrichment_cap_pause_events_queue_row_id_enrichment_queue_id_fk" FOREIGN KEY ("queue_row_id") REFERENCES "public"."enrichment_queue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_promotion_log" ADD CONSTRAINT "enrichment_promotion_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_queue" ADD CONSTRAINT "enrichment_queue_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_reviewer_reservations" ADD CONSTRAINT "enrichment_reviewer_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_reviewer_reservations" ADD CONSTRAINT "enrichment_reviewer_reservations_queue_row_id_enrichment_queue_id_fk" FOREIGN KEY ("queue_row_id") REFERENCES "public"."enrichment_queue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_staging" ADD CONSTRAINT "enrichment_staging_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_cap_pause_events_company_notification_uq" ON "enrichment_cap_pause_events" USING btree ("company_id","notification_key");--> statement-breakpoint
CREATE INDEX "enrichment_cap_pause_events_pending_idx" ON "enrichment_cap_pause_events" USING btree ("company_id","state","created_at");--> statement-breakpoint
CREATE INDEX "enrichment_promotion_log_company_batch_idx" ON "enrichment_promotion_log" USING btree ("company_id","batch_id");--> statement-breakpoint
CREATE INDEX "enrichment_queue_company_status_created_idx" ON "enrichment_queue" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "enrichment_queue_company_source_row_idx" ON "enrichment_queue" USING btree ("company_id","source_row_id");--> statement-breakpoint
CREATE INDEX "enrichment_reviewer_reservations_company_state_created_idx" ON "enrichment_reviewer_reservations" USING btree ("company_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_reviewer_reservations_company_queue_request_uq" ON "enrichment_reviewer_reservations" USING btree ("company_id","queue_row_id","request_key");--> statement-breakpoint
CREATE INDEX "enrichment_staging_company_batch_idx" ON "enrichment_staging" USING btree ("company_id","batch_id");--> statement-breakpoint
CREATE INDEX "enrichment_staging_company_review_idx" ON "enrichment_staging" USING btree ("company_id","human_approved_at");