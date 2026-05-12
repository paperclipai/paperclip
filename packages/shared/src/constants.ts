export const COMPANY_STATUSES = ["active", "paused", "archived"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_COMPANY_ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;

export const DEPLOYMENT_MODES = ["local_trusted", "authenticated"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const DEPLOYMENT_EXPOSURES = ["private", "public"] as const;
export type DeploymentExposure = (typeof DEPLOYMENT_EXPOSURES)[number];

export const BIND_MODES = ["loopback", "lan", "tailnet", "custom"] as const;
export type BindMode = (typeof BIND_MODES)[number];

export const AUTH_BASE_URL_MODES = ["auto", "explicit"] as const;
export type AuthBaseUrlMode = (typeof AUTH_BASE_URL_MODES)[number];

export const AGENT_STATUSES = [
  "active",
  "paused",
  "idle",
  "running",
  "error",
  "pending_approval",
  "terminated",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_ADAPTER_TYPES = [
  "process",
  "http",
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor_cloud",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "openclaw_gateway",
] as const;
export type AgentAdapterType = (typeof AGENT_ADAPTER_TYPES)[number] | (string & {});

export const AGENT_ROLES = [
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "security",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "general",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  cfo: "CFO",
  security: "Security",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  general: "General",
};

export const AGENT_DEFAULT_MAX_CONCURRENT_RUNS = 20;
export const WORKSPACE_BRANCH_ROUTINE_VARIABLE = "workspaceBranch";

export const MODEL_PROFILE_KEYS = ["cheap"] as const;
export type ModelProfileKey = (typeof MODEL_PROFILE_KEYS)[number];

export const AGENT_ICON_NAMES = [
  "bot",
  "cpu",
  "brain",
  "zap",
  "rocket",
  "code",
  "terminal",
  "shield",
  "eye",
  "search",
  "wrench",
  "hammer",
  "lightbulb",
  "sparkles",
  "star",
  "heart",
  "flame",
  "bug",
  "cog",
  "database",
  "globe",
  "lock",
  "mail",
  "message-square",
  "file-code",
  "git-branch",
  "package",
  "puzzle",
  "target",
  "wand",
  "atom",
  "circuit-board",
  "radar",
  "swords",
  "telescope",
  "microscope",
  "crown",
  "gem",
  "hexagon",
  "pentagon",
  "fingerprint",
] as const;
export type AgentIconName = (typeof AGENT_ICON_NAMES)[number];

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const INBOX_MINE_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
] as const;
export const INBOX_MINE_ISSUE_STATUS_FILTER = INBOX_MINE_ISSUE_STATUSES.join(",");

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];
export const ISSUE_WORK_MODES = ["standard", "planning"] as const;
export type IssueWorkMode = (typeof ISSUE_WORK_MODES)[number];
export const MAX_ISSUE_REQUEST_DEPTH = 1024;

export const ISSUE_COMMENT_AUTHOR_TYPES = ["user", "agent", "system"] as const;
export type IssueCommentAuthorType = (typeof ISSUE_COMMENT_AUTHOR_TYPES)[number];

export const ISSUE_COMMENT_PRESENTATION_KINDS = ["message", "system_notice"] as const;
export type IssueCommentPresentationKind = (typeof ISSUE_COMMENT_PRESENTATION_KINDS)[number];

export const ISSUE_COMMENT_PRESENTATION_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type IssueCommentPresentationTone = (typeof ISSUE_COMMENT_PRESENTATION_TONES)[number];

export const ISSUE_COMMENT_METADATA_ROW_TYPES = [
  "text",
  "code",
  "key_value",
  "issue_link",
  "agent_link",
  "run_link",
] as const;
export type IssueCommentMetadataRowType = (typeof ISSUE_COMMENT_METADATA_ROW_TYPES)[number];

export function clampIssueRequestDepth(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_ISSUE_REQUEST_DEPTH, Math.max(0, Math.floor(value)));
}

export const ISSUE_THREAD_INTERACTION_KINDS = [
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
] as const;
export type IssueThreadInteractionKind = (typeof ISSUE_THREAD_INTERACTION_KINDS)[number];

export const ISSUE_THREAD_INTERACTION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "answered",
  "cancelled",
  "expired",
  "failed",
] as const;
export type IssueThreadInteractionStatus = (typeof ISSUE_THREAD_INTERACTION_STATUSES)[number];

export const ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES = [
  "none",
  "wake_assignee",
  "wake_assignee_on_accept",
] as const;
export type IssueThreadInteractionContinuationPolicy =
  (typeof ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES)[number];

export const ISSUE_ORIGIN_KINDS = [
  "manual",
  "routine_execution",
  "stale_active_run_evaluation",
  "harness_liveness_escalation",
  "issue_productivity_review",
  "stranded_issue_recovery",
] as const;
export type BuiltInIssueOriginKind = (typeof ISSUE_ORIGIN_KINDS)[number];
export type PluginIssueOriginKind = `plugin:${string}`;
export type IssueOriginKind = BuiltInIssueOriginKind | PluginIssueOriginKind;
export const ISSUE_SURFACE_VISIBILITIES = ["default", "plugin_operation"] as const;
export type IssueSurfaceVisibility = (typeof ISSUE_SURFACE_VISIBILITIES)[number];

export const ISSUE_RECOVERY_ACTION_KINDS = [
  "missing_disposition",
  "stranded_assigned_issue",
  "active_run_watchdog",
  "issue_graph_liveness",
] as const;
export type IssueRecoveryActionKind = (typeof ISSUE_RECOVERY_ACTION_KINDS)[number];

export const ISSUE_RECOVERY_ACTION_STATUSES = [
  "active",
  "escalated",
  "resolved",
  "cancelled",
] as const;
export type IssueRecoveryActionStatus = (typeof ISSUE_RECOVERY_ACTION_STATUSES)[number];

export const ISSUE_RECOVERY_ACTION_OWNER_TYPES = [
  "agent",
  "user",
  "board",
  "system",
] as const;
export type IssueRecoveryActionOwnerType = (typeof ISSUE_RECOVERY_ACTION_OWNER_TYPES)[number];

export const ISSUE_RECOVERY_ACTION_OUTCOMES = [
  "restored",
  "delegated",
  "false_positive",
  "blocked",
  "escalated",
  "cancelled",
] as const;
export type IssueRecoveryActionOutcome = (typeof ISSUE_RECOVERY_ACTION_OUTCOMES)[number];

export function pluginOperationIssueOriginKind(pluginKey: string): PluginIssueOriginKind {
  return `plugin:${pluginKey}:operation`;
}

export function isPluginOperationIssueOriginKind(originKind: string | null | undefined): boolean {
  return typeof originKind === "string" && /^plugin:[^:]+:operation(?::|$)/.test(originKind);
}

export const ISSUE_RELATION_TYPES = ["blocks"] as const;
export type IssueRelationType = (typeof ISSUE_RELATION_TYPES)[number];

export const ISSUE_TREE_CONTROL_MODES = ["pause", "resume", "cancel", "restore"] as const;
export type IssueTreeControlMode = (typeof ISSUE_TREE_CONTROL_MODES)[number];

export const ISSUE_TREE_HOLD_STATUSES = ["active", "released"] as const;
export type IssueTreeHoldStatus = (typeof ISSUE_TREE_HOLD_STATUSES)[number];

export const ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES = ["manual", "after_active_runs_finish"] as const;
export type IssueTreeHoldReleasePolicyStrategy = (typeof ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES)[number];

export const ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY = "continuation-summary" as const;
export const SYSTEM_ISSUE_DOCUMENT_KEYS = [ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY] as const;
export type SystemIssueDocumentKey = (typeof SYSTEM_ISSUE_DOCUMENT_KEYS)[number];

const SYSTEM_ISSUE_DOCUMENT_KEY_SET = new Set<string>(SYSTEM_ISSUE_DOCUMENT_KEYS);

export function isSystemIssueDocumentKey(key: string): key is SystemIssueDocumentKey {
  return SYSTEM_ISSUE_DOCUMENT_KEY_SET.has(key);
}
export const ISSUE_REFERENCE_SOURCE_KINDS = ["title", "description", "comment", "document"] as const;
export type IssueReferenceSourceKind = (typeof ISSUE_REFERENCE_SOURCE_KINDS)[number];

export const ISSUE_EXECUTION_POLICY_MODES = ["normal", "auto"] as const;
export type IssueExecutionPolicyMode = (typeof ISSUE_EXECUTION_POLICY_MODES)[number];

export const ISSUE_EXECUTION_STAGE_TYPES = ["review", "approval"] as const;
export type IssueExecutionStageType = (typeof ISSUE_EXECUTION_STAGE_TYPES)[number];

export const ISSUE_MONITOR_SCHEDULED_BY = ["assignee", "board"] as const;
export type IssueMonitorScheduledBy = (typeof ISSUE_MONITOR_SCHEDULED_BY)[number];

export const ISSUE_EXECUTION_MONITOR_KINDS = ["external_service"] as const;
export type IssueExecutionMonitorKind = (typeof ISSUE_EXECUTION_MONITOR_KINDS)[number];

export const ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES = [
  "wake_owner",
  "create_recovery_issue",
  "escalate_to_board",
] as const;
export type IssueExecutionMonitorRecoveryPolicy =
  (typeof ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES)[number];

export const ISSUE_EXECUTION_STATE_STATUSES = ["idle", "pending", "changes_requested", "completed"] as const;
export type IssueExecutionStateStatus = (typeof ISSUE_EXECUTION_STATE_STATUSES)[number];

export const ISSUE_EXECUTION_MONITOR_STATE_STATUSES = ["scheduled", "triggered", "cleared"] as const;
export type IssueExecutionMonitorStateStatus = (typeof ISSUE_EXECUTION_MONITOR_STATE_STATUSES)[number];

export const ISSUE_EXECUTION_MONITOR_CLEAR_REASONS = [
  "manual",
  "triggered",
  "done",
  "cancelled",
  "invalid_status",
  "invalid_assignee",
  "dispatch_skipped",
  "timeout_exceeded",
  "max_attempts_exhausted",
] as const;
export type IssueExecutionMonitorClearReason = (typeof ISSUE_EXECUTION_MONITOR_CLEAR_REASONS)[number];

export const ISSUE_EXECUTION_DECISION_OUTCOMES = ["approved", "changes_requested"] as const;
export type IssueExecutionDecisionOutcome = (typeof ISSUE_EXECUTION_DECISION_OUTCOMES)[number];

export const GOAL_LEVELS = ["company", "team", "agent", "task"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];

export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ENVIRONMENT_DRIVERS = ["local", "ssh", "sandbox", "plugin"] as const;
export type EnvironmentDriver = (typeof ENVIRONMENT_DRIVERS)[number];

export const ENVIRONMENT_STATUSES = ["active", "archived"] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export const ENVIRONMENT_LEASE_STATUSES = ["active", "released", "expired", "failed", "retained"] as const;
export type EnvironmentLeaseStatus = (typeof ENVIRONMENT_LEASE_STATUSES)[number];

export const ENVIRONMENT_LEASE_POLICIES = [
  "ephemeral",
  "reuse_by_environment",
  "reuse_by_execution_workspace",
  "retain_on_failure",
] as const;
export type EnvironmentLeasePolicy = (typeof ENVIRONMENT_LEASE_POLICIES)[number];

export const ENVIRONMENT_LEASE_CLEANUP_STATUSES = ["pending", "success", "failed"] as const;
export type EnvironmentLeaseCleanupStatus = (typeof ENVIRONMENT_LEASE_CLEANUP_STATUSES)[number];

export const ROUTINE_STATUSES = ["active", "paused", "archived"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

export const ROUTINE_CONCURRENCY_POLICIES = ["coalesce_if_active", "always_enqueue", "skip_if_active"] as const;
export type RoutineConcurrencyPolicy = (typeof ROUTINE_CONCURRENCY_POLICIES)[number];

export const ROUTINE_CATCH_UP_POLICIES = ["skip_missed", "enqueue_missed_with_cap"] as const;
export type RoutineCatchUpPolicy = (typeof ROUTINE_CATCH_UP_POLICIES)[number];

export const ROUTINE_TRIGGER_KINDS = ["schedule", "webhook", "api"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

export const ROUTINE_TRIGGER_SIGNING_MODES = ["bearer", "hmac_sha256", "github_hmac", "none"] as const;
export type RoutineTriggerSigningMode = (typeof ROUTINE_TRIGGER_SIGNING_MODES)[number];

export const ROUTINE_VARIABLE_TYPES = ["text", "textarea", "number", "boolean", "select"] as const;
export type RoutineVariableType = (typeof ROUTINE_VARIABLE_TYPES)[number];

export const ROUTINE_RUN_STATUSES = [
  "received",
  "coalesced",
  "skipped",
  "issue_created",
  "completed",
  "failed",
 ] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

export const ROUTINE_RUN_SOURCES = ["schedule", "manual", "api", "webhook"] as const;
export type RoutineRunSource = (typeof ROUTINE_RUN_SOURCES)[number];

export const PAUSE_REASONS = ["manual", "budget", "system"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const PROJECT_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
] as const;

export const APPROVAL_TYPES = [
  "hire_agent",
  "approve_ceo_strategy",
  "budget_override_required",
  "request_board_approval",
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "revision_requested",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const SECRET_PROVIDERS = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export const SECRET_PROVIDER_CONFIG_STATUSES = [
  "ready",
  "warning",
  "coming_soon",
  "disabled",
] as const;
export type SecretProviderConfigStatus = (typeof SECRET_PROVIDER_CONFIG_STATUSES)[number];

export const SECRET_PROVIDER_CONFIG_HEALTH_STATUSES = [
  "ready",
  "warning",
  "error",
  "coming_soon",
  "disabled",
] as const;
export type SecretProviderConfigHealthStatus =
  (typeof SECRET_PROVIDER_CONFIG_HEALTH_STATUSES)[number];

export const SECRET_STATUSES = ["active", "disabled", "archived", "deleted"] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

export const SECRET_MANAGED_MODES = ["paperclip_managed", "external_reference"] as const;
export type SecretManagedMode = (typeof SECRET_MANAGED_MODES)[number];

export const SECRET_VERSION_STATUSES = [
  "current",
  "previous",
  "disabled",
  "destroyed",
  "failed",
] as const;
export type SecretVersionStatus = (typeof SECRET_VERSION_STATUSES)[number];

export const SECRET_BINDING_TARGET_TYPES = [
  "agent",
  "project",
  "environment",
  "routine",
  "plugin",
  "issue",
  "run",
  "system",
] as const;
export type SecretBindingTargetType = (typeof SECRET_BINDING_TARGET_TYPES)[number];

export const SECRET_ACCESS_OUTCOMES = ["success", "failure"] as const;
export type SecretAccessOutcome = (typeof SECRET_ACCESS_OUTCOMES)[number];

export const STORAGE_PROVIDERS = ["local_disk", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const BILLING_TYPES = [
  "metered_api",
  "subscription_included",
  "subscription_overage",
  "credits",
  "fixed",
  "unknown",
] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const FINANCE_EVENT_KINDS = [
  "inference_charge",
  "platform_fee",
  "credit_purchase",
  "credit_refund",
  "credit_expiry",
  "byok_fee",
  "gateway_overhead",
  "log_storage_charge",
  "logpush_charge",
  "provisioned_capacity_charge",
  "training_charge",
  "custom_model_import_charge",
  "custom_model_storage_charge",
  "manual_adjustment",
] as const;
export type FinanceEventKind = (typeof FINANCE_EVENT_KINDS)[number];

export const FINANCE_DIRECTIONS = ["debit", "credit"] as const;
export type FinanceDirection = (typeof FINANCE_DIRECTIONS)[number];

export const FINANCE_UNITS = [
  "input_token",
  "output_token",
  "cached_input_token",
  "request",
  "credit_usd",
  "credit_unit",
  "model_unit_minute",
  "model_unit_hour",
  "gb_month",
  "train_token",
  "unknown",
] as const;
export type FinanceUnit = (typeof FINANCE_UNITS)[number];

export const BUDGET_SCOPE_TYPES = ["company", "agent", "project"] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export const BUDGET_METRICS = ["billed_cents"] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export const BUDGET_WINDOW_KINDS = ["calendar_month_utc", "lifetime"] as const;
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number];

export const BUDGET_THRESHOLD_TYPES = ["soft", "hard"] as const;
export type BudgetThresholdType = (typeof BUDGET_THRESHOLD_TYPES)[number];

export const BUDGET_INCIDENT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type BudgetIncidentStatus = (typeof BUDGET_INCIDENT_STATUSES)[number];

export const BUDGET_INCIDENT_RESOLUTION_ACTIONS = [
  "keep_paused",
  "raise_budget_and_resume",
] as const;
export type BudgetIncidentResolutionAction = (typeof BUDGET_INCIDENT_RESOLUTION_ACTIONS)[number];

export const HEARTBEAT_INVOCATION_SOURCES = [
  "timer",
  "assignment",
  "on_demand",
  "automation",
] as const;
export type HeartbeatInvocationSource = (typeof HEARTBEAT_INVOCATION_SOURCES)[number];

export const WAKEUP_TRIGGER_DETAILS = ["manual", "ping", "callback", "system"] as const;
export type WakeupTriggerDetail = (typeof WAKEUP_TRIGGER_DETAILS)[number];

export const WAKEUP_REQUEST_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "coalesced",
  "skipped",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WakeupRequestStatus = (typeof WAKEUP_REQUEST_STATUSES)[number];

export const HEARTBEAT_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type HeartbeatRunStatus = (typeof HEARTBEAT_RUN_STATUSES)[number];

export const RUN_LIVENESS_STATES = [
  "completed",
  "advanced",
  "plan_only",
  "empty_response",
  "blocked",
  "failed",
  "needs_followup",
] as const;
export type RunLivenessState = (typeof RUN_LIVENESS_STATES)[number];

export const LIVE_EVENT_TYPES = [
  "heartbeat.run.queued",
  "heartbeat.run.status",
  "heartbeat.run.event",
  "heartbeat.run.log",
  "agent.status",
  "activity.logged",
  "plugin.ui.updated",
  "plugin.worker.crashed",
  "plugin.worker.restarted",
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export const PRINCIPAL_TYPES = ["user", "agent"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const MEMBERSHIP_STATUSES = ["pending", "active", "suspended", "archived"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const COMPANY_MEMBERSHIP_ROLES = [
  "owner",
  "admin",
  "operator",
  "viewer",
  "member",
] as const;
export type CompanyMembershipRole = (typeof COMPANY_MEMBERSHIP_ROLES)[number];

export const HUMAN_COMPANY_MEMBERSHIP_ROLES = [
  "owner",
  "admin",
  "operator",
  "viewer",
] as const;
export type HumanCompanyMembershipRole = (typeof HUMAN_COMPANY_MEMBERSHIP_ROLES)[number];

export const HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS: Record<HumanCompanyMembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

export const INSTANCE_USER_ROLES = ["instance_admin"] as const;
export type InstanceUserRole = (typeof INSTANCE_USER_ROLES)[number];

export const INVITE_TYPES = ["company_join", "bootstrap_ceo"] as const;
export type InviteType = (typeof INVITE_TYPES)[number];

export const INVITE_JOIN_TYPES = ["human", "agent", "both"] as const;
export type InviteJoinType = (typeof INVITE_JOIN_TYPES)[number];

export const JOIN_REQUEST_TYPES = ["human", "agent"] as const;
export type JoinRequestType = (typeof JOIN_REQUEST_TYPES)[number];

export const JOIN_REQUEST_STATUSES = ["pending_approval", "approved", "rejected"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const PERMISSION_KEYS = [
  "agents:create",
  "environments:manage",
  "users:invite",
  "users:manage_permissions",
  "tasks:assign",
  "tasks:assign_scope",
  "tasks:manage_active_checkouts",
  "joins:approve",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// ---------------------------------------------------------------------------
// Plugin System — see doc/plugins/PLUGIN_SPEC.md for the full specification
// ---------------------------------------------------------------------------

/**
 * The current version of the Plugin API contract.
 *
 * Increment this value whenever a breaking change is made to the plugin API
 * so that the host can reject incompatible plugin manifests.
 *
 * @see PLUGIN_SPEC.md §4 — Versioning
 */
export const PLUGIN_API_VERSION = 1 as const;

/**
 * Lifecycle statuses for an installed plugin.
 *
 * State machine: installed → ready | error, ready → disabled | error | upgrade_pending | uninstalled,
 * disabled → ready | uninstalled, error → ready | uninstalled,
 * upgrade_pending → ready | error | uninstalled, uninstalled → installed (reinstall).
 *
 * @see {@link PluginStatus} — inferred union type
 * @see PLUGIN_SPEC.md §21.3 `plugins.status`
 */
export const PLUGIN_STATUSES = [
  "installed",
  "ready",
  "disabled",
  "error",
  "upgrade_pending",
  "uninstalled",
] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/**
 * Plugin classification categories. A plugin declares one or more categories
 * in its manifest to describe its primary purpose.
 *
 * @see PLUGIN_SPEC.md §6.2
 */
export const PLUGIN_CATEGORIES = [
  "connector",
  "workspace",
  "automation",
  "ui",
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/**
 * Named permissions the host grants to a plugin. Plugins declare required
 * capabilities in their manifest; the host enforces them at runtime via the
 * plugin capability validator.
 *
 * Grouped into: Data Read, Data Write, Plugin State, Runtime/Integration,
 * Agent Tools, and UI.
 *
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */
export const PLUGIN_CAPABILITIES = [
  // Data Read
  "companies.read",
  "projects.read",
  "project.workspaces.read",
  "issues.read",
  "issue.relations.read",
  "issue.subtree.read",
  "issue.comments.read",
  "issue.documents.read",
  "agents.read",
  "goals.read",
  "goals.create",
  "goals.update",
  "activity.read",
  "costs.read",
  "issues.orchestration.read",
  "database.namespace.read",
  // Data Write
  "issues.create",
  "issues.update",
  "issue.relations.write",
  "issues.checkout",
  "issues.wakeup",
  "issue.comments.create",
  "issue.interactions.create",
  "issue.documents.write",
  "projects.managed",
  "routines.managed",
  "skills.managed",
  "agents.pause",
  "agents.resume",
  "agents.invoke",
  "agents.managed",
  "agent.sessions.create",
  "agent.sessions.list",
  "agent.sessions.send",
  "agent.sessions.close",
  "activity.log.write",
  "metrics.write",
  "telemetry.track",
  "database.namespace.migrate",
  "database.namespace.write",
  // Plugin State
  "plugin.state.read",
  "plugin.state.write",
  // Runtime / Integration
  "events.subscribe",
  "events.emit",
  "jobs.schedule",
  "webhooks.receive",
  "api.routes.register",
  "http.outbound",
  "secrets.read-ref",
  "environment.drivers.register",
  "local.folders",
  // Agent Tools
  "agent.tools.register",
  // UI
  "instance.settings.register",
  "ui.sidebar.register",
  "ui.page.register",
  "ui.detailTab.register",
  "ui.dashboardWidget.register",
  "ui.commentAnnotation.register",
  "ui.action.register",
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export const PLUGIN_DATABASE_NAMESPACE_MODES = ["schema"] as const;
export type PluginDatabaseNamespaceMode = (typeof PLUGIN_DATABASE_NAMESPACE_MODES)[number];

export const PLUGIN_DATABASE_NAMESPACE_STATUSES = [
  "active",
  "migration_failed",
] as const;
export type PluginDatabaseNamespaceStatus = (typeof PLUGIN_DATABASE_NAMESPACE_STATUSES)[number];

export const PLUGIN_DATABASE_MIGRATION_STATUSES = [
  "applied",
  "failed",
] as const;
export type PluginDatabaseMigrationStatus = (typeof PLUGIN_DATABASE_MIGRATION_STATUSES)[number];

export const PLUGIN_DATABASE_CORE_READ_TABLES = [
  "companies",
  "projects",
  "goals",
  "agents",
  "issues",
  "issue_documents",
  "issue_relations",
  "issue_comments",
  "heartbeat_runs",
  "cost_events",
  "approvals",
  "issue_approvals",
  "budget_incidents",
] as const;
export type PluginDatabaseCoreReadTable = (typeof PLUGIN_DATABASE_CORE_READ_TABLES)[number];

export const PLUGIN_API_ROUTE_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export type PluginApiRouteMethod = (typeof PLUGIN_API_ROUTE_METHODS)[number];

export const PLUGIN_API_ROUTE_AUTH_MODES = ["board", "agent", "board-or-agent", "webhook"] as const;
export type PluginApiRouteAuthMode = (typeof PLUGIN_API_ROUTE_AUTH_MODES)[number];

export const PLUGIN_API_ROUTE_CHECKOUT_POLICIES = [
  "none",
  "required-for-agent-in-progress",
  "always-for-agent",
] as const;
export type PluginApiRouteCheckoutPolicy = (typeof PLUGIN_API_ROUTE_CHECKOUT_POLICIES)[number];

/**
 * UI extension slot types. Each slot type corresponds to a mount point in the
 * Paperclip UI where plugin components can be rendered.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export const PLUGIN_UI_SLOT_TYPES = [
  "page",
  "detailTab",
  "taskDetailView",
  "dashboardWidget",
  "sidebar",
  "routeSidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "globalToolbarButton",
  "toolbarButton",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "settingsPage",
] as const;
export type PluginUiSlotType = (typeof PLUGIN_UI_SLOT_TYPES)[number];

/**
 * Reserved company-scoped route segments that plugin page routes may not claim.
 *
 * These map to first-class host pages under `/:companyPrefix/...`.
 */
export const PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS = [
  "dashboard",
  "onboarding",
  "companies",
  "company",
  "settings",
  "plugins",
  "org",
  "agents",
  "projects",
  "issues",
  "goals",
  "approvals",
  "costs",
  "activity",
  "inbox",
  "design-guide",
  "tests",
] as const;
export type PluginReservedCompanyRouteSegment =
  (typeof PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS)[number];

/**
 * Launcher placement zones describe where a plugin-owned launcher can appear
 * in the host UI. These are intentionally aligned with current slot surfaces
 * so manifest authors can describe launch intent without coupling to a single
 * component implementation detail.
 */
export const PLUGIN_LAUNCHER_PLACEMENT_ZONES = [
  "page",
  "detailTab",
  "taskDetailView",
  "dashboardWidget",
  "sidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "globalToolbarButton",
  "toolbarButton",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "settingsPage",
] as const;
export type PluginLauncherPlacementZone = (typeof PLUGIN_LAUNCHER_PLACEMENT_ZONES)[number];

/**
 * Launcher action kinds describe what the launcher does when activated.
 */
export const PLUGIN_LAUNCHER_ACTIONS = [
  "navigate",
  "openModal",
  "openDrawer",
  "openPopover",
  "performAction",
  "deepLink",
] as const;
export type PluginLauncherAction = (typeof PLUGIN_LAUNCHER_ACTIONS)[number];

/**
 * Optional size hints the host can use when rendering plugin-owned launcher
 * destinations such as overlays, drawers, or full page handoffs.
 */
export const PLUGIN_LAUNCHER_BOUNDS = [
  "inline",
  "compact",
  "default",
  "wide",
  "full",
] as const;
export type PluginLauncherBounds = (typeof PLUGIN_LAUNCHER_BOUNDS)[number];

/**
 * Render environments describe the container a launcher expects after it is
 * activated. The current host may map these to concrete UI primitives.
 */
export const PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS = [
  "hostInline",
  "hostOverlay",
  "hostRoute",
  "external",
  "iframe",
] as const;
export type PluginLauncherRenderEnvironment =
  (typeof PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS)[number];

/**
 * Entity types that a `detailTab` UI slot can attach to.
 *
 * @see PLUGIN_SPEC.md §19.3 — Detail Tabs
 */
export const PLUGIN_UI_SLOT_ENTITY_TYPES = [
  "project",
  "issue",
  "agent",
  "goal",
  "run",
  "comment",
] as const;
export type PluginUiSlotEntityType = (typeof PLUGIN_UI_SLOT_ENTITY_TYPES)[number];

/**
 * Scope kinds for plugin state storage. Determines the granularity at which
 * a plugin stores key-value state data.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_state.scope_kind`
 */
export const PLUGIN_STATE_SCOPE_KINDS = [
  "instance",
  "company",
  "project",
  "project_workspace",
  "agent",
  "issue",
  "goal",
  "run",
] as const;
export type PluginStateScopeKind = (typeof PLUGIN_STATE_SCOPE_KINDS)[number];

/** Statuses for a plugin's scheduled job definition. */
export const PLUGIN_JOB_STATUSES = [
  "active",
  "paused",
  "failed",
] as const;
export type PluginJobStatus = (typeof PLUGIN_JOB_STATUSES)[number];

/** Statuses for individual job run executions. */
export const PLUGIN_JOB_RUN_STATUSES = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PluginJobRunStatus = (typeof PLUGIN_JOB_RUN_STATUSES)[number];

/** What triggered a particular job run. */
export const PLUGIN_JOB_RUN_TRIGGERS = [
  "schedule",
  "manual",
  "retry",
] as const;
export type PluginJobRunTrigger = (typeof PLUGIN_JOB_RUN_TRIGGERS)[number];

/** Statuses for inbound webhook deliveries. */
export const PLUGIN_WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "success",
  "failed",
] as const;
export type PluginWebhookDeliveryStatus = (typeof PLUGIN_WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Core domain event types that plugins can subscribe to via the
 * `events.subscribe` capability.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 */
export const PLUGIN_EVENT_TYPES = [
  "company.created",
  "company.updated",
  "project.created",
  "project.updated",
  "project.workspace_created",
  "project.workspace_updated",
  "project.workspace_deleted",
  "issue.created",
  "issue.updated",
  "issue.comment.created",
  "issue.document.created",
  "issue.document.updated",
  "issue.document.deleted",
  "issue.relations.updated",
  "issue.checked_out",
  "issue.released",
  "issue.assignment_wakeup_requested",
  "agent.created",
  "agent.updated",
  "agent.status_changed",
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
  "goal.created",
  "goal.updated",
  "approval.created",
  "approval.decided",
  "budget.incident.opened",
  "budget.incident.resolved",
  "cost_event.created",
  "activity.logged",
] as const;
export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

/**
 * Error codes returned by the plugin bridge when a UI → worker call fails.
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export const PLUGIN_BRIDGE_ERROR_CODES = [
  "WORKER_UNAVAILABLE",
  "CAPABILITY_DENIED",
  "WORKER_ERROR",
  "TIMEOUT",
  "UNKNOWN",
] as const;
export type PluginBridgeErrorCode = (typeof PLUGIN_BRIDGE_ERROR_CODES)[number];
