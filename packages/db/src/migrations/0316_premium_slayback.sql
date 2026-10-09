-- Idempotent for installations that applied the pre-merge decision migration.
CREATE TABLE IF NOT EXISTS "company_decision_models" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"grant_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"allow_background" boolean DEFAULT true NOT NULL,
	"provider" text,
	"model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_decisions_configured" CHECK (("company_decision_models"."connection_id" is null) = ("company_decision_models"."grant_id" is null) and (not "company_decision_models"."enabled" or ("company_decision_models"."connection_id" is not null and "company_decision_models"."provider" is not null and "company_decision_models"."model" is not null)))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"feature" text NOT NULL,
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
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"question_types" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"provider_request_id" text,
	"cost_event_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	CONSTRAINT "decision_invocations_status_check" CHECK ("decision_invocations"."status" in ('running', 'succeeded', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_reservations" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN IF NOT EXISTS "decision_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "usage_kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_decision_models_company_id_companies_id_fk' AND conrelid = 'company_decision_models'::regclass) THEN
    ALTER TABLE "company_decision_models" ADD CONSTRAINT "company_decision_models_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_invocations_company_id_companies_id_fk' AND conrelid = 'decision_invocations'::regclass) THEN
    ALTER TABLE "decision_invocations" ADD CONSTRAINT "decision_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_invocations_cost_event_id_cost_events_id_fk' AND conrelid = 'decision_invocations'::regclass) THEN
    ALTER TABLE "decision_invocations" ADD CONSTRAINT "decision_invocations_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_invocations_company_started_idx" ON "decision_invocations" USING btree ("company_id","started_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_invocations_pending_idx" ON "decision_invocations" USING btree ("started_at") WHERE "decision_invocations"."status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_invocations_cost_idx" ON "decision_invocations" USING btree ("cost_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_reservations_decision_idx" ON "budget_reservations" USING btree ("company_id","decision_invocation_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_reservations_source_check' AND conrelid = 'budget_reservations'::regclass) THEN
    ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_source_check" CHECK (("budget_reservations"."run_id" is not null)::int + ("budget_reservations"."decision_invocation_id" is not null)::int = 1);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_events_usage_kind_check' AND conrelid = 'cost_events'::regclass) THEN
    ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_usage_kind_check" CHECK ("cost_events"."usage_kind" = 'decision' or ("cost_events"."usage_kind" = 'agent' and "cost_events"."agent_id" is not null));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "company_decision_models" DROP CONSTRAINT IF EXISTS "company_decision_models_connection_id_tool_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "company_decision_models" DROP CONSTRAINT IF EXISTS "company_decision_models_grant_id_connection_grants_id_fk";
