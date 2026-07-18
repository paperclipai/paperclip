import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentHireTimeoutError,
  agentsApi,
  createOrReuseAgentHireAttempt,
} from "./agents";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const pendingResponse = {
  operationId: "operation-123",
  status: "pending",
  stage: "creating",
  statusUrl: "/agent-hire-operations/operation-123",
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("agent hire reconciliation", () => {
  it("reuses a caller attempt for an explicit retry of the same payload", () => {
    const first = createOrReuseAgentHireAttempt(null, { name: "Builder", role: "engineer" });
    const retry = createOrReuseAgentHireAttempt(first, { name: "Builder", role: "engineer" });
    const changed = createOrReuseAgentHireAttempt(first, { name: "Different", role: "engineer" });

    expect(retry).toBe(first);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("reuses the caller-owned idempotency key across polls", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(pendingResponse))
      .mockResolvedValueOnce(jsonResponse({ agent: { id: "agent-123" }, approval: null }));

    const resultPromise = agentsApi.hire(
      "company-123",
      { name: "Builder" },
      { idempotencyKey: "caller-owned-key" },
    );
    await vi.advanceTimersByTimeAsync(250);

    await expect(resultPromise).resolves.toMatchObject({ agent: { id: "agent-123" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers((call[1] as RequestInit).headers);
      expect(headers.get("Idempotency-Key")).toBe("caller-owned-key");
    }
  });

  it("stops reconciliation when the caller aborts", async () => {
    fetchMock.mockResolvedValue(jsonResponse(pendingResponse));
    const controller = new AbortController();

    const resultPromise = agentsApi.hire(
      "company-123",
      { name: "Builder" },
      { idempotencyKey: "abort-key", signal: controller.signal },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops reconciliation at its finite deadline", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(pendingResponse));

    const resultPromise = agentsApi.hire(
      "company-123",
      { name: "Builder" },
      { idempotencyKey: "deadline-key", timeoutMs: 500 },
    );
    const rejection = expect(resultPromise).rejects.toMatchObject({
      name: "AgentHireTimeoutError",
      idempotencyKey: "deadline-key",
      timeoutMs: 500,
    } satisfies Partial<AgentHireTimeoutError>);
    await vi.advanceTimersByTimeAsync(500);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
