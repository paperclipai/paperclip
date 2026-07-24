import { describe, expect, it, vi } from "vitest";
import {
  trackAgentCreated,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackInteractionResolved,
  trackInstallCompleted,
} from "@paperclipai/shared/telemetry";
import type { EventDimensionsMap, TelemetryClient } from "@paperclipai/shared/telemetry";

function createClient(): TelemetryClient {
  return {
    track: vi.fn(),
    hashPrivateRef: vi.fn((value: string) => `hashed:${value}`),
  } as unknown as TelemetryClient;
}

function runtimeValue<T>(value: string): T {
  return value as T;
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

  it("passes an unrecognized agent role through for backend normalization", () => {
    const client = createClient();

    trackAgentCreated(client, {
      agentRole: runtimeValue<EventDimensionsMap["agent.created"]["agent_role"]>("coder"),
      agentId: "44444444-4444-4444-8444-444444444444",
    });

    expect(client.track).toHaveBeenCalledWith("agent.created", {
      agent_role: "coder",
      agent_id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("includes agent_id for agent.first_heartbeat", () => {
    const client = createClient();

    trackAgentFirstHeartbeat(client, {
      agentRole: "engineer",
      agentId: "22222222-2222-4222-8222-222222222222",
    });

    expect(client.track).toHaveBeenCalledWith("agent.first_heartbeat", {
      agent_role: "engineer",
      agent_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("includes agent_id for agent.task_completed", () => {
    const client = createClient();

    trackAgentTaskCompleted(client, {
      agentRole: "qa",
      agentId: "33333333-3333-4333-8333-333333333333",
      adapterType: "codex_local",
    });

    expect(client.track).toHaveBeenCalledWith("agent.task_completed", {
      agent_role: "qa",
      agent_id: "33333333-3333-4333-8333-333333333333",
      adapter_type: "codex_local",
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

  it("passes interaction.resolved enum dimensions through for backend normalization", () => {
    const client = createClient();

    trackInteractionResolved(client, {
      interactionKind: runtimeValue<EventDimensionsMap["interaction.resolved"]["interaction_kind"]>(
        "single_confirmation",
      ),
      status: "accepted",
      resolvedByKind: runtimeValue<EventDimensionsMap["interaction.resolved"]["resolved_by_kind"]>("operator"),
      resolutionReason: "accepted",
      createdByKind: "agent",
      creatorAgentRole: runtimeValue<EventDimensionsMap["interaction.resolved"]["creator_agent_role"]>("coder"),
      continuationPolicy: runtimeValue<EventDimensionsMap["interaction.resolved"]["continuation_policy"]>(
        "wake_everyone",
      ),
      targetType: "issue_document",
      optionCount: 2,
      selectedOptionCount: 1,
      skippedTaskCount: 3,
    });

    expect(client.track).toHaveBeenCalledWith("interaction.resolved", {
      interaction_kind: "single_confirmation",
      status: "accepted",
      resolved_by_kind: "operator",
      resolution_reason: "accepted",
      created_by_kind: "agent",
      creator_agent_role: "coder",
      continuation_policy: "wake_everyone",
      target_type: "issue_document",
      option_count: 2,
      selected_option_count: 1,
      skipped_task_count: 3,
    });
  });
});
