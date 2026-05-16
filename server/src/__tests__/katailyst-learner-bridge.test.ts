import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { maybeDeliverKatailystLearnerRunComplete } from "../services/katailyst-learner-bridge.js";

const originalEnv = { ...process.env };

function runFinishedEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "evt_1",
    eventType: "agent.run.finished",
    occurredAt: "2026-05-16T00:00:00.000Z",
    actorId: "agent_1",
    actorType: "agent",
    entityId: "run_1",
    entityType: "heartbeat_run",
    companyId: "company_1",
    payload: {
      runId: "run_1",
      agentId: "agent_1",
      status: "succeeded",
      invocationSource: "manual",
      triggerDetail: "operator",
      issueId: "issue_1",
      startedAt: "2026-05-15T23:59:00.000Z",
      finishedAt: "2026-05-16T00:00:00.000Z",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 40,
        costUsd: 0.12,
        provider: "openai",
        model: "gpt-test",
      },
    },
    ...overrides,
  };
}

describe("Katailyst Learner bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("delivers successful run-complete events when configured", async () => {
    process.env.KATAILYST_LEARNER_ENDPOINT_URL = "https://katailyst.example/api/hermes/learner/run-complete";
    process.env.HERMES_LEARNER_WEBHOOK_SECRET = "test-secret";
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await maybeDeliverKatailystLearnerRunComplete(runFinishedEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://katailyst.example/api/hermes/learner/run-complete");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-secret");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "paperclip",
      event_id: "evt_1",
      event_type: "agent.run.finished",
      company_id: "company_1",
      run_id: "run_1",
      agent_id: "agent_1",
      issue_id: "issue_1",
      status: "succeeded",
      invocation_source: "manual",
      trigger_detail: "operator",
      paperclip_url: "https://paperclip.example/heartbeat-runs/run_1",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 40,
        costUsd: 0.12,
        provider: "openai",
        model: "gpt-test",
      },
    });
  });

  it("skips delivery when the bridge is not configured", async () => {
    process.env.KATAILYST_LEARNER_ENDPOINT_URL = "https://katailyst.example/api/hermes/learner/run-complete";
    delete process.env.HERMES_LEARNER_WEBHOOK_SECRET;
    delete process.env.KATAILYST_LEARNER_WEBHOOK_SECRET;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await maybeDeliverKatailystLearnerRunComplete(runFinishedEvent());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
