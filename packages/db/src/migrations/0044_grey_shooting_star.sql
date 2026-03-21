CREATE TABLE "sparring_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text,
	"status" text DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sparring_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid,
	"coordinator_agent_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sparring_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"turn_number" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "general" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sparring_participants" ADD CONSTRAINT "sparring_participants_session_id_sparring_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sparring_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparring_participants" ADD CONSTRAINT "sparring_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparring_sessions" ADD CONSTRAINT "sparring_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparring_sessions" ADD CONSTRAINT "sparring_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparring_sessions" ADD CONSTRAINT "sparring_sessions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparring_sessions" ADD CONSTRAINT "sparring_sessions_coordinator_agent_id_agents_id_fk" FOREIGN KEY ("coordinator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparring_turns" ADD CONSTRAINT "sparring_turns_session_id_sparring_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sparring_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparring_turns" ADD CONSTRAINT "sparring_turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sparring_participants_session_agent_unique" ON "sparring_participants" USING btree ("session_id","agent_id");--> statement-breakpoint
CREATE INDEX "sparring_participants_session_idx" ON "sparring_participants" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sparring_sessions_company_idx" ON "sparring_sessions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "sparring_sessions_issue_idx" ON "sparring_sessions" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sparring_sessions_active_issue_unique" ON "sparring_sessions" USING btree ("issue_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "sparring_turns_session_idx" ON "sparring_turns" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sparring_turns_session_turn_idx" ON "sparring_turns" USING btree ("session_id","turn_number");