CREATE TABLE "rt2_v33_work_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_issue_id" uuid,
	"deliverable_work_product_id" uuid,
	"state" text DEFAULT 'draft' NOT NULL,
	"archived_at" timestamp with time zone,
	"legacy_source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_work_entities_state_check" CHECK ("rt2_v33_work_entities"."state" in ('draft', 'active', 'completed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_work_entities" ADD CONSTRAINT "rt2_v33_work_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_work_entities_company_task_delivery_uq" ON "rt2_v33_work_entities" USING btree ("company_id","task_issue_id","deliverable_work_product_id") WHERE "task_issue_id" is not null and "deliverable_work_product_id" is not null;
--> statement-breakpoint
CREATE TABLE "rt2_v33_work_entities_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_issue_id" uuid,
	"deliverable_work_product_id" uuid,
	"state" text NOT NULL,
	"archived_at" timestamp with time zone,
	"legacy_source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"migration_batch_id" text NOT NULL,
	"migrated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_work_projector_state" (
	"projector_name" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_event_id" uuid,
	"last_processed_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "rt2_v33_work_projector_state_status_check" CHECK ("rt2_v33_work_projector_state"."status" in ('idle', 'running', 'failed'))
);
