-- Supabase security advisor remediation: keep extensions outside exposed public schema.
CREATE SCHEMA IF NOT EXISTS "extensions";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension ext
    JOIN pg_namespace ns ON ns.oid = ext.extnamespace
    WHERE ext.extname = 'pg_trgm' AND ns.nspname = 'public'
  ) THEN
    ALTER EXTENSION "pg_trgm" SET SCHEMA "extensions";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_extension ext
    JOIN pg_namespace ns ON ns.oid = ext.extnamespace
    WHERE ext.extname = 'fuzzystrmatch' AND ns.nspname = 'public'
  ) THEN
    ALTER EXTENSION "fuzzystrmatch" SET SCHEMA "extensions";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "activity_log";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "activity_log"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "agent_api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "agent_api_keys";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "agent_api_keys"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "agent_config_revisions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "agent_config_revisions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "agent_runtime_state";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "agent_runtime_state"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "agent_task_sessions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "agent_task_sessions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "agent_wakeup_requests";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "agent_wakeup_requests"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "agents";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "agents"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "approval_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "approval_comments";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "approval_comments"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "approvals";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "approvals"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "assets";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "assets"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "user";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "user"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "session";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "session"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "account";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "account"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "verification";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "verification"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "board_api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "board_api_keys";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "board_api_keys"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "budget_incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "budget_incidents";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "budget_incidents"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "budget_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "budget_policies";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "budget_policies"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "cli_auth_challenges";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "cli_auth_challenges"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "companies";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "companies"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "company_logos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "company_logos";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "company_logos"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "company_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "company_memberships";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "company_memberships"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "company_secret_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "company_secret_bindings";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "company_secret_bindings"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "company_secret_provider_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "company_secret_provider_configs";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "company_secret_provider_configs"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "company_secret_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "company_secret_versions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "company_secret_versions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "company_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "company_secrets";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "company_secrets"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "company_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "company_skills";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "company_skills"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "company_user_sidebar_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "company_user_sidebar_preferences";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "company_user_sidebar_preferences"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "cost_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "cost_events";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "cost_events"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "document_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "document_revisions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "document_revisions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "documents";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "documents"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "environment_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "environment_leases";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "environment_leases"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "environments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "environments";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "environments"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "execution_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "execution_workspaces";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "execution_workspaces"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "feedback_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "feedback_exports";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "feedback_exports"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "feedback_votes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "feedback_votes";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "feedback_votes"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "finance_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "finance_events";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "finance_events"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "goals";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "goals"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "heartbeat_run_events";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "heartbeat_run_events"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "heartbeat_run_watchdog_decisions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "heartbeat_run_watchdog_decisions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "heartbeat_runs";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "heartbeat_runs"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "inbox_dismissals";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "inbox_dismissals"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "instance_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "instance_settings";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "instance_settings"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "instance_user_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "instance_user_roles";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "instance_user_roles"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "invites";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "invites"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_approvals";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_approvals"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_attachments";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_attachments"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_comments";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_comments"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_documents";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_documents"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_execution_decisions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_execution_decisions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_inbox_archives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_inbox_archives";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_inbox_archives"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_labels";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_labels"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_read_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_read_states";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_read_states"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_recovery_actions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_recovery_actions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_reference_mentions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_reference_mentions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_reference_mentions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_relations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_relations";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_relations"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_thread_interactions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_thread_interactions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_tree_hold_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_tree_hold_members";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_tree_hold_members"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_tree_holds";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_tree_holds"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issue_work_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issue_work_products";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issue_work_products"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "issues";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "issues"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "join_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "join_requests";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "join_requests"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "labels";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "labels"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_company_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_company_settings";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_company_settings"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_config";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_config"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_database_namespaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_database_namespaces";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_database_namespaces"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_migrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_migrations";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_migrations"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_entities";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_entities"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_jobs";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_jobs"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_job_runs";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_job_runs"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_logs";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_logs"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_managed_resources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_managed_resources";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_managed_resources"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_state";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_state"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugin_webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugin_webhook_deliveries";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugin_webhook_deliveries"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "plugins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "plugins";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "plugins"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "principal_permission_grants";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "principal_permission_grants"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "project_goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "project_goals";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "project_goals"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "project_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "project_workspaces";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "project_workspaces"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "projects";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "projects"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "routines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "routines";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "routines"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "routine_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "routine_revisions";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "routine_revisions"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "routine_triggers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "routine_triggers";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "routine_triggers"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "routine_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "routine_runs";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "routine_runs"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "secret_access_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "secret_access_events";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "secret_access_events"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "user_sidebar_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "user_sidebar_preferences";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "user_sidebar_preferences"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "workspace_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "workspace_operations";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "workspace_operations"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "paperclip_api_deny_by_default" ON "workspace_runtime_services";--> statement-breakpoint
CREATE POLICY "paperclip_api_deny_by_default" ON "workspace_runtime_services"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);
