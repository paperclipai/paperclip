import type { TelemetryClient } from "./client.js";

export function trackInstallStarted(client: TelemetryClient): void {
  client.track("install.started");
}

export function trackInstallCompleted(
  client: TelemetryClient,
  dims: { adapterType: string },
): void {
  client.track("install.completed", { adapter_type: dims.adapterType });
}

export function trackCompanyImported(
  client: TelemetryClient,
  dims: { sourceType: string; sourceRef: string; isPrivate: boolean },
): void {
  const ref = dims.isPrivate ? client.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  client.track("company.imported", {
    source_type: dims.sourceType,
    source_ref: ref,
    source_ref_hashed: dims.isPrivate,
  });
}

export function trackProjectCreated(client: TelemetryClient): void {
  client.track("project.created");
}

export function trackRoutineCreated(client: TelemetryClient): void {
  client.track("routine.created");
}

export function trackRoutineRun(
  client: TelemetryClient,
  dims: { source: string; status: string },
): void {
  client.track("routine.run", {
    source: dims.source,
    status: dims.status,
  });
}

export function trackGoalCreated(
  client: TelemetryClient,
  dims?: { goalLevel?: string | null },
): void {
  client.track("goal.created", dims?.goalLevel ? { goal_level: dims.goalLevel } : undefined);
}

export function trackAgentCreated(
  client: TelemetryClient,
  dims: { agentRole: string; agentId?: string },
): void {
  client.track("agent.created", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
  });
}

export function trackSkillImported(
  client: TelemetryClient,
  dims: { sourceType: string; skillRef?: string | null },
): void {
  client.track("skill.imported", {
    source_type: dims.sourceType,
    ...(dims.skillRef ? { skill_ref: dims.skillRef } : {}),
  });
}

export function trackAgentFirstHeartbeat(
  client: TelemetryClient,
  dims: { agentRole: string; agentId?: string },
): void {
  client.track("agent.first_heartbeat", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
  });
}

export function trackAgentTaskCompleted(
  client: TelemetryClient,
  dims: { agentRole: string; agentId?: string; adapterType?: string; model?: string },
): void {
  client.track("agent.task_completed", {
    agent_role: dims.agentRole,
    ...(dims.agentId ? { agent_id: dims.agentId } : {}),
    ...(dims.adapterType ? { adapter_type: dims.adapterType } : {}),
    ...(dims.model ? { model: dims.model } : {}),
  });
}

export function trackIssueExecutionStageTransition(
  client: TelemetryClient,
  dims: {
    fromStatus: string;
    toStatus: string;
    fromStageType: string;
    toStageType: string;
    fromParticipantType: string;
    toParticipantType: string;
    decisionOutcome?: string | null;
  },
): void {
  client.track("issue.execution_stage_transition", {
    from_status: dims.fromStatus,
    to_status: dims.toStatus,
    from_stage_type: dims.fromStageType,
    to_stage_type: dims.toStageType,
    from_participant_type: dims.fromParticipantType,
    to_participant_type: dims.toParticipantType,
    ...(dims.decisionOutcome ? { decision_outcome: dims.decisionOutcome } : {}),
  });
}

export function trackIssueExecutionRejectedActor(
  client: TelemetryClient,
  dims: {
    actorType: string;
    requestedStatus: string;
    stageType: string;
    currentParticipantType: string;
    actorMatchesCurrentParticipant: boolean;
  },
): void {
  client.track("issue.execution_actor_rejected", {
    actor_type: dims.actorType,
    requested_status: dims.requestedStatus,
    stage_type: dims.stageType,
    current_participant_type: dims.currentParticipantType,
    actor_matches_current_participant: dims.actorMatchesCurrentParticipant,
  });
}

export function trackErrorHandlerCrash(
  client: TelemetryClient,
  dims: { errorCode: string },
): void {
  client.track("error.handler_crash", { error_code: dims.errorCode });
}
