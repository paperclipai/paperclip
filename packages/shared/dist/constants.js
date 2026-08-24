export const COMPANY_STATUSES = ["active", "paused", "archived"];
export const DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_COMPANY_ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;
export const DEPLOYMENT_MODES = ["local_trusted", "authenticated"];
export const DEPLOYMENT_EXPOSURES = ["private", "public"];
export const BIND_MODES = ["loopback", "lan", "tailnet", "custom"];
export const AUTH_BASE_URL_MODES = ["auto", "explicit"];
export const AGENT_STATUSES = [
    "active",
    "paused",
    "idle",
    "running",
    "error",
    "pending_approval",
    "terminated",
];
export const AGENT_ADAPTER_TYPES = [
    "process",
    "http",
    "claude_local",
    "codex_local",
    "cursor_cloud",
    "gemini_local",
    "grok_local",
    "hermes_gateway",
    "hermes_local",
    "kimi_local",
    "opencode_local",
    "pi_local",
    "cursor",
    "openclaw_gateway",
];
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
    "agent",
];
export const AGENT_ROLE_LABELS = {
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
    agent: "Agent",
};
export const AGENT_DEFAULT_MAX_CONCURRENT_RUNS = 20;
export const WORKSPACE_BRANCH_ROUTINE_VARIABLE = "workspaceBranch";
// Config keys owned by Paperclip/company state rather than one concrete adapter.
// `paperclipSkillSync` is persisted in adapterConfig but must survive adapter swaps.
export const ADAPTER_AGNOSTIC_KEYS = [
    "env",
    "promptTemplate",
    "instructionsFilePath",
    "cwd",
    "timeoutSec",
    "graceSec",
    "bootstrapPromptTemplate",
    "paperclipSkillSync",
];
export const MODEL_PROFILE_KEYS = ["cheap"];
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
];
/**
 * Curated Lucide icon set for projects (PAP-68 part 3).
 *
 * The first entry, `"folder"`, is the default for any project without an
 * explicit icon. The remaining entries reuse much of the agent icon set plus a
 * handful of folder/structure icons that read well at small tile sizes.
 */
export const PROJECT_ICON_NAMES = [
    "folder",
    "rocket",
    "code",
    "terminal",
    "database",
    "globe",
    "package",
    "boxes",
    "box",
    "layers",
    "briefcase",
    "compass",
    "target",
    "flame",
    "zap",
    "star",
    "bug",
    "wrench",
    "hammer",
    "lightbulb",
    "sparkles",
    "shield",
    "lock",
    "search",
    "cog",
    "brain",
    "cpu",
    "git-branch",
    "file-code",
    "puzzle",
    "gem",
    "atom",
    "heart",
    "mail",
    "message-square",
    "crown",
    "radar",
    "telescope",
    "hexagon",
];
export const ISSUE_STATUSES = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "cancelled",
];
export const INBOX_MINE_ISSUE_STATUSES = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
];
export const INBOX_MINE_ISSUE_STATUS_FILTER = INBOX_MINE_ISSUE_STATUSES.join(",");
export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"];
export const ISSUE_REVIEW_POLICIES = ["anyone", "not_creator", "human_only"];
export const ISSUE_WORK_MODES = ["standard", "ask", "planning", "skill_test"];
export const ISSUE_HARNESS_KINDS = ["skill_test"];
export const MAX_ISSUE_REQUEST_DEPTH = 1024;
export const SUMMARY_SLOT_SCOPE_KINDS = [
    "project",
    "workspaces_overview",
    "project_workspace",
    "execution_workspace",
];
export const SUMMARY_SLOT_KEYS = ["header"];
export const SUMMARY_SLOT_STATUSES = ["idle", "generating", "failed"];
export const ISSUE_COMMENT_AUTHOR_TYPES = ["user", "agent", "system"];
export const ISSUE_COMMENT_PRESENTATION_KINDS = ["message", "system_notice"];
export const ISSUE_COMMENT_PRESENTATION_TONES = ["neutral", "info", "success", "warning", "danger"];
export const ISSUE_COMMENT_PRESENTATION_DENSITIES = ["compact"];
export const ISSUE_COMMENT_METADATA_ROW_TYPES = [
    "text",
    "code",
    "key_value",
    "issue_link",
    "agent_link",
    "run_link",
];
export function clampIssueRequestDepth(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return 0;
    return Math.min(MAX_ISSUE_REQUEST_DEPTH, Math.max(0, Math.floor(value)));
}
export const ISSUE_THREAD_INTERACTION_KINDS = [
    "suggest_tasks",
    "ask_user_questions",
    "request_confirmation",
    "request_checkbox_confirmation",
    "request_item_verdicts",
];
export const ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES = [
    "anyone",
    "not_creator",
    "human_only",
];
export const ISSUE_THREAD_INTERACTION_LEGACY_RESOLVER_POLICY_ALIASES = [
    "board_or_agents",
    "board_only",
];
/**
 * Accepted resolver-policy input values. New product surfaces should use the
 * canonical values; the two board-prefixed values remain write-compatible
 * aliases for one migration window.
 */
export const ISSUE_THREAD_INTERACTION_RESOLVER_POLICIES = [
    ...ISSUE_THREAD_INTERACTION_CANONICAL_RESOLVER_POLICIES,
    ...ISSUE_THREAD_INTERACTION_LEGACY_RESOLVER_POLICY_ALIASES,
];
export const ISSUE_THREAD_INTERACTION_RESOLVER_POLICY_PROVENANCES = [
    "explicit",
    "inherited",
    "legacy_inherited_restriction",
];
export const ISSUE_THREAD_INTERACTION_EFFECTIVE_RESOLVER_POLICY_SOURCES = [
    "requested",
    "company_cap",
    "governed_action",
];
export function normalizeIssueThreadInteractionResolverPolicy(policy) {
    if (policy === "board_or_agents")
        return "anyone";
    if (policy === "board_only")
        return "human_only";
    return policy;
}
export function legacyIssueThreadInteractionResolverPolicyAlias(policy) {
    if (policy === "anyone")
        return "board_or_agents";
    if (policy === "human_only")
        return "board_only";
    return null;
}
export const REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT = 200;
export const REQUEST_ITEM_VERDICTS_ITEM_LIMIT = REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT;
export const ISSUE_THREAD_INTERACTION_STATUSES = [
    "pending",
    "accepted",
    "rejected",
    "answered",
    "cancelled",
    "expired",
    "failed",
];
export const ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES = [
    "none",
    "wake_assignee",
    "wake_assignee_on_accept",
];
export const TASK_WATCHDOG_PRODUCT_BUG_ORIGIN_KIND = "task_watchdog_product_bug";
// Marks the single onboarding "first task" so surfaces can special-case it
// (e.g. suppress the seeded-description bubble and rely on a seeded greeting).
export const ONBOARDING_FIRST_TASK_ORIGIN_KIND = "onboarding_first_task";
export const ISSUE_ORIGIN_KINDS = [
    "manual",
    "routine_execution",
    "stale_active_run_evaluation",
    "harness_liveness_escalation",
    "issue_productivity_review",
    "stranded_issue_recovery",
    "task_watchdog",
    TASK_WATCHDOG_PRODUCT_BUG_ORIGIN_KIND,
    ONBOARDING_FIRST_TASK_ORIGIN_KIND,
];
export const ISSUE_WATCHDOG_DISCOVERY_KINDS = ["product_bug", "platform_bug"];
export const ISSUE_SURFACE_VISIBILITIES = ["default", "plugin_operation"];
export const ISSUE_RECOVERY_ACTION_KINDS = [
    "missing_disposition",
    "deliberate_wait_without_target",
    "stranded_assigned_issue",
    "workspace_validation",
    "configuration_validation",
    "active_run_watchdog",
    "issue_graph_liveness",
];
export const ISSUE_DISPOSITION_REPAIR_RETRY_REASON = "issue_disposition_repair";
export const ISSUE_RECOVERY_ACTION_STATUSES = [
    "active",
    "escalated",
    "resolved",
    "cancelled",
];
export const ISSUE_RECOVERY_ACTION_OWNER_TYPES = [
    "agent",
    "user",
    "board",
    "system",
];
export const ISSUE_RECOVERY_ACTION_OUTCOMES = [
    "restored",
    "handed_back",
    "owner_completed",
    "delegated",
    "false_positive",
    "blocked",
    "escalated",
    "cancelled",
];
export function pluginOperationIssueOriginKind(pluginKey) {
    return `plugin:${pluginKey}:operation`;
}
export function isPluginOperationIssueOriginKind(originKind) {
    return typeof originKind === "string" && /^plugin:[^:]+:operation(?::|$)/.test(originKind);
}
export const ISSUE_RELATION_TYPES = ["blocks"];
export const ISSUE_TREE_CONTROL_MODES = ["pause", "resume", "cancel", "restore"];
export const ISSUE_TREE_HOLD_STATUSES = ["active", "released"];
export const ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES = ["manual", "after_active_runs_finish"];
export const ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY = "continuation-summary";
export const PIPELINE_CASE_BODY_DOCUMENT_KEY = "pipeline-case-body";
export const PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE = "{{pipeline_name}} / {{stage_name}}: {{case_title}}";
export const SYSTEM_ISSUE_DOCUMENT_KEYS = [
    ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    PIPELINE_CASE_BODY_DOCUMENT_KEY,
];
const SYSTEM_ISSUE_DOCUMENT_KEY_SET = new Set(SYSTEM_ISSUE_DOCUMENT_KEYS);
export function isSystemIssueDocumentKey(key) {
    return SYSTEM_ISSUE_DOCUMENT_KEY_SET.has(key);
}
export const ISSUE_REFERENCE_SOURCE_KINDS = ["title", "description", "comment", "document"];
export const DOCUMENT_ANNOTATION_THREAD_STATUSES = ["open", "resolved"];
export const DOCUMENT_ANNOTATION_ANCHOR_STATES = ["active", "stale", "orphaned"];
export const DOCUMENT_ANNOTATION_ANCHOR_CONFIDENCES = [
    "exact",
    "duplicate",
    "fuzzy",
    "ambiguous",
    "missing",
];
export const EXTERNAL_OBJECT_STATUS_CATEGORIES = [
    "unknown",
    "open",
    "waiting",
    "running",
    "succeeded",
    "failed",
    "blocked",
    "closed",
    "archived",
    "auth_required",
    "unreachable",
];
export const EXTERNAL_OBJECT_STATUS_TONES = [
    "neutral",
    "info",
    "success",
    "warning",
    "danger",
    "muted",
];
export const EXTERNAL_OBJECT_LIVENESS_STATES = [
    "unknown",
    "fresh",
    "stale",
    "auth_required",
    "unreachable",
];
export const EXTERNAL_OBJECT_MENTION_SOURCE_KINDS = [
    "title",
    "description",
    "comment",
    "document",
    "property",
    "plugin",
];
export const EXTERNAL_OBJECT_MENTION_CONFIDENCES = ["exact", "likely", "possible"];
export const ISSUE_EXECUTION_POLICY_MODES = ["normal", "auto"];
export const ISSUE_EXECUTION_STAGE_TYPES = ["review", "approval"];
export const ISSUE_MONITOR_SCHEDULED_BY = ["assignee", "board"];
export const ISSUE_EXECUTION_MONITOR_KINDS = ["external_service"];
export const PROVIDER_QUOTA_MONITOR_SERVICE_NAME = "AI provider quota";
export const ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES = [
    "wake_owner",
    "create_recovery_issue",
    "escalate_to_board",
];
export const ISSUE_EXECUTION_STATE_STATUSES = ["idle", "pending", "changes_requested", "completed"];
export const ISSUE_EXECUTION_MONITOR_STATE_STATUSES = ["scheduled", "triggered", "cleared"];
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
];
export const ISSUE_EXECUTION_DECISION_OUTCOMES = ["approved", "changes_requested"];
export const GOAL_LEVELS = ["company", "team", "agent", "task"];
export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"];
export const PROJECT_STATUSES = [
    "backlog",
    "planned",
    "in_progress",
    "completed",
    "cancelled",
];
export const ENVIRONMENT_DRIVERS = ["local", "ssh", "sandbox", "plugin"];
export const ENVIRONMENT_STATUSES = ["active", "archived"];
export const ENVIRONMENT_LEASE_STATUSES = ["active", "released", "expired", "failed", "retained", "pending_cleanup"];
export const ENVIRONMENT_LEASE_POLICIES = [
    "ephemeral",
    "reuse_by_environment",
    "reuse_by_execution_workspace",
    "retain_on_failure",
];
export const ENVIRONMENT_LEASE_CLEANUP_STATUSES = ["pending", "success", "failed"];
export const ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_KINDS = [
    "snapshot",
    "image",
    "provider_template",
    "unknown",
];
export const ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_STATUSES = [
    "active",
    "superseded",
    "revoked",
    "failed",
];
export const ENVIRONMENT_CUSTOM_IMAGE_SETUP_SESSION_STATUSES = [
    "starting",
    "waiting_for_user",
    "capturing",
    "promoted",
    "cancelled",
    "timed_out",
    "failed",
];
export const ENVIRONMENT_CUSTOM_IMAGE_SETUP_CONNECTION_TYPES = [
    "ssh",
    "browser_terminal",
    "unknown",
];
export const ROUTINE_STATUSES = ["active", "paused", "archived"];
export const ROUTINE_CONCURRENCY_POLICIES = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
export const ROUTINE_CATCH_UP_POLICIES = ["skip_missed", "enqueue_missed_with_cap"];
export const ROUTINE_ACTIVITY_GATE_POLICIES = ["always", "require_external_activity"];
export const ROUTINE_ACTIVITY_GATE_SCOPES = ["company", "project"];
export const ROUTINE_TRIGGER_KINDS = ["schedule", "webhook", "api"];
export const ROUTINE_TRIGGER_SIGNING_MODES = ["bearer", "hmac_sha256", "github_hmac", "none"];
export const ROUTINE_VARIABLE_TYPES = ["text", "textarea", "number", "boolean", "select", "date"];
export const ROUTINE_RUN_STATUSES = [
    "received",
    "coalesced",
    "skipped",
    "issue_created",
    "completed",
    "failed",
];
export const ROUTINE_RUN_SOURCES = ["schedule", "manual", "api", "webhook"];
export const PAUSE_REASONS = ["manual", "budget", "system", "company_archived"];
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
];
export const APPROVAL_TYPES = [
    "hire_agent",
    "approve_ceo_strategy",
    "budget_override_required",
    "request_board_approval",
];
export const APPROVAL_STATUSES = [
    "pending",
    "revision_requested",
    "approved",
    "rejected",
    "cancelled",
];
export const SECRET_PROVIDERS = [
    "local_encrypted",
    "aws_secrets_manager",
    "gcp_secret_manager",
    "vault",
];
export const SECRET_PROVIDER_CONFIG_STATUSES = [
    "ready",
    "warning",
    "coming_soon",
    "disabled",
];
export const SECRET_PROVIDER_CONFIG_HEALTH_STATUSES = [
    "ready",
    "warning",
    "error",
    "coming_soon",
    "disabled",
];
export const SECRET_STATUSES = ["active", "disabled", "archived", "deleted"];
export const SECRET_SCOPES = ["company", "user"];
export const SECRET_MANAGED_MODES = ["paperclip_managed", "external_reference"];
export const SECRET_VERSION_STATUSES = [
    "current",
    "previous",
    "disabled",
    "destroyed",
    "failed",
];
export const SECRET_BINDING_TARGET_TYPES = [
    "agent",
    "project",
    "environment",
    "routine",
    "plugin",
    "issue",
    "run",
    "tool_connection",
    "system",
];
export const SECRET_ACCESS_OUTCOMES = [
    "success",
    "failure",
    "missing",
    "inactive",
    "not_allowed",
    "optional_omitted",
    "provider_error",
];
export const SECRET_PROJECTION_CLASSES = ["unclassified", "class_3_static_lease"];
export const CLASS3_STATIC_LEASE_ALLOWLIST = [
    {
        key: "slack.bot_token",
        label: "Slack bot token",
        targetType: "agent",
        configPath: "env.SLACK_BOT_TOKEN",
        envKey: "SLACK_BOT_TOKEN",
    },
    {
        key: "slack.bot_token",
        label: "Slack bot token",
        targetType: "routine",
        configPath: "env.SLACK_BOT_TOKEN",
        envKey: "SLACK_BOT_TOKEN",
    },
    {
        key: "slack.bot_token",
        label: "Slack bot token governance connection",
        targetType: "tool_connection",
        configPath: "credentials.bot_token",
        envKey: "SLACK_BOT_TOKEN",
    },
    {
        key: "discord.bot_token",
        label: "Discord bot token",
        targetType: "agent",
        configPath: "env.DISCORD_BOT_TOKEN",
        envKey: "DISCORD_BOT_TOKEN",
    },
    {
        key: "discord.bot_token",
        label: "Discord bot token",
        targetType: "routine",
        configPath: "env.DISCORD_BOT_TOKEN",
        envKey: "DISCORD_BOT_TOKEN",
    },
    {
        key: "discord.bot_token",
        label: "Discord bot token governance connection",
        targetType: "tool_connection",
        configPath: "credentials.bot_token",
        envKey: "DISCORD_BOT_TOKEN",
    },
];
export const STORAGE_PROVIDERS = ["local_disk", "s3"];
export const BILLING_TYPES = [
    "metered_api",
    "subscription_included",
    "subscription_overage",
    "credits",
    "fixed",
    "unknown",
];
export const BILLING_PERIODS = ["monthly", "yearly"];
export const COST_STATUSES = ["reported", "unpriced"];
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
];
export const FINANCE_DIRECTIONS = ["debit", "credit"];
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
];
export const BUDGET_SCOPE_TYPES = ["company", "agent", "project"];
export const BUDGET_METRICS = ["billed_cents"];
export const BUDGET_WINDOW_KINDS = ["calendar_month_utc", "lifetime"];
export const BUDGET_THRESHOLD_TYPES = ["soft", "hard"];
export const BUDGET_INCIDENT_STATUSES = ["open", "resolved", "dismissed"];
export const BUDGET_INCIDENT_RESOLUTION_ACTIONS = [
    "keep_paused",
    "raise_budget_and_resume",
];
export const HEARTBEAT_INVOCATION_SOURCES = [
    "timer",
    "assignment",
    "on_demand",
    "automation",
];
export const WAKEUP_TRIGGER_DETAILS = ["manual", "ping", "callback", "system"];
export const WAKEUP_REQUEST_STATUSES = [
    "queued",
    "deferred_issue_execution",
    "claimed",
    "coalesced",
    "skipped",
    "completed",
    "failed",
    "cancelled",
];
export const HEARTBEAT_RUN_STATUSES = [
    "queued",
    "scheduled_retry",
    "running",
    "succeeded",
    "interrupted",
    "failed",
    "cancelled",
    "timed_out",
];
export const RUN_LIVENESS_STATES = [
    "completed",
    "advanced",
    "plan_only",
    "empty_response",
    "blocked",
    "failed",
    "needs_followup",
];
export const LIVE_EVENT_TYPES = [
    "heartbeat.run.queued",
    "heartbeat.run.status",
    "heartbeat.run.progress",
    "heartbeat.run.event",
    "heartbeat.run.log",
    "agent.status",
    "activity.logged",
    "external_object.updated",
    "plugin.ui.updated",
    "plugin.worker.crashed",
    "plugin.worker.restarted",
    "subscription.status.updated",
];
export const PRINCIPAL_TYPES = ["user", "agent"];
export const MEMBERSHIP_STATUSES = ["pending", "active", "suspended", "archived"];
export const COMPANY_MEMBERSHIP_ROLES = [
    "owner",
    "admin",
    "operator",
    "viewer",
    "member",
];
export const HUMAN_COMPANY_MEMBERSHIP_ROLES = [
    "owner",
    "admin",
    "operator",
    "viewer",
];
export const HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS = {
    owner: "Owner",
    admin: "Admin",
    operator: "Operator",
    viewer: "Viewer",
};
export const INSTANCE_USER_ROLES = ["instance_admin"];
export const INVITE_TYPES = ["company_join", "bootstrap_ceo"];
export const INVITE_JOIN_TYPES = ["human", "agent", "both"];
export const JOIN_REQUEST_TYPES = ["human", "agent"];
export const JOIN_REQUEST_STATUSES = ["pending_approval", "approved", "rejected"];
export const PERMISSION_KEYS = [
    "agents:create",
    "agents:configure",
    "agents:suggest-changes",
    "skills:create",
    "skills:suggest-changes",
    "environments:manage",
    "tools:admin",
    "tools:manage_connections",
    "tools:manage_profiles",
    "tools:view_audit",
    "audit:view_agent_actions",
    "tools:use",
    "tools:manage_runtime",
    "inbox:manage",
    "users:invite",
    "users:manage_permissions",
    "tasks:assign",
    "tasks:assign_scope",
    "tasks:manage_active_checkouts",
    "pipelines:write",
    "joins:approve",
];
export const TOOL_APPLICATION_TYPES = ["mcp_http", "mcp_stdio", "paperclip_plugin", "a2a"];
export const TOOL_APPLICATION_STATUSES = ["draft", "active", "disabled", "archived"];
export const TOOL_CONNECTION_KINDS = ["managed"];
export const TOOL_CONNECTION_HEALTH_STATUSES = [
    "unknown",
    "healthy",
    "degraded",
    "failed",
    "unchecked",
    "ok",
    "error",
    "missing_secret",
];
/**
 * Health states that mean an app needs the user's attention (a bad/missing key
 * or a degraded connection). Single source of truth shared by the needs-
 * attention aggregation and the prosumer Apps surfaces so their counts agree.
 */
export const TOOL_CONNECTION_ATTENTION_HEALTH_STATUSES = [
    "degraded",
    "failed",
    "error",
    "missing_secret",
];
export function isToolConnectionAttentionHealth(status) {
    return TOOL_CONNECTION_ATTENTION_HEALTH_STATUSES.includes(status);
}
export const TOOL_CATALOG_ENTRY_KINDS = ["tool", "resource", "prompt"];
export const TOOL_CATALOG_ENTRY_STATUSES = ["active", "disabled", "quarantined", "removed"];
export const TOOL_RISK_LEVELS = ["low", "medium", "high", "critical", "read", "write", "destructive"];
export const TOOL_PROFILE_STATUSES = ["draft", "active", "disabled", "archived"];
export const TOOL_PROFILE_DEFAULT_ACTIONS = ["deny", "allow"];
export const TOOL_PROFILE_ENTRY_SELECTOR_TYPES = [
    "application",
    "connection",
    "catalog_entry",
    "tool_name",
    "risk_level",
];
export const TOOL_PROFILE_ENTRY_EFFECTS = ["include", "exclude"];
export const TOOL_PROFILE_BINDING_TARGET_TYPES = ["company", "agent", "project", "routine", "issue", "gateway"];
export const TOOL_MCP_GATEWAY_STATUSES = ["draft", "active", "disabled", "archived"];
export const TOOL_MCP_GATEWAY_DEFAULT_PROFILE_MODES = [
    "gateway_only",
    "inherit_context_then_gateway",
    "gateway_then_context",
];
export const TOOL_MCP_GATEWAY_CONTEXT_SCOPE_TYPES = [
    "none",
    "company",
    "project",
    "routine",
    "issue",
    "agent",
];
export const TOOL_MCP_GATEWAY_TOKEN_SUBJECT_TYPES = ["gateway_client", "heartbeat_run", "board_user", "agent"];
export const TOOL_MCP_GATEWAY_TOKEN_ACTIONS = ["tools/list", "tools/call"];
export const CONNECTION_TOKEN_ISSUANCE_PATHS = ["exchange", "oauth_access", "static"];
export const CONNECTION_TOKEN_ISSUANCE_OUTCOMES = [
    "success",
    "denied",
    "rate_limited",
    "use_env_lease",
    "upstream_error",
    "failure",
];
export const TOOL_POLICY_TYPES = [
    "allow",
    "block",
    "require_approval",
    "trust_rule",
    "rate_limit",
];
export const TOOL_POLICY_DECISIONS = ["allow", "deny", "require_approval", "rate_limited", "defer_runtime"];
export const TOOL_INVOCATION_STATUSES = [
    "pending",
    "authorized",
    "denied",
    "awaiting_approval",
    "executing",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "rate_limited",
];
export const TOOL_INVOCATION_APPROVAL_STATES = [
    "not_required",
    "required",
    "pending",
    "approved",
    "rejected",
    "expired",
];
export const TOOL_ACTION_REQUEST_STATUSES = [
    "pending",
    "approved",
    "executing",
    "rejected",
    "expired",
    "cancelled",
    "executed",
    "failed",
];
export const TOOL_AUDIT_EVENT_TYPES = [
    "discovery",
    "policy_decision",
    "invocation_created",
    "call_started",
    "call_completed",
    "call_failed",
    "call_denied",
    "approval_requested",
    "approval_resolved",
    "session_revoked",
    "trust_rule_created",
    "trust_rule_revoked",
    "trust_rule_used",
    "runtime_started",
    "runtime_stopped",
    "rate_limited",
];
export const TOOL_AUDIT_OUTCOMES = ["pending", "success", "failure", "denied", "timeout", "cancelled"];
/**
 * Connection-level lifecycle events surfaced on the per-app Activity tab
 * alongside tool-call events (PAP-11284). These are derived from the
 * company activity log rows scoped to a single tool connection.
 */
export const TOOL_CONNECTION_LIFECYCLE_EVENT_TYPES = [
    "app_connected",
    "app_paused",
    "app_resumed",
    "allowlist_changed",
    "reconnected",
    "disconnected",
    "actions_quarantined",
];
export const TOOL_RUNTIME_KINDS = ["remote_session", "local_stdio"];
export const TOOL_RUNTIME_SLOT_STATUSES = ["starting", "running", "idle", "stopped", "failed", "disabled", "error"];
export const TOOL_RATE_LIMIT_WINDOW_KINDS = ["minute", "hour", "day", "month"];
export const TOOL_ACCESS_ACTIVITY_ACTIONS = [
    "tool_application.created",
    "tool_application.updated",
    "tool_application.archived",
    "tool_connection.created",
    "tool_connection.updated",
    "tool_connection.tested",
    "tool_connection.catalog_refreshed",
    "tool_profile.created",
    "tool_profile.updated",
    "tool_profile.duplicated",
    "tool_profile.deleted",
    "tool_profile.new_tools_reviewed",
    "tool_profile.bound",
    "tool_profile.unbound",
    "tool_policy.created",
    "tool_policy.updated",
    "tool_policy.disabled",
    "tool_trust_rule.created",
    "tool_trust_rule.revoked",
    "tool_runtime_slot.started",
    "tool_runtime_slot.stopped",
    "tool_action_request.created",
    "tool_action_request.resolved",
];
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
export const PLUGIN_API_VERSION = 1;
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
];
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
];
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
    "execution.workspaces.read",
    "issues.read",
    "issue.relations.read",
    "issue.subtree.read",
    "issue.comments.read",
    // Read pending issue-thread interactions (decision cards) on an issue.
    "issue.interactions.read",
    // Read issue attachment metadata and, via the capability-scoped host
    // bridge, attachment content bytes (bytes-only, company-scoped, audit-logged).
    "issue.attachments.read",
    // Read company approvals (list + get). The host redacts approval payloads to
    // match the web app's own approval read surface.
    "approvals.read",
    "issue.documents.read",
    "agents.read",
    "goals.read",
    "goals.create",
    "goals.update",
    "activity.read",
    "costs.read",
    "issues.orchestration.read",
    "access.members.read",
    "access.invites.read",
    "authorization.grants.read",
    "authorization.policies.read",
    "authorization.audit.read",
    "database.namespace.read",
    // Data Write
    "issues.create",
    "issues.update",
    "issue.relations.write",
    "issues.checkout",
    "issues.wakeup",
    "issue.comments.create",
    "issue.comments.create_human_attributed",
    "issue.interactions.create",
    // Respond to (accept/reject) an issue-thread interaction on behalf of a
    // paired board user. Impersonation surface: the host independently
    // re-verifies the actor is an active human member of the company at apply
    // time (never trusts plugin-supplied identity), matching the web app's
    // board-only interaction resolve route.
    "issue.interactions.respond",
    // Decide (approve/reject) a company approval on behalf of a paired board
    // user. Same apply-time active-human-member re-verification as above; the
    // web app's approval decision routes are board-only.
    "approvals.respond",
    "issue.documents.write",
    "projects.managed",
    "routines.managed",
    "skills.managed",
    "agents.pause",
    "agents.resume",
    "agents.invoke",
    "agents.managed",
    "access.members.write",
    "access.invites.write",
    "authorization.grants.write",
    "authorization.policies.write",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "activity.log.write",
    "metrics.write",
    "telemetry.track",
    "database.namespace.migrate",
    "database.namespace.write",
    "external.objects.detect",
    "external.objects.read",
    "external.objects.write",
    "external.objects.refresh",
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
];
export const PLUGIN_DATABASE_NAMESPACE_MODES = ["schema"];
export const PLUGIN_DATABASE_NAMESPACE_STATUSES = [
    "active",
    "migration_failed",
];
export const PLUGIN_DATABASE_MIGRATION_STATUSES = [
    "applied",
    "failed",
];
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
];
export const PLUGIN_API_ROUTE_METHODS = ["GET", "POST", "PATCH", "DELETE"];
export const PLUGIN_API_ROUTE_AUTH_MODES = ["board", "agent", "board-or-agent", "webhook"];
export const PLUGIN_API_ROUTE_CHECKOUT_POLICIES = [
    "none",
    "required-for-agent-in-progress",
    "always-for-agent",
];
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
    "companySettingsPage",
];
export const WORKSPACE_OVERVIEW_DEFAULT_LIMIT = 50;
export const WORKSPACE_OVERVIEW_MAX_LIMIT = 100;
export const WORKSPACE_OVERVIEW_LINKED_ISSUE_LIMIT = 4;
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
    "workspaces",
    "design-guide",
    "tests",
];
/**
 * Reserved route segments under `/:companyPrefix/company/settings/...` that
 * plugin company settings pages may not claim.
 */
export const PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS = [
    "general",
    "environments",
    "access",
    "members",
    "invites",
    "secrets",
    "instance",
];
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
];
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
];
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
];
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
];
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
    "execution_workspace",
    "project_workspace",
];
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
];
/** Statuses for a plugin's scheduled job definition. */
export const PLUGIN_JOB_STATUSES = [
    "active",
    "paused",
    "failed",
];
/** Statuses for individual job run executions. */
export const PLUGIN_JOB_RUN_STATUSES = [
    "pending",
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
];
/** What triggered a particular job run. */
export const PLUGIN_JOB_RUN_TRIGGERS = [
    "schedule",
    "manual",
    "retry",
];
/** Statuses for inbound webhook deliveries. */
export const PLUGIN_WEBHOOK_DELIVERY_STATUSES = [
    "pending",
    "success",
    "failed",
];
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
    "agent.error_cleared",
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
];
/**
 * Error codes returned by the plugin bridge when a UI → worker call fails.
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export const PLUGIN_BRIDGE_ERROR_CODES = [
    "WORKER_UNAVAILABLE",
    "CAPABILITY_DENIED",
    "INVOCATION_SCOPE_DENIED",
    "WORKER_ERROR",
    "TIMEOUT",
    "UNKNOWN",
];
//# sourceMappingURL=constants.js.map