CREATE TABLE "rt2_v33_jarvis_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid,
	"level" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'bound' NOT NULL,
	"preferred_project_id" uuid,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_session_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid,
	"last_run_id" uuid,
	"last_run_status" text,
	"session_id_before" text,
	"session_id_after" text,
	"anchor_summary" text,
	"recommendation_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_jarvis_profiles" ADD CONSTRAINT "rt2_v33_jarvis_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_jarvis_profiles" ADD CONSTRAINT "rt2_v33_jarvis_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_jarvis_profiles" ADD CONSTRAINT "rt2_v33_jarvis_profiles_preferred_project_id_projects_id_fk" FOREIGN KEY ("preferred_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_session_anchors" ADD CONSTRAINT "rt2_v33_session_anchors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_session_anchors" ADD CONSTRAINT "rt2_v33_session_anchors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_session_anchors" ADD CONSTRAINT "rt2_v33_session_anchors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_session_anchors" ADD CONSTRAINT "rt2_v33_session_anchors_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_jarvis_profiles_company_user_uq" ON "rt2_v33_jarvis_profiles" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE INDEX "rt2_v33_jarvis_profiles_company_status_idx" ON "rt2_v33_jarvis_profiles" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_session_anchors_company_user_project_uq" ON "rt2_v33_session_anchors" USING btree ("company_id","user_id","project_id");
