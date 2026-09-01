CREATE TABLE IF NOT EXISTS "agent_session_goal_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"action" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_capability_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_status" text;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_desired_state" text;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_source_id" text;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_source_cursor" bigint;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN IF NOT EXISTS "goal_observed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agent_session_goal_actions" ADD CONSTRAINT "agent_session_goal_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agent_session_goal_actions" ADD CONSTRAINT "agent_session_goal_actions_session_id_agent_task_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_task_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_session_goal_actions_session_request_uniq" ON "agent_session_goal_actions" USING btree ("session_id","request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_session_goal_actions_company_status_created_idx" ON "agent_session_goal_actions" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_session_goal_actions_session_created_idx" ON "agent_session_goal_actions" USING btree ("session_id","created_at");
