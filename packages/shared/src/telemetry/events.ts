import type { TelemetryClient } from "./client.js";
import type { EventDimensionsMap } from "./generated/paperclip-telemetry.js";

type AgentRole = EventDimensionsMap["agent.created"]["agent_role"];
type AdapterType = EventDimensionsMap["install.completed"]["adapter_type"];
type SourceType = EventDimensionsMap["company.imported"]["source_type"];
type GoalLevel = EventDimensionsMap["goal.created"]["goal_level"];
type RoutineRunSource = EventDimensionsMap["routine.run"]["source"];
type RoutineRunStatus = EventDimensionsMap["routine.run"]["status"];
type InteractionKind = EventDimensionsMap["interaction.resolved"]["interaction_kind"];
type InteractionStatus = EventDimensionsMap["interaction.resolved"]["status"];
type InteractionResolutionReason = NonNullable<EventDimensionsMap["interaction.resolved"]["resolution_reason"]>;
type InteractionResolvedByKind = EventDimensionsMap["interaction.resolved"]["resolved_by_kind"];
type InteractionCreatedByKind = NonNullable<EventDimensionsMap["interaction.resolved"]["created_by_kind"]>;
type InteractionContinuationPolicy = NonNullable<EventDimensionsMap["interaction.resolved"]["continuation_policy"]>;
type InteractionTargetType = NonNullable<EventDimensionsMap["interaction.resolved"]["target_type"]>;

const AGENT_ROLES = [
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
  "other",
] as const satisfies readonly AgentRole[];

const ADAPTER_TYPES = [
  "process",
  "http",
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor_cloud",
  "gemini_local",
  "hermes_gateway",
  "hermes_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "openclaw_gateway",
  "grok_local",
  "other",
] as const satisfies readonly AdapterType[];

const SOURCE_TYPES = [
  "local_path",
  "github",
  "url",
  "catalog",
  "skills_sh",
  "unknown",
] as const satisfies readonly SourceType[];

const GOAL_LEVELS = [
  "company",
  "team",
  "agent",
  "task",
  "other",
] as const satisfies readonly GoalLevel[];
const ROUTINE_RUN_SOURCES = [
  "schedule",
  "manual",
  "api",
  "webhook",
  "other",
] as const satisfies readonly RoutineRunSource[];
const ROUTINE_RUN_STATUSES = [
  "received",
  "coalesced",
  "skipped",
  "issue_created",
  "completed",
  "failed",
  "other",
] as const satisfies readonly RoutineRunStatus[];
const INTERACTION_KINDS = [
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "other",
] as const satisfies readonly InteractionKind[];
const INTERACTION_STATUSES = [
  "accepted",
  "rejected",
  "answered",
  "cancelled",
  "expired",
  "failed",
  "other",
] as const satisfies readonly InteractionStatus[];
const INTERACTION_RESOLUTION_REASONS = [
  "accepted",
  "rejected",
  "stale_target",
  "superseded_by_comment",
  "expired",
  "cancelled",
  "other",
] as const satisfies readonly InteractionResolutionReason[];
const INTERACTION_RESOLVED_BY_KINDS = [
  "user",
  "agent",
  "system",
  "other",
] as const satisfies readonly InteractionResolvedByKind[];
const INTERACTION_CREATED_BY_KINDS = [
  "agent",
  "user",
  "other",
] as const satisfies readonly InteractionCreatedByKind[];
const INTERACTION_CONTINUATION_POLICIES = [
  "none",
  "wake_assignee",
  "wake_assignee_on_accept",
  "other",
] as const satisfies readonly InteractionContinuationPolicy[];
const INTERACTION_TARGET_TYPES = [
  "issue_document",
  "custom",
  "none",
  "other",
] as const satisfies readonly InteractionTargetType[];

function normalizeEnum<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  for (const allowedValue of allowed) {
    if (value === allowedValue) return allowedValue;
  }
  return fallback;
}

export function trackInstallStarted(client: TelemetryClient): void {
  client.track("install.started", {});
}

export function trackInstallCompleted(
  client: TelemetryClient,
  dims: { adapterType: string },
): void {
  client.track("install.completed", {
    adapter_type: normalizeEnum(dims.adapterType, ADAPTER_TYPES, "other"),
  });
}

export function trackCompanyImported(
  client: TelemetryClient,
  dims: { sourceType: string; sourceRef: string; isPrivate: boolean },
): void {
  const ref = dims.isPrivate ? client.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  client.track("company.imported", {
    source_type: normalizeEnum(dims.sourceType, SOURCE_TYPES, "unknown"),
    source_ref: ref,
    source_ref_hashed: dims.isPrivate,
  });
}

export function trackProjectCreated(client: TelemetryClient): void {
  client.track("project.created", {});
}

export function trackRoutineCreated(client: TelemetryClient): void {
  client.track("routine.created", {});
}

export function trackRoutineRun(
  client: TelemetryClient,
  dims: { source: string; status: string },
): void {
  client.track("routine.run", {
    source: normalizeEnum(dims.source, ROUTINE_RUN_SOURCES, "other"),
    status: normalizeEnum(dims.status, ROUTINE_RUN_STATUSES, "other"),
  });
}

export function trackGoalCreated(
  client: TelemetryClient,
  dims?: { goalLevel?: string | null },
): void {
  client.track("goal.created", {
    goal_level: normalizeEnum(dims?.goalLevel, GOAL_LEVELS, "other"),
  });
}

export function trackAgentCreated(
  client: TelemetryClient,
  dims: { agentRole: string; agentId: string },
): void {
  client.track("agent.created", {
    agent_role: normalizeEnum(dims.agentRole, AGENT_ROLES, "other"),
    agent_id: dims.agentId,
  });
}

export function trackSkillImported(
  client: TelemetryClient,
  dims: { sourceType: string; skillRef?: string | null },
): void {
  client.track("skill.imported", {
    source_type: normalizeEnum(dims.sourceType, SOURCE_TYPES, "unknown"),
    ...(dims.skillRef ? { skill_ref: dims.skillRef } : {}),
  });
}

export function trackAgentFirstHeartbeat(
  client: TelemetryClient,
  dims: { agentRole: string; agentId: string },
): void {
  client.track("agent.first_heartbeat", {
    agent_role: normalizeEnum(dims.agentRole, AGENT_ROLES, "other"),
    agent_id: dims.agentId,
  });
}

export function trackAgentTaskCompleted(
  client: TelemetryClient,
  dims: {
    agentRole: string;
    agentId: string;
    adapterType: string;
    model?: string;
  },
): void {
  client.track("agent.task_completed", {
    agent_role: normalizeEnum(dims.agentRole, AGENT_ROLES, "other"),
    agent_id: dims.agentId,
    adapter_type: normalizeEnum(dims.adapterType, ADAPTER_TYPES, "other"),
    ...(dims.model ? { model: dims.model } : {}),
  });
}

export function trackErrorHandlerCrash(
  client: TelemetryClient,
  dims: { errorCode: string },
): void {
  client.track("error.handler_crash", { error_code: dims.errorCode });
}

export function trackInteractionResolved(
  client: TelemetryClient,
  dims: {
    interactionKind: string;
    status: string;
    resolvedByKind: string;
    resolutionReason?: string | null;
    createdByKind?: string | null;
    creatorAgentRole?: string | null;
    continuationPolicy?: string | null;
    targetType?: string | null;
    optionCount?: number;
    selectedOptionCount?: number;
    questionCount?: number;
    answeredQuestionCount?: number;
    createdTaskCount?: number;
  },
): void {
  client.track("interaction.resolved", {
    interaction_kind: normalizeEnum(dims.interactionKind, INTERACTION_KINDS, "other"),
    status: normalizeEnum(dims.status, INTERACTION_STATUSES, "other"),
    resolved_by_kind: normalizeEnum(dims.resolvedByKind, INTERACTION_RESOLVED_BY_KINDS, "other"),
    ...(dims.resolutionReason
      ? { resolution_reason: normalizeEnum(dims.resolutionReason, INTERACTION_RESOLUTION_REASONS, "other") }
      : {}),
    ...(dims.createdByKind
      ? { created_by_kind: normalizeEnum(dims.createdByKind, INTERACTION_CREATED_BY_KINDS, "other") }
      : {}),
    ...(dims.creatorAgentRole
      ? { creator_agent_role: normalizeEnum(dims.creatorAgentRole, AGENT_ROLES, "other") }
      : {}),
    ...(dims.continuationPolicy
      ? { continuation_policy: normalizeEnum(dims.continuationPolicy, INTERACTION_CONTINUATION_POLICIES, "other") }
      : {}),
    ...(dims.targetType
      ? { target_type: normalizeEnum(dims.targetType, INTERACTION_TARGET_TYPES, "other") }
      : {}),
    ...(dims.optionCount === undefined ? {} : { option_count: dims.optionCount }),
    ...(dims.selectedOptionCount === undefined ? {} : { selected_option_count: dims.selectedOptionCount }),
    ...(dims.questionCount === undefined ? {} : { question_count: dims.questionCount }),
    ...(dims.answeredQuestionCount === undefined ? {} : { answered_question_count: dims.answeredQuestionCount }),
    ...(dims.createdTaskCount === undefined ? {} : { created_task_count: dims.createdTaskCount }),
  });
}
