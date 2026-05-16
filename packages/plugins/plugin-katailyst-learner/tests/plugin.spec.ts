import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest, { RUN_COMPLETE_EVENT } from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

describe("Katailyst Learner plugin", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("posts successful Paperclip run-complete events to Katailyst", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        enabled: true,
        endpointUrl: "https://katailyst.example/api/hermes/learner/run-complete",
        secretRef: "secret/katailyst-learner",
        paperclipBaseUrl: "https://paperclip.example",
      },
    });
    await plugin.definition.setup?.(harness.ctx);

    await harness.emit(
      RUN_COMPLETE_EVENT,
      {
        runId: "run_1",
        agentId: "agent_1",
        status: "succeeded",
        invocationSource: "issue_assignment",
        triggerDetail: "operator",
        issueId: "issue_1",
        startedAt: "2026-05-16T01:00:00.000Z",
        finishedAt: "2026-05-16T01:02:00.000Z",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          outputTokens: 40,
          costUsd: 0.12,
          provider: "openai",
          model: "gpt-test",
        },
      },
      {
        companyId: COMPANY_ID,
        eventId: "event_1",
        actorId: "agent_1",
        actorType: "agent",
        entityId: "run_1",
        entityType: "heartbeat_run",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://katailyst.example/api/hermes/learner/run-complete");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer resolved:secret/katailyst-learner",
        "content-type": "application/json",
      }),
    );
    expect(JSON.parse(String(init.body))).toEqual(
      expect.objectContaining({
        source: "paperclip",
        event_id: "event_1",
        event_type: RUN_COMPLETE_EVENT,
        company_id: COMPANY_ID,
        run_id: "run_1",
        agent_id: "agent_1",
        issue_id: "issue_1",
        status: "succeeded",
        paperclip_url: "https://paperclip.example/heartbeat-runs/run_1",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          outputTokens: 40,
          costUsd: 0.12,
          provider: "openai",
          model: "gpt-test",
        },
      }),
    );
    expect(harness.activity.at(-1)?.message).toBe(
      "Sent Paperclip run-complete event to Katailyst Learner",
    );
  });

  it("logs configuration gaps without throwing or delivering", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        enabled: true,
      },
    });
    await plugin.definition.setup?.(harness.ctx);

    await harness.emit(
      RUN_COMPLETE_EVENT,
      { runId: "run_2", agentId: "agent_2", status: "succeeded" },
      { companyId: COMPANY_ID, entityId: "run_2", entityType: "heartbeat_run" },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.activity.at(-1)?.message).toBe("Katailyst Learner webhook is not configured");
  });

  it("records rejected deliveries without breaking Paperclip run completion", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const harness = createTestHarness({
      manifest,
      config: {
        enabled: true,
        endpointUrl: "https://katailyst.example/api/hermes/learner/run-complete",
        secretRef: "secret/katailyst-learner",
      },
    });
    await plugin.definition.setup?.(harness.ctx);

    await harness.emit(
      RUN_COMPLETE_EVENT,
      { runId: "run_3", agentId: "agent_3", status: "succeeded" },
      { companyId: COMPANY_ID, entityId: "run_3", entityType: "heartbeat_run" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.activity.at(-1)?.message).toBe(
      "Katailyst Learner rejected a run-complete event",
    );
    expect(harness.logs.some((entry) => entry.level === "warn")).toBe(true);
  });
});
