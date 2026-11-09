-- Schema state can be ahead of the migration journal after a preview upgrade.
-- Keep completed DDL and data intact when this file is replayed.
CREATE TABLE IF NOT EXISTS "company_prompt_injection_prevention" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"grant_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"model" text DEFAULT 'openai/gpt-oss-safeguard-20b' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_prompt_injection_configured" CHECK (("company_prompt_injection_prevention"."connection_id" is null) = ("company_prompt_injection_prevention"."grant_id" is null) and (not "company_prompt_injection_prevention"."enabled" or "company_prompt_injection_prevention"."connection_id" is not null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_injection_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"tool_invocation_id" uuid,
	"tool_name" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"responsible_user_id" text,
	"agent_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	"run_id" uuid,
	"identity_context_id" uuid,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"model" text NOT NULL,
	"violation" boolean,
	"findings" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"provider_request_id" text,
	"cost_event_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	CONSTRAINT "prompt_injection_invocations_source_check" CHECK ("prompt_injection_invocations"."source" in ('gateway', 'settings_test')),
	CONSTRAINT "prompt_injection_invocations_status_check" CHECK ("prompt_injection_invocations"."status" in ('running', 'succeeded', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" DROP CONSTRAINT IF EXISTS "budget_reservations_source_check";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_usage_kind_check";--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN IF NOT EXISTS "prompt_injection_invocation_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_prompt_injection_prevention" ADD CONSTRAINT "company_prompt_injection_prevention_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "prompt_injection_invocations" ADD CONSTRAINT "prompt_injection_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "prompt_injection_invocations" ADD CONSTRAINT "prompt_injection_invocations_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_injection_invocations_company_started_idx" ON "prompt_injection_invocations" USING btree ("company_id","started_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_injection_invocations_pending_idx" ON "prompt_injection_invocations" USING btree ("started_at") WHERE "prompt_injection_invocations"."status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_injection_invocations_cost_idx" ON "prompt_injection_invocations" USING btree ("cost_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_reservations_prompt_injection_idx" ON "budget_reservations" USING btree ("company_id","prompt_injection_invocation_id");--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_source_check" CHECK (("budget_reservations"."run_id" is not null)::int + ("budget_reservations"."decision_invocation_id" is not null)::int + ("budget_reservations"."fast_response_request_id" is not null)::int + ("budget_reservations"."prompt_injection_invocation_id" is not null)::int = 1);--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_usage_kind_check" CHECK ("cost_events"."usage_kind" in ('decision', 'fast_response', 'prompt_injection') or ("cost_events"."usage_kind" = 'agent' and "cost_events"."agent_id" is not null));
