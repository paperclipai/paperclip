CREATE TABLE "agent_account_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"session_identity" text NOT NULL,
	"session_params_json" jsonb,
	"session_display_id" text,
	"last_run_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_connection_quota_cooldowns" (
	"company_id" uuid NOT NULL,
	"credential_identity" text NOT NULL,
	"retry_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_account_sessions" ADD CONSTRAINT "agent_account_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_account_sessions" ADD CONSTRAINT "agent_account_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_sessions_id_company_uniq" ON "agent_task_sessions" USING btree ("id","company_id");--> statement-breakpoint
ALTER TABLE "agent_account_sessions" ADD CONSTRAINT "agent_account_sessions_session_id_company_id_agent_task_sessions_id_company_id_fk" FOREIGN KEY ("session_id","company_id") REFERENCES "public"."agent_task_sessions"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connection_quota_cooldowns" ADD CONSTRAINT "ai_connection_quota_cooldowns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_account_sessions_company_session_identity_uniq" ON "agent_account_sessions" USING btree ("company_id","session_id","session_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_connection_quota_cooldowns_company_identity_uq" ON "ai_connection_quota_cooldowns" USING btree ("company_id","credential_identity");