import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import {
  trackAgentTaskRun,
  trackArtifactCreated,
  trackModelConnected,
  trackPlanApproved,
  trackPlanCreated,
  trackTaskBlocked,
  trackTaskCompleted,
  trackTaskCreated,
} from "./events.js";
import { PAPERCLIP_EVENTS } from "./generated/paperclip-telemetry.js";
import { EVENT_RETENTION_CLASS } from "./retention.js";
import type { TelemetryState } from "./types.js";

const TEST_STATE: TelemetryState = {
  installId: "test-install",
  salt: "test-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

const NEW_EVENTS = [
  "model.connected",
  "task.created",
  "task.completed",
  "task.blocked",
  "plan.created",
  "plan.approved",
  "artifact.created",
] as const;

function makeClient() {
  return new TelemetryClient({ enabled: true, endpoint: "http://localhost:9999/ingest" }, () => TEST_STATE, "0.0.0-test", () => 0.5);
}

function emitAll(client: TelemetryClient) {
  trackModelConnected(client, { provider: "openrouter", connectionMethod: "api_key", ownership: "shared", routingKind: "openrouter", firstForCompany: true });
  trackModelConnected(client, { provider: "anthropic", connectionMethod: "subscription", ownership: "personal", routingKind: null, firstForCompany: false });
  trackTaskCreated(client, { createdByKind: "onboarding", isSubtask: false });
  trackTaskCompleted(client, { completedByKind: "agent", isSubtask: true });
  trackTaskBlocked(client, { blockedReason: "waiting_on_task", blockedByKind: "user" });
  trackPlanCreated(client, { createdByKind: "agent", atTaskCreation: false });
  trackPlanApproved(client, { approvedByKind: "user", startsExecution: true });
  trackArtifactCreated(client, { artifactType: "pull_request", provider: "github", creationFlow: "direct" });
  trackAgentTaskRun(client, { agentId: "agent-1", state: "failed", failureCause: "provider_limit" });
  trackAgentTaskRun(client, { agentId: "agent-1", state: "succeeded" });
}

describe("product lifecycle telemetry helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers every new event in the generated contract with enum/count retention", () => {
    for (const name of NEW_EVENTS) {
      expect(Object.hasOwn(PAPERCLIP_EVENTS, name)).toBe(true);
      expect(EVENT_RETENTION_CLASS[name]).toBe("operational_enum_count");
    }
  });

  it("maps helper input to the registered dimension names and omits absent optional values", () => {
    const client = makeClient();
    const track = vi.spyOn(client, "track");
    emitAll(client);
    expect(track.mock.calls).toEqual([
      ["model.connected", { provider: "openrouter", connection_method: "api_key", ownership: "shared", routing_kind: "openrouter", first_for_company: true }],
      ["model.connected", { provider: "anthropic", connection_method: "subscription", ownership: "personal", first_for_company: false }],
      ["task.created", { created_by_kind: "onboarding", is_subtask: false }],
      ["task.completed", { completed_by_kind: "agent", is_subtask: true }],
      ["task.blocked", { blocked_reason: "waiting_on_task", blocked_by_kind: "user" }],
      ["plan.created", { created_by_kind: "agent", at_task_creation: false }],
      ["plan.approved", { approved_by_kind: "user", starts_execution: true }],
      ["artifact.created", { artifact_type: "pull_request", provider: "github", creation_flow: "direct" }],
      ["agent.task_run", { agent_id: "agent-1", state: "failed", failure_cause: "provider_limit" }],
      ["agent.task_run", { agent_id: "agent-1", state: "succeeded" }],
    ]);
  });

  it("sends a collector envelope with only the registered dimensions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const client = makeClient();
    emitAll(client);
    await client.flush();
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.events.map((event: { name: string }) => event.name)).toEqual([
      "model.connected", "model.connected", "task.created", "task.completed", "task.blocked",
      "plan.created", "plan.approved", "artifact.created", "agent.task_run", "agent.task_run",
    ]);
    for (const event of body.events as Array<{ dimensions: Record<string, unknown> }>) {
      for (const value of Object.values(event.dimensions)) {
        expect(["string", "boolean", "number"]).toContain(typeof value);
      }
      expect(Object.keys(event.dimensions).every((key) => /^[a-z_]+$/.test(key))).toBe(true);
    }
    expect(body.events[2].dimensions).toEqual({ created_by_kind: "onboarding", is_subtask: false });
  });
});
