CREATE TABLE IF NOT EXISTS "tool_gateway_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "issue_id" uuid,
  "project_id" uuid,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_project_id_projects_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tool_gateway_sessions_token_hash_uq" ON "tool_gateway_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_company_agent_idx" ON "tool_gateway_sessions" USING btree ("company_id", "agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_company_expires_idx" ON "tool_gateway_sessions" USING btree ("company_id", "expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_run_idx" ON "tool_gateway_sessions" USING btree ("company_id", "run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_issue_idx" ON "tool_gateway_sessions" USING btree ("company_id", "issue_id");
