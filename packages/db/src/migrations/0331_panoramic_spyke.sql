CREATE TABLE IF NOT EXISTS "company_fast_responses" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"grant_id" uuid,
	"model" text,
	"provider" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"allow_sponsored" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_fast_responses_configured" CHECK (("company_fast_responses"."connection_id" is null) = ("company_fast_responses"."grant_id" is null) and (not "company_fast_responses"."enabled" or ("company_fast_responses"."connection_id" is not null and "company_fast_responses"."model" is not null)))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fast_response_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source_comment_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	"agent_id" uuid,
	"responsible_user_id" text,
	"sponsored" boolean DEFAULT false NOT NULL,
	"endpoint_id" uuid,
	"conversation_id" uuid,
	"delivery_id" uuid,
	"session_generation" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"publication_status" text DEFAULT 'pending' NOT NULL,
	"connection_id" uuid,
	"grant_id" uuid,
	"provider" text,
	"model" text,
	"provider_request_id" text,
	"cost_event_id" uuid,
	"error_code" text,
	"comment_id" uuid,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	CONSTRAINT "fast_response_requests_status_check" CHECK ("fast_response_requests"."status" in ('pending', 'running', 'succeeded', 'failed', 'unknown', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" DROP CONSTRAINT IF EXISTS "budget_reservations_source_check";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_usage_kind_check";--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN IF NOT EXISTS "fast_response_request_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'comment' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "fast_response_request_id" uuid;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "company_fast_responses" ADD CONSTRAINT "company_fast_responses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "fast_response_requests" ADD CONSTRAINT "fast_response_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "fast_response_requests" ADD CONSTRAINT "fast_response_requests_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fast_response_requests_source_idx" ON "fast_response_requests" USING btree ("company_id","source_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fast_response_requests_history_idx" ON "fast_response_requests" USING btree ("company_id","accepted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fast_response_requests_work_idx" ON "fast_response_requests" USING btree ("expires_at") WHERE "fast_response_requests"."status" in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_reservations_fast_response_idx" ON "budget_reservations" USING btree ("company_id","fast_response_request_id");--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_source_check" CHECK (("budget_reservations"."run_id" is not null)::int + ("budget_reservations"."decision_invocation_id" is not null)::int + ("budget_reservations"."fast_response_request_id" is not null)::int = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_usage_kind_check" CHECK ("cost_events"."usage_kind" in ('decision', 'fast_response') or ("cost_events"."usage_kind" = 'agent' and "cost_events"."agent_id" is not null));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
