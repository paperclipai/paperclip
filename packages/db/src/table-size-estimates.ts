export type TableSizeBucket = "large" | "medium" | "small";

export type LocalTableRowCount = {
  readonly table: string;
  readonly localRows: number;
};

export type TableSizeEstimate = LocalTableRowCount & {
  readonly estimateFactor: number;
  readonly estimatedRows: number;
  readonly bucket: TableSizeBucket;
};

export const TABLE_SIZE_ESTIMATE_SOURCE = {
  collectedAt: "2026-07-06",
  database: "default local dev embedded Postgres",
  method: "SELECT count(*) in a read-only transaction",
} as const;

export const TABLE_SIZE_ESTIMATE_FACTOR = 250;

export const TABLE_SIZE_BUCKET_THRESHOLDS = {
  largeRows: 1_000_000,
  mediumRows: 100_000,
} as const;

export const LOCAL_TABLE_ROW_COUNTS = [
  { table: "agent_wakeup_requests", localRows: 52_791 },
  { table: "activity_log", localRows: 22_930 },
  { table: "issue_reference_mentions", localRows: 13_218 },
  { table: "heartbeat_run_events", localRows: 10_833 },
  { table: "issue_comments", localRows: 5_034 },
  { table: "document_revisions", localRows: 3_906 },
  { table: "heartbeat_runs", localRows: 3_620 },
  { table: "workspace_operations", localRows: 3_600 },
  { table: "environment_leases", localRows: 3_492 },
  { table: "cost_events", localRows: 3_330 },
  { table: "agent_task_sessions", localRows: 1_743 },
  { table: "documents", localRows: 1_692 },
  { table: "issue_documents", localRows: 1_678 },
  { table: "issues", localRows: 1_609 },
  { table: "secret_access_events", localRows: 933 },
  { table: "issue_read_states", localRows: 608 },
  { table: "issue_thread_interactions", localRows: 455 },
  { table: "issue_relations", localRows: 445 },
  { table: "execution_workspaces", localRows: 414 },
  { table: "agent_config_revisions", localRows: 145 },
  { table: "document_annotation_anchor_snapshots", localRows: 132 },
  { table: "document_annotation_comments", localRows: 122 },
  { table: "document_annotation_threads", localRows: 80 },
  { table: "routine_revisions", localRows: 64 },
  { table: "issue_tree_hold_members", localRows: 62 },
  { table: "routine_runs", localRows: 52 },
  { table: "issue_recovery_actions", localRows: 50 },
  { table: "assets", localRows: 46 },
  { table: "issue_attachments", localRows: 44 },
  { table: "principal_permission_grants", localRows: 25 },
  { table: "company_memberships", localRows: 19 },
  { table: "agent_runtime_state", localRows: 18 },
  { table: "agents", localRows: 18 },
  { table: "routine_triggers", localRows: 16 },
  { table: "company_skills", localRows: 15 },
  { table: "routine_documents", localRows: 14 },
  { table: "routines", localRows: 14 },
  { table: "issue_inbox_archives", localRows: 13 },
  { table: "issue_approvals", localRows: 12 },
  { table: "company_secret_bindings", localRows: 11 },
  { table: "issue_tree_holds", localRows: 10 },
  { table: "approvals", localRows: 9 },
  { table: "session", localRows: 9 },
  { table: "issue_work_products", localRows: 7 },
  { table: "company_skill_versions", localRows: 6 },
  { table: "feedback_exports", localRows: 6 },
  { table: "feedback_votes", localRows: 6 },
  { table: "issue_execution_decisions", localRows: 6 },
  { table: "company_secret_versions", localRows: 3 },
  { table: "company_secrets", localRows: 3 },
  { table: "projects", localRows: 3 },
  { table: "approval_comments", localRows: 2 },
  { table: "goals", localRows: 2 },
  { table: "project_goals", localRows: 2 },
  { table: "project_workspaces", localRows: 2 },
  { table: "account", localRows: 1 },
  { table: "companies", localRows: 1 },
  { table: "environments", localRows: 1 },
  { table: "instance_settings", localRows: 1 },
  { table: "instance_user_roles", localRows: 1 },
  { table: "user", localRows: 1 },
  { table: "agent_api_keys", localRows: 0 },
  { table: "agent_memberships", localRows: 0 },
  { table: "board_api_keys", localRows: 0 },
  { table: "budget_incidents", localRows: 0 },
  { table: "budget_policies", localRows: 0 },
  { table: "cli_auth_challenges", localRows: 0 },
  { table: "cloud_upstream_connections", localRows: 0 },
  { table: "cloud_upstream_runs", localRows: 0 },
  { table: "company_logos", localRows: 0 },
  { table: "company_secret_provider_configs", localRows: 0 },
  { table: "company_skill_comments", localRows: 0 },
  { table: "company_skill_stars", localRows: 0 },
  { table: "company_user_sidebar_preferences", localRows: 0 },
  { table: "environment_custom_image_setup_sessions", localRows: 0 },
  { table: "environment_custom_image_templates", localRows: 0 },
  { table: "external_object_mentions", localRows: 0 },
  { table: "external_objects", localRows: 0 },
  { table: "finance_events", localRows: 0 },
  { table: "heartbeat_run_watchdog_decisions", localRows: 0 },
  { table: "inbox_dismissals", localRows: 0 },
  { table: "invites", localRows: 0 },
  { table: "issue_labels", localRows: 0 },
  { table: "issue_plan_decompositions", localRows: 0 },
  { table: "issue_watchdogs", localRows: 0 },
  { table: "join_requests", localRows: 0 },
  { table: "labels", localRows: 0 },
  { table: "pipeline_automation_executions", localRows: 0 },
  { table: "pipeline_case_blockers", localRows: 0 },
  { table: "pipeline_case_documents", localRows: 0 },
  { table: "pipeline_case_events", localRows: 0 },
  { table: "pipeline_case_issue_links", localRows: 0 },
  { table: "pipeline_cases", localRows: 0 },
  { table: "pipeline_documents", localRows: 0 },
  { table: "pipeline_stages", localRows: 0 },
  { table: "pipeline_transitions", localRows: 0 },
  { table: "pipelines", localRows: 0 },
  { table: "plugin_company_settings", localRows: 0 },
  { table: "plugin_config", localRows: 0 },
  { table: "plugin_database_namespaces", localRows: 0 },
  { table: "plugin_entities", localRows: 0 },
  { table: "plugin_job_runs", localRows: 0 },
  { table: "plugin_jobs", localRows: 0 },
  { table: "plugin_logs", localRows: 0 },
  { table: "plugin_managed_resources", localRows: 0 },
  { table: "plugin_migrations", localRows: 0 },
  { table: "plugin_state", localRows: 0 },
  { table: "plugin_webhook_deliveries", localRows: 0 },
  { table: "plugins", localRows: 0 },
  { table: "project_memberships", localRows: 0 },
  { table: "user_secret_declarations", localRows: 0 },
  { table: "user_secret_definitions", localRows: 0 },
  { table: "user_sidebar_preferences", localRows: 0 },
  { table: "verification", localRows: 0 },
  { table: "workspace_runtime_services", localRows: 0 },
] as const satisfies readonly LocalTableRowCount[];

function bucketForEstimatedRows(estimatedRows: number): TableSizeBucket {
  if (estimatedRows >= TABLE_SIZE_BUCKET_THRESHOLDS.largeRows) return "large";
  if (estimatedRows >= TABLE_SIZE_BUCKET_THRESHOLDS.mediumRows) return "medium";
  return "small";
}

export const TABLE_SIZE_ESTIMATES: readonly TableSizeEstimate[] = LOCAL_TABLE_ROW_COUNTS.map(
  ({ table, localRows }) => {
    const estimatedRows = localRows * TABLE_SIZE_ESTIMATE_FACTOR;
    return {
      table,
      localRows,
      estimateFactor: TABLE_SIZE_ESTIMATE_FACTOR,
      estimatedRows,
      bucket: bucketForEstimatedRows(estimatedRows),
    };
  },
);

export const TABLE_SIZE_ESTIMATES_BY_TABLE: ReadonlyMap<string, TableSizeEstimate> = new Map(
  TABLE_SIZE_ESTIMATES.map((estimate) => [estimate.table, estimate]),
);

export function getTableSizeEstimate(table: string): TableSizeEstimate | undefined {
  return TABLE_SIZE_ESTIMATES_BY_TABLE.get(table);
}

export function getTableSizeBucket(table: string): TableSizeBucket {
  return getTableSizeEstimate(table)?.bucket ?? "small";
}

export function isKnownLargeTable(table: string): boolean {
  return getTableSizeBucket(table) === "large";
}
