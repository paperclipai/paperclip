import { describe, expect, it, vi } from "vitest";
import { BrabrixClient } from "../integrations/brabrix/brabrix-client.js";
import type { BrabrixConfig } from "../integrations/brabrix/brabrix-config.js";

function baseConfig(overrides: Partial<BrabrixConfig> = {}): BrabrixConfig {
  return {
    apiUrl: "https://api.brabrix.dev",
    agentToken: "token-123",
    projectId: "project-1",
    agentId: "agent-7",
    provider: "brabrix-dev",
    endpoints: {
      projectContext: "/v1/projects/{projectId}/context",
      nextTask: "/v1/projects/{projectId}/tasks/next",
      sendRunLogs: "/v1/projects/{projectId}/runs/{runId}/logs",
      completeTask: "/v1/projects/{projectId}/tasks/{taskId}/complete",
    },
    timeoutMs: 10_000,
    maxRetries: 2,
    retryDelayMs: 1,
    ...overrides,
  };
}

describe("BrabrixClient", () => {
  it("loads project context and next task using endpoint templates", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          projectContext: {
            projectId: "project-1",
            name: "Brabrix Demo",
            skills: [{ skillKey: "sales.copywriter", name: "Sales Copywriter" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          nextTask: {
            taskId: "task-99",
            title: "Escrever proposta",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));

    const client = new BrabrixClient(baseConfig(), fetchMock);
    const context = await client.getProjectContext();
    const task = await client.getNextTask();

    expect(context?.projectId).toBe("project-1");
    expect(context?.skills?.[0]?.skillKey).toBe("sales.copywriter");
    expect(task?.taskId).toBe("task-99");

    const firstCall = fetchMock.mock.calls[0];
    const firstUrl = String(firstCall?.[0]);
    const firstInit = firstCall?.[1];
    expect(firstUrl).toContain("/v1/projects/project-1/context");
    expect(firstInit?.method).toBe("GET");
    expect((firstInit?.headers as Record<string, string>)["authorization"]).toBe("Bearer token-123");
  });

  it("retries retryable HTTP errors before succeeding", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new BrabrixClient(baseConfig({ maxRetries: 1, retryDelayMs: 1 }), fetchMock);
    await client.sendRunLogs({
      taskId: "task-5",
      runId: "run-11",
      logs: [{ timestamp: new Date().toISOString(), level: "info", message: "hello" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires BRABRIX_API_URL when endpoints are relative", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new BrabrixClient(baseConfig({ apiUrl: null }), fetchMock);

    await expect(client.getNextTask()).rejects.toThrow("BRABRIX_API_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
