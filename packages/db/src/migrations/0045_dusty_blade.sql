ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_api_keys" DROP CONSTRAINT "agent_api_keys_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_config_revisions" DROP CONSTRAINT "agent_config_revisions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtime_state" DROP CONSTRAINT "agent_runtime_state_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" DROP CONSTRAINT "agent_task_sessions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" DROP CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" DROP CONSTRAINT "agent_wakeup_requests_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_comments" DROP CONSTRAINT "approval_comments_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "company_memberships" DROP CONSTRAINT "company_memberships_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "company_secrets" DROP CONSTRAINT "company_secrets_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT "cost_events_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "goals" DROP CONSTRAINT "goals_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT "heartbeat_run_events_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" DROP CONSTRAINT "heartbeat_runs_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_comments" DROP CONSTRAINT "issue_comments_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "principal_permission_grants" DROP CONSTRAINT "principal_permission_grants_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "project_goals" DROP CONSTRAINT "project_goals_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "project_workspaces" DROP CONSTRAINT "project_workspaces_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_goal_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD CONSTRAINT "agent_runtime_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;