CREATE TABLE "interrupted_run_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interrupted_run_id" uuid NOT NULL,
	"kind" text DEFAULT 'process_loss_handoff' NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"owner_agent_id" uuid,
	"successor_run_id" uuid,
	"recovery_action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interrupted_run_handoffs_kind_check" CHECK ("interrupted_run_handoffs"."kind" = 'process_loss_handoff'),
	CONSTRAINT "interrupted_run_handoffs_status_check" CHECK ("interrupted_run_handoffs"."status" in ('queued', 'running', 'succeeded', 'waiting', 'terminal', 'suppressed', 'escalated')),
	CONSTRAINT "interrupted_run_handoffs_reason_length_check" CHECK (char_length("interrupted_run_handoffs"."reason") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "interrupted_run_handoffs" ADD CONSTRAINT "interrupted_run_handoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interrupted_run_handoffs" ADD CONSTRAINT "interrupted_run_handoffs_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interrupted_run_handoffs" ADD CONSTRAINT "interrupted_run_handoffs_recovery_action_id_issue_recovery_actions_id_fk" FOREIGN KEY ("recovery_action_id") REFERENCES "public"."issue_recovery_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_company_id_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "interrupted_run_handoffs" ADD CONSTRAINT "interrupted_run_handoffs_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interrupted_run_handoffs" ADD CONSTRAINT "interrupted_run_handoffs_source_company_fk" FOREIGN KEY ("company_id","interrupted_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interrupted_run_handoffs" ADD CONSTRAINT "interrupted_run_handoffs_successor_company_fk" FOREIGN KEY ("company_id","successor_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interrupted_run_handoffs_fingerprint_uq" ON "interrupted_run_handoffs" USING btree ("company_id","issue_id","interrupted_run_id","kind");--> statement-breakpoint
CREATE INDEX "interrupted_run_handoffs_company_issue_status_idx" ON "interrupted_run_handoffs" USING btree ("company_id","issue_id","status");--> statement-breakpoint
CREATE INDEX "interrupted_run_handoffs_company_successor_idx" ON "interrupted_run_handoffs" USING btree ("company_id","successor_run_id");
