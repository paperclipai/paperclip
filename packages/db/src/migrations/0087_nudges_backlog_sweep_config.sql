CREATE TABLE IF NOT EXISTS "nudges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_agent_id" uuid NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"target_assignee_agent_id" uuid,
	"idempotency_key" text NOT NULL,
	"reason" text NOT NULL,
	"woke" boolean DEFAULT false NOT NULL,
	"rate_limited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_target_assignee_agent_id_agents_id_fk" FOREIGN KEY ("target_assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "nudges_company_idempotency_uq" ON "nudges" USING btree ("company_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nudges_company_actor_created_idx" ON "nudges" USING btree ("company_id","actor_agent_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nudges_target_issue_idx" ON "nudges" USING btree ("target_issue_id");
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "backlog_sweep_config" jsonb;
