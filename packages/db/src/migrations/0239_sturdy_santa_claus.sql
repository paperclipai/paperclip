CREATE TABLE IF NOT EXISTS "connection_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" text,
	"repository_id" text,
	"normalized_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"provider_created_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_kind_check";--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_subject_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_credential_policy_check";--> statement-breakpoint
ALTER TABLE "connection_grants" ADD COLUMN IF NOT EXISTS "subject_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD COLUMN IF NOT EXISTS "subject_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "connection_event_deliveries" DROP CONSTRAINT IF EXISTS "connection_event_deliveries_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "connection_event_deliveries" ADD CONSTRAINT "connection_event_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connection_event_deliveries_company_provider_id_uq" ON "connection_event_deliveries" USING btree ("company_id","provider","provider_delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_event_deliveries_company_status_idx" ON "connection_event_deliveries" USING btree ("company_id","status","created_at");--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT IF EXISTS "connection_grants_subject_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_oauth_states" DROP CONSTRAINT IF EXISTS "tool_oauth_states_subject_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "tool_oauth_states" ADD CONSTRAINT "tool_oauth_states_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_grants_subject_agent_idx" ON "connection_grants" USING btree ("company_id","subject_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grants_agent_uq" ON "connection_grants" USING btree ("connection_id","subject_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_oauth_states_subject_agent_idx" ON "tool_oauth_states" USING btree ("company_id","subject_agent_id");--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_kind_check" CHECK ("connection_grants"."kind" in ('organization', 'user', 'agent'));--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_check" CHECK (("connection_grants"."kind" = 'user' and "connection_grants"."subject_user_id" is not null and "connection_grants"."subject_agent_id" is null) or ("connection_grants"."kind" = 'agent' and "connection_grants"."subject_agent_id" is not null and "connection_grants"."subject_user_id" is null) or ("connection_grants"."kind" = 'organization' and "connection_grants"."subject_user_id" is null and "connection_grants"."subject_agent_id" is null));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_policy_check" CHECK ("tool_connections"."credential_policy" in ('shared', 'per_user', 'per_user_with_fallback', 'per_agent'));
