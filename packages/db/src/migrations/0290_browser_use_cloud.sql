CREATE TABLE IF NOT EXISTS "browser_use_browsers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"provider_browser_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_use_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"provider_run_id" uuid,
	"status" text DEFAULT 'creating' NOT NULL,
	"detached_until" timestamp with time zone,
	"recovery_cursor" text,
	"event_cursor" integer DEFAULT 0 NOT NULL,
	"events_drained" integer DEFAULT 0 NOT NULL,
	"accounted_cents" integer DEFAULT 0 NOT NULL,
	"progress" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_use_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"provider_session_id" uuid,
	"status" text DEFAULT 'starting' NOT NULL,
	"idle_deadline" timestamp with time zone,
	"stop_requested" text,
	"error" text,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_use_settings" (
	"grant_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"allowed_profile_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_cost_usd" text
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_browsers_company_id_companies_id_fk' AND conrelid = 'public.browser_use_browsers'::regclass) THEN
    ALTER TABLE "browser_use_browsers" ADD CONSTRAINT "browser_use_browsers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_browsers_session_id_browser_use_sessions_id_fk' AND conrelid = 'public.browser_use_browsers'::regclass) THEN
    ALTER TABLE "browser_use_browsers" ADD CONSTRAINT "browser_use_browsers_session_id_browser_use_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_use_sessions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_runs_company_id_companies_id_fk' AND conrelid = 'public.browser_use_runs'::regclass) THEN
    ALTER TABLE "browser_use_runs" ADD CONSTRAINT "browser_use_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_runs_session_id_browser_use_sessions_id_fk' AND conrelid = 'public.browser_use_runs'::regclass) THEN
    ALTER TABLE "browser_use_runs" ADD CONSTRAINT "browser_use_runs_session_id_browser_use_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_use_sessions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_runs_heartbeat_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.browser_use_runs'::regclass) THEN
    ALTER TABLE "browser_use_runs" ADD CONSTRAINT "browser_use_runs_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_company_id_companies_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_issue_id_issues_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_agent_id_agents_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_connection_id_tool_connections_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_sessions_grant_id_connection_grants_id_fk' AND conrelid = 'public.browser_use_sessions'::regclass) THEN
    ALTER TABLE "browser_use_sessions" ADD CONSTRAINT "browser_use_sessions_grant_id_connection_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."connection_grants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_settings_grant_id_connection_grants_id_fk' AND conrelid = 'public.browser_use_settings'::regclass) THEN
    ALTER TABLE "browser_use_settings" ADD CONSTRAINT "browser_use_settings_grant_id_connection_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."connection_grants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'browser_use_settings_company_id_companies_id_fk' AND conrelid = 'public.browser_use_settings'::regclass) THEN
    ALTER TABLE "browser_use_settings" ADD CONSTRAINT "browser_use_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_use_browsers_provider_uq" ON "browser_use_browsers" USING btree ("provider_browser_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_use_browsers_session_idx" ON "browser_use_browsers" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_use_runs_invocation_uq" ON "browser_use_runs" USING btree ("invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_use_runs_provider_uq" ON "browser_use_runs" USING btree ("provider_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_use_runs_session_idx" ON "browser_use_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_use_sessions_task_idx" ON "browser_use_sessions" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_use_sessions_provider_uq" ON "browser_use_sessions" USING btree ("provider_session_id");
--> statement-breakpoint
-- Support development databases that applied the initial browser schema.
ALTER TABLE "browser_use_runs" ADD COLUMN IF NOT EXISTS "detached_until" timestamp with time zone;

--> statement-breakpoint
ALTER TABLE "browser_use_runs" ADD COLUMN IF NOT EXISTS "recovery_cursor" text;
--> statement-breakpoint
-- Preserve pre-release connections, grants and browser history under the Cloud identity.
UPDATE "tool_connections"
SET "config" = jsonb_set("config", '{sourceTemplateKey}', '"browser-use-cloud"'),
    "transport_config" = CASE WHEN "transport_config"->>'sourceTemplateKey' = 'browser-use'
      THEN jsonb_set("transport_config", '{sourceTemplateKey}', '"browser-use-cloud"') ELSE "transport_config" END
WHERE "transport" = 'rest_api' AND "config"->>'sourceTemplateKey' = 'browser-use';
--> statement-breakpoint
UPDATE "tool_applications"
SET "metadata" = "metadata" || '{"sourceTemplateKey":"browser-use-cloud","galleryKey":"browser-use-cloud"}'::jsonb,
    "application_key" = regexp_replace("application_key", '^app-gallery:browser-use:', 'app-gallery:browser-use-cloud:')
WHERE "type" = 'rest_api' AND "metadata"->>'sourceTemplateKey' = 'browser-use';
--> statement-breakpoint
UPDATE "cost_events"
SET "provider" = 'browser-use-cloud',
    "biller" = CASE WHEN "biller" = 'browser-use' THEN 'browser-use-cloud' ELSE "biller" END,
    "billing_code" = regexp_replace("billing_code", '^browser-use:', 'browser-use-cloud:')
WHERE "provider" = 'browser-use' AND "billing_code" IN (
  SELECT 'browser-use:' || "id"::text FROM "browser_use_runs" WHERE "company_id" = "cost_events"."company_id"
);
--> statement-breakpoint
UPDATE "finance_events"
SET "provider" = 'browser-use-cloud',
    "biller" = CASE WHEN "biller" = 'browser-use' THEN 'browser-use-cloud' ELSE "biller" END,
    "billing_code" = regexp_replace("billing_code", '^browser-use:', 'browser-use-cloud:')
WHERE "provider" = 'browser-use' AND "billing_code" IN (
  SELECT 'browser-use:' || "id"::text FROM "browser_use_runs" WHERE "company_id" = "finance_events"."company_id"
);
