CREATE TABLE "run_todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_todos" ADD CONSTRAINT "run_todos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "run_todos" ADD CONSTRAINT "run_todos_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "run_todos" ADD CONSTRAINT "run_todos_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "run_todos" ADD CONSTRAINT "run_todos_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "run_todos_run_seq_idx" ON "run_todos" USING btree ("run_id","seq");
--> statement-breakpoint
CREATE INDEX "run_todos_issue_idx" ON "run_todos" USING btree ("issue_id");
