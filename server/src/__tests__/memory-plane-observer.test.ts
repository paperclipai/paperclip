import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock logger to avoid noise in tests
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  configureMemoryPlaneObserver,
  createLifecycleEvent,
  publishLifecycleEvent,
  getObserverConfig,
  getDeadLetterEntries,
  clearDeadLetterEntries,
  checkHonchoReachability,
  type MemoryPlaneObserverConfig,
} from "../services/memory-plane-observer.js";

const TEST_API_KEY = "test-key";
const TEST_WORKSPACE = "test-workspace";

const TEST_CONFIG: Partial<MemoryPlaneObserverConfig> = {
  enabled: true,
  ob1Instances: [
    { name: "aegis", url: "http://127.0.0.1:8787", apiKey: TEST_API_KEY },
    { name: "talaris", url: "http://127.0.0.1:8788", apiKey: TEST_API_KEY },
  ],
  hindsightUrl: "http://127.0.0.1:8888",
  hindsightBank: "hermes",
  honchoUrl: "http://127.0.0.1:8005",
  honchoApiKey: TEST_API_KEY,
  honchoWorkspaceId: TEST_WORKSPACE,
  holographicUrl: "http://127.0.0.1:8090",
  holographicApiKey: TEST_API_KEY,
  maxRetries: 2,
  baseRetryDelayMs: 10, // Fast for tests
};

function makeOkResponse(): Response {
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeErrorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function makeTestEvent(overrides?: Partial<ReturnType<typeof createLifecycleEvent>>) {
  return createLifecycleEvent({
    entityType: "goal",
    entityId: "00000000-0000-0000-0000-000000000001",
    companyId: "00000000-0000-0000-0000-000000000002",
    oldStatus: "planned",
    newStatus: "active",
    agentId: "00000000-0000-0000-0000-000000000003",
    actorType: "agent",
    actorId: "00000000-0000-0000-0000-000000000003",
    runId: null,
    metadata: { title: "Test Goal" },
    ...overrides,
  });
}

describe("memory-plane-observer", () => {
  beforeEach(() => {
    clearDeadLetterEntries();
    mockFetch.mockReset();
    configureMemoryPlaneObserver(TEST_CONFIG);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createLifecycleEvent", () => {
    it("creates an event with a unique UUID id", () => {
      const event1 = makeTestEvent();
      const event2 = makeTestEvent();
      expect(event1.id).not.toBe(event2.id);
      expect(event1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("includes all required fields", () => {
      const event = makeTestEvent();
      expect(event.entityType).toBe("goal");
      expect(event.oldStatus).toBe("planned");
      expect(event.newStatus).toBe("active");
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(event.metadata.title).toBe("Test Goal");
    });
  });

  describe("publishLifecycleEvent", () => {
    it("delivers to all planes on success", async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const event = makeTestEvent();
      const result = await publishLifecycleEvent(event);

      expect(result.allSucceeded).toBe(true);
      // OB1: 2 instances + Hindsight + Honcho (no-op success for non-achieved) + Holographic = 5 results
      // Honcho returns success=true with attempts=0 for non-achieved goals
      expect(result.results).toHaveLength(5);
      expect(result.results.every((r) => r.success)).toBe(true);
    });

    it("delivers to Honcho for goal:achieved events", async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const event = makeTestEvent({ newStatus: "achieved" });
      const result = await publishLifecycleEvent(event);

      // OB1: 2 instances + Hindsight + Honcho + Holographic = 5 fetch calls
      expect(result.results).toHaveLength(5);
      expect(result.results.some((r) => r.plane === "honcho" && r.success)).toBe(true);
    });

    it("skips Honcho for non-goal entities", async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const event = makeTestEvent({ entityType: "routine" });
      const result = await publishLifecycleEvent(event);

      // Honcho returns early with success=true (no-op for non-goal)
      const honchoResult = result.results.find((r) => r.plane === "honcho");
      expect(honchoResult?.success).toBe(true);
      expect(honchoResult?.attempts).toBe(0);
    });

    it("skips Honcho for goal:active (non-achieved)", async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const event = makeTestEvent({ newStatus: "active" });
      const result = await publishLifecycleEvent(event);

      const honchoResult = result.results.find((r) => r.plane === "honcho");
      expect(honchoResult?.success).toBe(true);
      expect(honchoResult?.attempts).toBe(0);
    });

    it("retries with exponential backoff on failure", async () => {
      // First call fails, second succeeds for each plane that makes fetch calls
      // Honcho is a no-op for goal:active (no fetch), so only OB1x2 + Hindsight + Holographic = 4 planes
      mockFetch
        .mockResolvedValueOnce(makeErrorResponse(500, "server error"))
        .mockResolvedValueOnce(makeOkResponse()) // OB1 aegis
        .mockResolvedValueOnce(makeErrorResponse(500, "server error"))
        .mockResolvedValueOnce(makeOkResponse()) // OB1 talaris
        .mockResolvedValueOnce(makeErrorResponse(500, "server error"))
        .mockResolvedValueOnce(makeOkResponse()) // Hindsight
        .mockResolvedValueOnce(makeErrorResponse(500, "server error"))
        .mockResolvedValueOnce(makeOkResponse()); // Holographic

      const event = makeTestEvent();
      const result = await publishLifecycleEvent(event);

      expect(result.allSucceeded).toBe(true);
      // Planes that made fetch calls should have taken 2 attempts (1 fail + 1 success)
      const fetchResults = result.results.filter((r) => r.attempts > 0);
      expect(fetchResults.every((r) => r.attempts === 2)).toBe(true);
    });

    it("dead-letters after exhausting retries", async () => {
      mockFetch.mockImplementation(async () => new Response("persistent error", { status: 500 }));

      const event = makeTestEvent();
      const result = await publishLifecycleEvent(event);

      expect(result.allSucceeded).toBe(false);
      const failedResults = result.results.filter((r) => !r.success);
      expect(failedResults.length).toBeGreaterThan(0);

      const deadLetters = getDeadLetterEntries();
      expect(deadLetters.length).toBeGreaterThan(0);
      expect(deadLetters.every((dl) => dl.attempts === TEST_CONFIG.maxRetries)).toBe(true);
    });

    it("does not duplicate delivery for same event ID (idempotency)", async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const event = makeTestEvent();
      await publishLifecycleEvent(event);
      const firstCallCount = mockFetch.mock.calls.length;

      // Publish the same event again
      await publishLifecycleEvent(event);
      const secondCallCount = mockFetch.mock.calls.length;

      // Should not have made any additional fetch calls
      expect(secondCallCount).toBe(firstCallCount);
    });

    it("skips fanout when disabled", async () => {
      configureMemoryPlaneObserver({ enabled: false });
      mockFetch.mockResolvedValue(makeOkResponse());

      const event = makeTestEvent();
      const result = await publishLifecycleEvent(event);

      expect(result.results).toHaveLength(0);
      expect(result.allSucceeded).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("handles unconfigured planes gracefully", async () => {
      configureMemoryPlaneObserver({
        enabled: true,
        ob1Instances: [],
        hindsightUrl: null,
        honchoUrl: null,
        honchoApiKey: null,
        honchoWorkspaceId: null,
        holographicUrl: null,
        holographicApiKey: null,
        maxRetries: 1,
        baseRetryDelayMs: 10,
      });

      const event = makeTestEvent();
      const result = await publishLifecycleEvent(event);

      // Hindsight and Holographic should report as failed (not configured)
      // Honcho should report as failed (not configured) but only for achieved goals
      // OB1 has no instances so no results from it
      const hindsightResult = result.results.find((r) => r.plane === "hindsight");
      expect(hindsightResult?.success).toBe(false);
      expect(hindsightResult?.error).toContain("not configured");

      const holographicResult = result.results.find((r) => r.plane === "holographic");
      expect(holographicResult?.success).toBe(false);
      expect(holographicResult?.error).toContain("not configured");
    });
  });

  describe("checkHonchoReachability", () => {
    const HONCHO_CONFIG: Partial<MemoryPlaneObserverConfig> = {
      enabled: true,
      ob1Instances: [],
      hindsightUrl: null,
      honchoUrl: "http://127.0.0.1:8005",
      honchoApiKey: TEST_API_KEY,
      honchoWorkspaceId: TEST_WORKSPACE,
      holographicUrl: null,
      holographicApiKey: null,
      maxRetries: 1,
      baseRetryDelayMs: 10,
    };

    it("reports reachable=true on a 2xx response", async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      const result = await checkHonchoReachability(HONCHO_CONFIG);

      expect(result.reachable).toBe(true);
      expect(result.error).toBeNull();
      expect(result.status).toBe(200);
    });

    it("reports reachable=false on a 422 (Honcho rejects a body) and surfaces the status", async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(422, "body not allowed"));

      const result = await checkHonchoReachability(HONCHO_CONFIG);

      expect(result.reachable).toBe(false);
      expect(result.status).toBe(422);
      expect(result.error).toContain("422");
    });

    it("sends NO request body (null), never JSON.stringify({})", async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      await checkHonchoReachability(HONCHO_CONFIG);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBeNull();
      expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    });

    it("targets the /v3/workspaces/list probe endpoint", async () => {
      mockFetch.mockResolvedValue(makeOkResponse());

      await checkHonchoReachability(HONCHO_CONFIG);

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:8005/v3/workspaces/list");
    });

    it("reports a clear reason when Honcho URL is not configured", async () => {
      const result = await checkHonchoReachability({
        ...HONCHO_CONFIG,
        honchoUrl: null,
      });

      expect(result.reachable).toBe(false);
      expect(result.status).toBeNull();
      expect(result.error).toContain("Honcho URL not configured");
    });

    it("reports a clear reason when Honcho API key is not configured", async () => {
      const result = await checkHonchoReachability({
        ...HONCHO_CONFIG,
        honchoApiKey: null,
      });

      expect(result.reachable).toBe(false);
      expect(result.status).toBeNull();
      expect(result.error).toContain("Honcho API key not configured");
    });

    it("reports reachable=false with status null when the request throws", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await checkHonchoReachability(HONCHO_CONFIG);

      expect(result.reachable).toBe(false);
      expect(result.status).toBeNull();
      expect(result.error).toContain("Honcho request failed");
    });
  });

  describe("dead-letter recovery", () => {
    it("stores dead-letter entries with full event context", async () => {
      // Use a custom error body that doesn't need to be read twice
      mockFetch.mockImplementation(async () => {
        return new Response("persistent error", { status: 500 });
      });

      const event = makeTestEvent({ newStatus: "achieved" });
      await publishLifecycleEvent(event);

      const deadLetters = getDeadLetterEntries();
      expect(deadLetters.length).toBeGreaterThan(0);
      expect(deadLetters[0].event.id).toBe(event.id);
      expect(deadLetters[0].event.entityType).toBe("goal");
      expect(deadLetters[0].error).toContain("500");
      expect(deadLetters[0].finalAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("can be cleared", async () => {
      mockFetch.mockImplementation(async () => new Response("error", { status: 500 }));

      const event = makeTestEvent();
      await publishLifecycleEvent(event);

      expect(getDeadLetterEntries().length).toBeGreaterThan(0);
      clearDeadLetterEntries();
      expect(getDeadLetterEntries().length).toBe(0);
    });
  });
});
