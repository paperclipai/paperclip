import type { TelemetryClient } from "./client.js";
import type { EventDimensionsMap } from "./generated/paperclip-telemetry.js";

type RawDimension<T extends string | undefined> = T | (string & {});

function asEventDimension<T extends string>(value: RawDimension<T>): T {
  return value as T;
}

export function trackInstallStarted(client: TelemetryClient): void {
  client.track("install.started", {});
}

export function trackInstallCompleted(
  client: TelemetryClient,
  dims: { adapterType: RawDimension<EventDimensionsMap["install.completed"]["adapter_type"]> },
): void {
  client.track("install.completed", {
    adapter_type: asEventDimension(dims.adapterType),
  });
}

export function trackCompanyImported(
  client: TelemetryClient,
  dims: {
    sourceType: RawDimension<EventDimensionsMap["company.imported"]["source_type"]>;
    sourceRef: string;
    isPrivate: boolean;
  },
): void {
  const ref = dims.isPrivate ? client.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  client.track("company.imported", {
    source_type: asEventDimension(dims.sourceType),
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
  dims: {
    source: RawDimension<EventDimensionsMap["routine.run"]["source"]>;
    status: RawDimension<EventDimensionsMap["routine.run"]["status"]>;
  },
): void {
  client.track("routine.run", {
    source: asEventDimension(dims.source),
    status: asEventDimension(dims.status),
  });
}

export function trackGoalCreated(
  client: TelemetryClient,
  dims?: { goalLevel?: RawDimension<EventDimensionsMap["goal.created"]["goal_level"]> | null },
): void {
  client.track("goal.created", {
    goal_level: dims?.goalLevel ? asEventDimension(dims.goalLevel) : "other",
  });
}

export function trackAgentCreated(
  client: TelemetryClient,
  dims: {
    agentRole: RawDimension<EventDimensionsMap["agent.created"]["agent_role"]>;
    agentId: string;
  },
): void {
  client.track("agent.created", {
    agent_role: asEventDimension(dims.agentRole),
    agent_id: dims.agentId,
  });
}

export function trackSkillImported(
  client: TelemetryClient,
  dims: {
    sourceType: RawDimension<EventDimensionsMap["skill.imported"]["source_type"]>;
    skillRef?: string | null;
  },
): void {
  client.track("skill.imported", {
    source_type: asEventDimension(dims.sourceType),
    ...(dims.skillRef ? { skill_ref: dims.skillRef } : {}),
  });
}

export function trackAgentFirstHeartbeat(
  client: TelemetryClient,
  dims: {
    agentRole: RawDimension<EventDimensionsMap["agent.first_heartbeat"]["agent_role"]>;
    agentId: string;
  },
): void {
  client.track("agent.first_heartbeat", {
    agent_role: asEventDimension(dims.agentRole),
    agent_id: dims.agentId,
  });
}

export function trackAgentTaskCompleted(
  client: TelemetryClient,
  dims: {
    agentRole: RawDimension<EventDimensionsMap["agent.task_completed"]["agent_role"]>;
    agentId: string;
    adapterType: RawDimension<EventDimensionsMap["agent.task_completed"]["adapter_type"]>;
    model?: string;
  },
): void {
  client.track("agent.task_completed", {
    agent_role: asEventDimension(dims.agentRole),
    agent_id: dims.agentId,
    adapter_type: asEventDimension(dims.adapterType),
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
    interactionKind: RawDimension<EventDimensionsMap["interaction.resolved"]["interaction_kind"]>;
    status: RawDimension<EventDimensionsMap["interaction.resolved"]["status"]>;
    resolvedByKind: RawDimension<EventDimensionsMap["interaction.resolved"]["resolved_by_kind"]>;
    resolutionReason?: RawDimension<EventDimensionsMap["interaction.resolved"]["resolution_reason"]> | null;
    createdByKind?: RawDimension<EventDimensionsMap["interaction.resolved"]["created_by_kind"]> | null;
    creatorAgentRole?: RawDimension<EventDimensionsMap["interaction.resolved"]["creator_agent_role"]> | null;
    continuationPolicy?: RawDimension<EventDimensionsMap["interaction.resolved"]["continuation_policy"]> | null;
    targetType?: RawDimension<EventDimensionsMap["interaction.resolved"]["target_type"]> | null;
    optionCount?: number;
    selectedOptionCount?: number;
    questionCount?: number;
    answeredQuestionCount?: number;
    createdTaskCount?: number;
    skippedTaskCount?: number;
  },
): void {
  client.track("interaction.resolved", {
    interaction_kind: asEventDimension(dims.interactionKind),
    status: asEventDimension(dims.status),
    resolved_by_kind: asEventDimension(dims.resolvedByKind),
    ...(dims.resolutionReason ? { resolution_reason: asEventDimension(dims.resolutionReason) } : {}),
    ...(dims.createdByKind ? { created_by_kind: asEventDimension(dims.createdByKind) } : {}),
    ...(dims.creatorAgentRole ? { creator_agent_role: asEventDimension(dims.creatorAgentRole) } : {}),
    ...(dims.continuationPolicy ? { continuation_policy: asEventDimension(dims.continuationPolicy) } : {}),
    ...(dims.targetType ? { target_type: asEventDimension(dims.targetType) } : {}),
    ...(dims.optionCount === undefined ? {} : { option_count: dims.optionCount }),
    ...(dims.selectedOptionCount === undefined ? {} : { selected_option_count: dims.selectedOptionCount }),
    ...(dims.questionCount === undefined ? {} : { question_count: dims.questionCount }),
    ...(dims.answeredQuestionCount === undefined ? {} : { answered_question_count: dims.answeredQuestionCount }),
    ...(dims.createdTaskCount === undefined ? {} : { created_task_count: dims.createdTaskCount }),
    ...(dims.skippedTaskCount === undefined ? {} : { skipped_task_count: dims.skippedTaskCount }),
  });
}
