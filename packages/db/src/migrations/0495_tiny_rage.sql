-- paperclip:migration-compat online_compatible: the previous release never writes responsibility_summary_invocations, budget_reservations.responsibility_summary_invocation_id or the responsibility_summary usage kind; each replacement CHECK accepts every row the old one accepted, and is swapped in one statement (catalog-only, brief lock) as NOT VALID, then validated under SHARE UPDATE EXCLUSIVE, which does not block reads or writes; the unique index is on a new column that is NULL in every existing row and is built CONCURRENTLY. Every statement is idempotent because this file runs outside a transaction.
CREATE TABLE IF NOT EXISTS "responsibility_summary_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"responsibility_id" uuid,
	"owner_user_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"responsible_user_id" text,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"provider_request_id" text,
	"cost_event_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	CONSTRAINT "responsibility_summary_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "responsibility_summary_invocations_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "responsibility_summary_invocations_feature_check" CHECK ("responsibility_summary_invocations"."feature" in ('where_things_stand', 'what_is_affecting_the_number')),
	CONSTRAINT "responsibility_summary_invocations_status_check" CHECK ("responsibility_summary_invocations"."status" in ('running', 'succeeded', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "responsibility_summary_invocations_company_started_idx" ON "responsibility_summary_invocations" USING btree ("company_id","started_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "responsibility_summary_invocations_pending_idx" ON "responsibility_summary_invocations" USING btree ("started_at") WHERE "responsibility_summary_invocations"."status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "responsibility_summary_invocations_cost_idx" ON "responsibility_summary_invocations" USING btree ("cost_event_id");--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN IF NOT EXISTS "responsibility_summary_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_reservations" DROP CONSTRAINT IF EXISTS "budget_reservations_source_check", ADD CONSTRAINT "budget_reservations_source_check" CHECK (("budget_reservations"."run_id" is not null)::int + ("budget_reservations"."decision_invocation_id" is not null)::int + ("budget_reservations"."fast_response_request_id" is not null)::int + ("budget_reservations"."prompt_injection_invocation_id" is not null)::int + ("budget_reservations"."responsibility_summary_invocation_id" is not null)::int = 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "budget_reservations" VALIDATE CONSTRAINT "budget_reservations_source_check";--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_usage_kind_check", ADD CONSTRAINT "cost_events_usage_kind_check" CHECK ("cost_events"."usage_kind" in ('decision', 'fast_response', 'prompt_injection', 'responsibility_summary') or ("cost_events"."usage_kind" = 'agent' and "cost_events"."agent_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "cost_events" VALIDATE CONSTRAINT "cost_events_usage_kind_check";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "budget_reservations_responsibility_summary_idx" ON "budget_reservations" USING btree ("company_id","responsibility_summary_invocation_id");
