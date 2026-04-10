CREATE TABLE "gateway_circuit_state" (
	"route_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"adapter_type" text NOT NULL,
	"model" text NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"quota_tokens_per_minute" integer,
	"quota_tokens_per_hour" integer,
	"quota_tokens_per_day" integer,
	"quota_requests_per_minute" integer,
	"quota_requests_per_hour" integer,
	"quota_requests_per_day" integer,
	"circuit_breaker_enabled" boolean DEFAULT false NOT NULL,
	"circuit_breaker_failure_threshold" integer DEFAULT 3 NOT NULL,
	"circuit_breaker_reset_sec" integer DEFAULT 300 NOT NULL,
	"timeout_sec" integer,
	"adapter_config_overrides" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"window_type" text NOT NULL,
	"window_key" text NOT NULL,
	"token_count" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_execution_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"stage_type" text NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"outcome" text NOT NULL,
	"body" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routines" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ALTER COLUMN "assignee_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_satisfied_by_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_retry_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_policy" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_state" jsonb;--> statement-breakpoint
ALTER TABLE "gateway_circuit_state" ADD CONSTRAINT "gateway_circuit_state_route_id_gateway_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."gateway_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_routes" ADD CONSTRAINT "gateway_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_routes" ADD CONSTRAINT "gateway_routes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_usage_counters" ADD CONSTRAINT "gateway_usage_counters_route_id_gateway_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."gateway_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_routes_company_agent_idx" ON "gateway_routes" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "gateway_routes_company_enabled_idx" ON "gateway_routes" USING btree ("company_id","is_enabled","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_usage_route_window_unique_idx" ON "gateway_usage_counters" USING btree ("route_id","window_type","window_key");--> statement-breakpoint
CREATE INDEX "issue_execution_decisions_company_issue_idx" ON "issue_execution_decisions" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_execution_decisions_stage_idx" ON "issue_execution_decisions" USING btree ("issue_id","stage_id","created_at");