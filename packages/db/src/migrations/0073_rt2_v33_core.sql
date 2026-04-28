CREATE TABLE "rt2_v33_task_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"ended_reason" text,
	"joined_by_user_id" text,
	"ended_by_user_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "rt2_v33_task_participants_state_check" CHECK ("rt2_v33_task_participants"."state" in ('active', 'ended')),
	CONSTRAINT "rt2_v33_task_participants_ended_reason_check" CHECK ("rt2_v33_task_participants"."ended_reason" is null or "rt2_v33_task_participants"."ended_reason" in ('manager_removed', 'self_left', 'capacity_reduced'))
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_task_profiles" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid,
	"task_mode" text NOT NULL,
	"capacity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_task_profiles_task_mode_check" CHECK ("rt2_v33_task_profiles"."task_mode" in ('solo', 'collab')),
	CONSTRAINT "rt2_v33_task_profiles_capacity_check" CHECK ("rt2_v33_task_profiles"."capacity" >= 1)
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_task_participants" ADD CONSTRAINT "rt2_v33_task_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_task_participants" ADD CONSTRAINT "rt2_v33_task_participants_task_issue_id_issues_id_fk" FOREIGN KEY ("task_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_task_profiles" ADD CONSTRAINT "rt2_v33_task_profiles_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_task_profiles" ADD CONSTRAINT "rt2_v33_task_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_task_profiles" ADD CONSTRAINT "rt2_v33_task_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_task_profiles" ADD CONSTRAINT "rt2_v33_task_profiles_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rt2_v33_task_participants_task_state_idx" ON "rt2_v33_task_participants" USING btree ("task_issue_id","state");--> statement-breakpoint
CREATE INDEX "rt2_v33_task_participants_task_user_idx" ON "rt2_v33_task_participants" USING btree ("task_issue_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_task_participants_active_user_uq" ON "rt2_v33_task_participants" USING btree ("task_issue_id","user_id") WHERE "rt2_v33_task_participants"."state" = 'active';--> statement-breakpoint
CREATE INDEX "rt2_v33_task_profiles_company_project_idx" ON "rt2_v33_task_profiles" USING btree ("company_id","project_id");