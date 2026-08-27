CREATE TABLE "issue_question_response_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"source_run_id" uuid,
	"target_run_id" uuid,
	"target_turn_id" text,
	"correlation_id" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_mode" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_question_response_deliveries_status_check" CHECK ("issue_question_response_deliveries"."status" IN ('pending', 'delivering', 'delivered', 'fallback_queued', 'failed')),
	CONSTRAINT "issue_question_response_deliveries_mode_check" CHECK ("issue_question_response_deliveries"."delivery_mode" IS NULL OR "issue_question_response_deliveries"."delivery_mode" IN ('steered', 'coalesced', 'wake_fallback'))
);
--> statement-breakpoint
ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_target_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_question_response_deliveries_interaction_uq" ON "issue_question_response_deliveries" USING btree ("interaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_question_response_deliveries_correlation_uq" ON "issue_question_response_deliveries" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "issue_question_response_deliveries_pending_idx" ON "issue_question_response_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "issue_question_response_deliveries_company_issue_idx" ON "issue_question_response_deliveries" USING btree ("company_id","issue_id","created_at");