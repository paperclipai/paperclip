CREATE TABLE IF NOT EXISTS "connection_token_issuances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "application_id" uuid,
  "connection_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "run_id" uuid,
  "issue_id" uuid,
  "project_id" uuid,
  "responsible_user_id" text,
  "path" text NOT NULL,
  "requested_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "issued_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ttl_seconds" integer,
  "expires_at" timestamp with time zone,
  "token_hash" text,
  "outcome" text NOT NULL,
  "error_code" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connection_token_issuances_path_check" CHECK ("connection_token_issuances"."path" IN ('exchange', 'oauth_access', 'static')),
  CONSTRAINT "connection_token_issuances_outcome_check" CHECK ("connection_token_issuances"."outcome" IN ('success', 'denied', 'rate_limited', 'use_env_lease', 'upstream_error', 'failure')),
  CONSTRAINT "connection_token_issuances_ttl_bounds" CHECK ("connection_token_issuances"."ttl_seconds" IS NULL OR ("connection_token_issuances"."ttl_seconds" >= 1 AND "connection_token_issuances"."ttl_seconds" <= 900)),
  CONSTRAINT "connection_token_issuances_token_hash_format" CHECK ("connection_token_issuances"."token_hash" IS NULL OR "connection_token_issuances"."token_hash" ~ '^[a-f0-9]{64}$')
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_token_issuances_company_created_idx" ON "connection_token_issuances" USING btree ("company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_token_issuances_connection_created_idx" ON "connection_token_issuances" USING btree ("company_id", "connection_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_token_issuances_agent_connection_idx" ON "connection_token_issuances" USING btree ("company_id", "agent_id", "connection_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_token_issuances_run_idx" ON "connection_token_issuances" USING btree ("company_id", "run_id");
