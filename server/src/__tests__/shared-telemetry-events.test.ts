import { describe, expect, it, vi } from "vitest";
import {
  trackAgentCreated,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackInstallCompleted,
} from "@paperclipai/shared/telemetry";
import type { TelemetryClient } from "@paperclipai/shared/telemetry";

const HASHES_BY_AGENT_ID = new Map([
  ["11111111-1111-4111-8111-111111111111", "1719c104ec07b03e"],
  ["22222222-2222-4222-8222-222222222222", "d80e1b8ab30d1931"],
  ["33333333-3333-4333-8333-333333333333", "24810192f01670c5"],
]);

function createClient(): TelemetryClient {
  return {
    track: vi.fn(),
    hashPrivateRef: vi.fn((value: string) => {
      const hash = HASHES_BY_AGENT_ID.get(value);
      if (!hash) throw new Error(`Unexpected test agent id: ${value}`);
      return hash;
    }),
  } as unknown as TelemetryClient;
}

describe("shared telemetry agent events", () => {
  it("hashes agent_id for agent.created", () => {
    const client = createClient();
    const agentId = "11111111-1111-4111-8111-111111111111";

    trackAgentCreated(client, {
      agentRole: "engineer",
      agentId,
    });

    expect(client.track).toHaveBeenCalledWith("agent.created", {
      agent_role: "engineer",
      agent_id_hashed: "1719c104ec07b03e",
      agent_id_is_hashed: true,
    });
    expect(client.track).not.toHaveBeenCalledWith(
      "agent.created",
      expect.objectContaining({ agent_id: agentId }),
    );
    expect(client.hashPrivateRef).toHaveBeenCalledWith(agentId);
  });

  it("hashes agent_id for agent.first_heartbeat", () => {
    const client = createClient();
    const agentId = "22222222-2222-4222-8222-222222222222";

    trackAgentFirstHeartbeat(client, {
      agentRole: "coder",
      agentId,
    });

    expect(client.track).toHaveBeenCalledWith("agent.first_heartbeat", {
      agent_role: "coder",
      agent_id_hashed: "d80e1b8ab30d1931",
      agent_id_is_hashed: true,
    });
    expect(client.track).not.toHaveBeenCalledWith(
      "agent.first_heartbeat",
      expect.objectContaining({ agent_id: agentId }),
    );
    expect(client.hashPrivateRef).toHaveBeenCalledWith(agentId);
  });

  it("hashes agent_id for agent.task_completed", () => {
    const client = createClient();
    const agentId = "33333333-3333-4333-8333-333333333333";

    trackAgentTaskCompleted(client, {
      agentRole: "qa",
      agentId,
    });

    expect(client.track).toHaveBeenCalledWith("agent.task_completed", {
      agent_role: "qa",
      agent_id_hashed: "24810192f01670c5",
      agent_id_is_hashed: true,
    });
    expect(client.track).not.toHaveBeenCalledWith(
      "agent.task_completed",
      expect.objectContaining({ agent_id: agentId }),
    );
    expect(client.hashPrivateRef).toHaveBeenCalledWith(agentId);
  });

  it("omits agent hash dimensions when agent_id is absent", () => {
    const client = createClient();

    trackAgentCreated(client, { agentRole: "engineer" });
    trackAgentFirstHeartbeat(client, { agentRole: "coder" });
    trackAgentTaskCompleted(client, { agentRole: "qa" });

    for (const [eventName, agentRole] of [
      ["agent.created", "engineer"],
      ["agent.first_heartbeat", "coder"],
      ["agent.task_completed", "qa"],
    ]) {
      expect(client.track).toHaveBeenCalledWith(eventName, {
        agent_role: agentRole,
      });
      expect(client.track).not.toHaveBeenCalledWith(
        eventName,
        expect.objectContaining({
          agent_id_hashed: expect.any(String),
          agent_id_is_hashed: expect.any(Boolean),
        }),
      );
    }
    expect(client.hashPrivateRef).not.toHaveBeenCalled();
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
});
