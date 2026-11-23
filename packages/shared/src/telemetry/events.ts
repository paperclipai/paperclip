import type { TelemetryClient } from "./client.js";
import type { EventDimensionsMap } from "./generated/paperclip-telemetry.js";

type RawDimension<T extends string | undefined> = T | (string & {});

function asEventDimension<T extends string>(value: RawDimension<T>): T {
  return value as T;
}

/**
 * Emitted form of a private task reference. The default collector path always
 * hashes it with `hashPrivateRef()`. Only a client whose transport declares
 * `hashesPrivateRefs: false` (Paperclip Cloud direct delivery) emits the raw id.
 */
function emitPrivateRef(client: TelemetryClient, value: string): string {
  return client.privateRefsHashed === false ? value : client.hashPrivateRef(value);
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
  // A private source ref is customer content (for example a private repository
  // name), not an identifier. It stays hashed on every path, Cloud included.
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
    taskId?: string;
  },
): void {
  client.track("agent.task_completed", {
    agent_role: asEventDimension(dims.agentRole),
    agent_id: dims.agentId,
    adapter_type: asEventDimension(dims.adapterType),
    ...(dims.model ? { model: dims.model } : {}),
    ...(dims.taskId ? { task_id: emitPrivateRef(client, dims.taskId) } : {}),
  });
}

export function trackAgentTaskRun(
  client: TelemetryClient,
  dims: {
    agentId: string;
    state: RawDimension<EventDimensionsMap["agent.task_run"]["state"]>;
    adapterType?: RawDimension<EventDimensionsMap["agent.task_run"]["adapter_type"]>;
    agentRole?: RawDimension<EventDimensionsMap["agent.task_run"]["agent_role"]>;
    model?: string;
    durationSeconds?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    taskId?: string;
    failureCause?: RawDimension<EventDimensionsMap["agent.task_run"]["failure_cause"]>;
  },
): void {
  client.track("agent.task_run", {
    agent_id: dims.agentId,
    state: asEventDimension(dims.state),
    ...(dims.adapterType ? { adapter_type: asEventDimension(dims.adapterType) } : {}),
    ...(dims.agentRole ? { agent_role: asEventDimension(dims.agentRole) } : {}),
    ...(dims.model ? { model: dims.model } : {}),
    ...(dims.durationSeconds === undefined ? {} : { duration_seconds: dims.durationSeconds }),
    ...(dims.inputTokens === undefined ? {} : { input_tokens: dims.inputTokens }),
    ...(dims.outputTokens === undefined ? {} : { output_tokens: dims.outputTokens }),
    ...(dims.cachedTokens === undefined ? {} : { cached_tokens: dims.cachedTokens }),
    ...(dims.taskId ? { task_id: emitPrivateRef(client, dims.taskId) } : {}),
    ...(dims.failureCause ? { failure_cause: asEventDimension(dims.failureCause) } : {}),
  });
}

export function trackModelConnected(
  client: TelemetryClient,
  dims: {
    provider: RawDimension<EventDimensionsMap["model.connected"]["provider"]>;
    connectionMethod: RawDimension<EventDimensionsMap["model.connected"]["connection_method"]>;
    ownership: RawDimension<EventDimensionsMap["model.connected"]["ownership"]>;
    routingKind?: RawDimension<EventDimensionsMap["model.connected"]["routing_kind"]> | null;
    firstForCompany: boolean;
  },
): void {
  client.track("model.connected", {
    provider: asEventDimension(dims.provider),
    connection_method: asEventDimension(dims.connectionMethod),
    ownership: asEventDimension(dims.ownership),
    ...(dims.routingKind ? { routing_kind: asEventDimension(dims.routingKind) } : {}),
    first_for_company: dims.firstForCompany,
  });
}

export function trackTaskCreated(
  client: TelemetryClient,
  dims: {
    createdByKind: RawDimension<EventDimensionsMap["task.created"]["created_by_kind"]>;
    isSubtask: boolean;
  },
): void {
  client.track("task.created", {
    created_by_kind: asEventDimension(dims.createdByKind),
    is_subtask: dims.isSubtask,
  });
}

export function trackTaskCompleted(
  client: TelemetryClient,
  dims: {
    completedByKind: RawDimension<EventDimensionsMap["task.completed"]["completed_by_kind"]>;
    isSubtask: boolean;
  },
): void {
  client.track("task.completed", {
    completed_by_kind: asEventDimension(dims.completedByKind),
    is_subtask: dims.isSubtask,
  });
}

export function trackTaskBlocked(
  client: TelemetryClient,
  dims: {
    blockedReason: RawDimension<EventDimensionsMap["task.blocked"]["blocked_reason"]>;
    blockedByKind: RawDimension<EventDimensionsMap["task.blocked"]["blocked_by_kind"]>;
  },
): void {
  client.track("task.blocked", {
    blocked_reason: asEventDimension(dims.blockedReason),
    blocked_by_kind: asEventDimension(dims.blockedByKind),
  });
}

export function trackPlanCreated(
  client: TelemetryClient,
  dims: {
    createdByKind: RawDimension<EventDimensionsMap["plan.created"]["created_by_kind"]>;
    atTaskCreation: boolean;
  },
): void {
  client.track("plan.created", {
    created_by_kind: asEventDimension(dims.createdByKind),
    at_task_creation: dims.atTaskCreation,
  });
}

export function trackPlanApproved(
  client: TelemetryClient,
  dims: {
    approvedByKind: RawDimension<EventDimensionsMap["plan.approved"]["approved_by_kind"]>;
    startsExecution: boolean;
  },
): void {
  client.track("plan.approved", {
    approved_by_kind: asEventDimension(dims.approvedByKind),
    starts_execution: dims.startsExecution,
  });
}

export function trackArtifactCreated(
  client: TelemetryClient,
  dims: {
    artifactType: RawDimension<EventDimensionsMap["artifact.created"]["artifact_type"]>;
    provider: RawDimension<EventDimensionsMap["artifact.created"]["provider"]>;
    creationFlow: RawDimension<EventDimensionsMap["artifact.created"]["creation_flow"]>;
  },
): void {
  client.track("artifact.created", {
    artifact_type: asEventDimension(dims.artifactType),
    provider: asEventDimension(dims.provider),
    creation_flow: asEventDimension(dims.creationFlow),
  });
}

export function trackConnectionCreated(
  client: TelemetryClient,
  dims: {
    connector_key: string;
    transport: RawDimension<EventDimensionsMap["connection.created"]["transport"]>;
    auth_kind: RawDimension<EventDimensionsMap["connection.created"]["auth_kind"]>;
    setup_flow: RawDimension<EventDimensionsMap["connection.created"]["setup_flow"]>;
    status: RawDimension<EventDimensionsMap["connection.created"]["status"]>;
    enabled: boolean;
  },
): void {
  client.track("connection.created", {
    ...dims,
    transport: asEventDimension(dims.transport),
    auth_kind: asEventDimension(dims.auth_kind),
    setup_flow: asEventDimension(dims.setup_flow),
    status: asEventDimension(dims.status),
  });
}

export function trackConnectionUpdated(
  client: TelemetryClient,
  dims: {
    connector_key: string;
    transport: RawDimension<EventDimensionsMap["connection.updated"]["transport"]>;
    auth_kind: RawDimension<EventDimensionsMap["connection.updated"]["auth_kind"]>;
    change_source: RawDimension<EventDimensionsMap["connection.updated"]["change_source"]>;
    previous_status: RawDimension<EventDimensionsMap["connection.updated"]["previous_status"]>;
    status: RawDimension<EventDimensionsMap["connection.updated"]["status"]>;
    previous_enabled: boolean;
    enabled: boolean;
  },
): void {
  client.track("connection.updated", {
    ...dims,
    transport: asEventDimension(dims.transport),
    auth_kind: asEventDimension(dims.auth_kind),
    change_source: asEventDimension(dims.change_source),
    previous_status: asEventDimension(dims.previous_status),
    status: asEventDimension(dims.status),
  });
}

export function trackConnectionInvoked(
  client: TelemetryClient,
  dims: {
    connector_key: string;
    transport: RawDimension<EventDimensionsMap["connection.invoked"]["transport"]>;
    status: RawDimension<EventDimensionsMap["connection.invoked"]["status"]>;
    origin: RawDimension<EventDimensionsMap["connection.invoked"]["origin"]>;
    duration_seconds?: number;
  },
): void {
  client.track("connection.invoked", {
    ...dims,
    transport: asEventDimension(dims.transport),
    status: asEventDimension(dims.status),
    origin: asEventDimension(dims.origin),
  });
}

export function trackServerStarted(
  client: TelemetryClient,
  dims: { os_platform: RawDimension<EventDimensionsMap["server.started"]["os_platform"]> },
): void {
  client.track("server.started", { os_platform: asEventDimension(dims.os_platform) });
}

export function trackErrorHandlerCrash(
  client: TelemetryClient,
  dims: { errorCode: string },
): void {
  client.track("error.handler_crash", { error_code: dims.errorCode });
}

export function trackInteractionCreated(
  client: TelemetryClient,
  dims: {
    interactionKind: RawDimension<EventDimensionsMap["interaction.created"]["interaction_kind"]>;
    usedDeprecatedResolverPolicyAlias: boolean;
  },
): void {
  client.track("interaction.created", {
    interaction_kind: asEventDimension(dims.interactionKind),
    used_deprecated_resolver_policy_alias: dims.usedDeprecatedResolverPolicyAlias,
  });
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
    legacyInheritedRestriction: boolean;
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
    legacy_inherited_restriction: dims.legacyInheritedRestriction,
  });
}
