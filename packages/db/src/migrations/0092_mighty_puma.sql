CREATE TABLE "issue_plan_decompositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"accepted_plan_revision_id" uuid NOT NULL,
	"accepted_interaction_id" uuid,
	"status" text DEFAULT 'in_flight' NOT NULL,
	"request_fingerprint" text NOT NULL,
	"requested_child_count" integer DEFAULT 0 NOT NULL,
	"requested_children" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"child_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_agent_id" uuid,
	"owner_user_id" text,
	"owner_run_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_accepted_plan_revision_id_document_revisions_id_fk" FOREIGN KEY ("accepted_plan_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_accepted_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("accepted_interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_plan_decompositions" ADD CONSTRAINT "issue_plan_decompositions_owner_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("owner_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_plan_decompositions_company_source_status_idx" ON "issue_plan_decompositions" USING btree ("company_id","source_issue_id","status");--> statement-breakpoint
CREATE INDEX "issue_plan_decompositions_active_owner_idx" ON "issue_plan_decompositions" USING btree ("company_id","owner_agent_id") WHERE "issue_plan_decompositions"."status" = 'in_flight';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_plan_decompositions_source_revision_uq" ON "issue_plan_decompositions" USING btree ("company_id","source_issue_id","accepted_plan_revision_id");
