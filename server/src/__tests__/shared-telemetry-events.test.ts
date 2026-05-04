import { describe, expect, it, vi } from "vitest";
import {
  trackAgentCreated,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackInstallCompleted,
  trackIssueExecutionRejectedActor,
  trackIssueExecutionStageTransition,
} from "@paperclipai/shared/telemetry";
import type { TelemetryClient } from "@paperclipai/shared/telemetry";

function createClient(): TelemetryClient {
  return {
    track: vi.fn(),
    hashPrivateRef: vi.fn((value: string) => `hashed:${value}`),
  } as unknown as TelemetryClient;
}

describe("shared telemetry agent events", () => {
  it("includes agent_id for agent.created", () => {
    const client = createClient();

    trackAgentCreated(client, {
      agentRole: "engineer",
      agentId: "11111111-1111-4111-8111-111111111111",
    });

    expect(client.track).toHaveBeenCalledWith("agent.created", {
      agent_role: "engineer",
      agent_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("includes agent_id for agent.first_heartbeat", () => {
    const client = createClient();

    trackAgentFirstHeartbeat(client, {
      agentRole: "coder",
      agentId: "22222222-2222-4222-8222-222222222222",
    });

    expect(client.track).toHaveBeenCalledWith("agent.first_heartbeat", {
      agent_role: "coder",
      agent_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("includes agent_id for agent.task_completed", () => {
    const client = createClient();

    trackAgentTaskCompleted(client, {
      agentRole: "qa",
      agentId: "33333333-3333-4333-8333-333333333333",
    });

    expect(client.track).toHaveBeenCalledWith("agent.task_completed", {
      agent_role: "qa",
      agent_id: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("keeps non-agent event dimensions unchanged", () => {
    const client = createClient();

    trackInstallCompleted(client, { adapterType: "codex_local" });

    expect(client.track).toHaveBeenCalledWith("install.completed", {
      adapter_type: "codex_local",
    });
    expect(client.track).not.toHaveBeenCalledWith(
      "install.completed",
      expect.objectContaining({ agent_id: expect.any(String) }),
    );
  });

  it("tracks execution stage transitions", () => {
    const client = createClient();

    trackIssueExecutionStageTransition(client, {
      fromStatus: "pending",
      toStatus: "pending",
      fromStageType: "review",
      toStageType: "approval",
      fromParticipantType: "agent",
      toParticipantType: "user",
      decisionOutcome: "approved",
    });

    expect(client.track).toHaveBeenCalledWith("issue.execution_stage_transition", {
      from_status: "pending",
      to_status: "pending",
      from_stage_type: "review",
      to_stage_type: "approval",
      from_participant_type: "agent",
      to_participant_type: "user",
      decision_outcome: "approved",
    });
  });

  it("tracks rejected execution actors", () => {
    const client = createClient();

    trackIssueExecutionRejectedActor(client, {
      actorType: "agent",
      requestedStatus: "done",
      stageType: "review",
      currentParticipantType: "agent",
      actorMatchesCurrentParticipant: false,
    });

    expect(client.track).toHaveBeenCalledWith("issue.execution_actor_rejected", {
      actor_type: "agent",
      requested_status: "done",
      stage_type: "review",
      current_participant_type: "agent",
      actor_matches_current_participant: false,
    });
  });
});
