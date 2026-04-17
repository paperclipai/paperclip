/**
 * Worker unit tests — validate plugin lifecycle: setup, health, config
 * validation, config change, shutdown and event subscription wiring.
 *
 * Strategy: vi.mock the plugin-sdk so definePlugin captures the PluginDefinition
 * without starting a real worker, then exercise each lifecycle method with a
 * mocked PluginContext.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — declare shared mutable state that mock factories can access
// ---------------------------------------------------------------------------

const {
  holder,
  mockOtelShutdown,
  mockMeterGaugeCallback,
  mockMeterCreateObservableGauge,
} = vi.hoisted(() => {
  const mockOtelShutdown = vi.fn(async () => {});
  const mockMeterGaugeCallback = vi.fn();
  const mockMeterCreateObservableGauge = vi.fn(() => ({
    addCallback: mockMeterGaugeCallback,
  }));

  return {
    holder: { definition: null as any },
    mockOtelShutdown,
    mockMeterGaugeCallback,
    mockMeterCreateObservableGauge,
  };
});

// ---------------------------------------------------------------------------
// Mocks (hoisted by vitest above the import of ../src/worker.js)
// ---------------------------------------------------------------------------

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin(def: unknown) {
    holder.definition = def;
    return { definition: def };
  },
  runWorker() {},
}));

vi.mock("../src/otel-setup.js", () => ({
  initOTel: vi.fn(() => ({
    sdk: {},
    tracer: {
      startSpan: vi.fn(() => ({
        setAttribute: vi.fn().mockReturnThis(),
        setAttributes: vi.fn().mockReturnThis(),
        setStatus: vi.fn().mockReturnThis(),
        end: vi.fn(),
        spanContext: () => ({ traceId: "t1", spanId: "s1", traceFlags: 1 }),
        recordException: vi.fn().mockReturnThis(),
        addEvent: vi.fn().mockReturnThis(),
        isRecording: () => true,
        updateName: vi.fn().mockReturnThis(),
        addLink: vi.fn().mockReturnThis(),
        addLinks: vi.fn().mockReturnThis(),
      })),
      startActiveSpan: vi.fn(),
    },
    meter: {
      createObservableGauge: mockMeterCreateObservableGauge,
      createCounter: vi.fn(() => ({ add: vi.fn() })),
      createHistogram: vi.fn(() => ({ record: vi.fn() })),
      createUpDownCounter: vi.fn(),
      createObservableCounter: vi.fn(),
      createObservableUpDownCounter: vi.fn(),
      createGauge: vi.fn(),
      addBatchObservableCallback: vi.fn(),
      removeBatchObservableCallback: vi.fn(),
    },
    otelLogger: { emit: vi.fn() },
    shutdown: mockOtelShutdown,
  })),
  TOKEN_USAGE_BUCKETS: [],
  OPERATION_DURATION_BUCKETS: [],
}));

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
  trace: { getTracer: vi.fn() },
  metrics: { getMeter: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import the worker — this triggers definePlugin() and captures the definition
// ---------------------------------------------------------------------------

import "../src/worker.js";

// ---------------------------------------------------------------------------
// Mock PluginContext factory
// ---------------------------------------------------------------------------

function createMockPluginContext() {
  return {
    config: { get: vi.fn().mockResolvedValue({}) },
    events: { on: vi.fn() },
    jobs: { register: vi.fn() },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    companies: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    projects: { list: vi.fn().mockResolvedValue([]) },
    issues: { list: vi.fn().mockResolvedValue([]) },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captured a PluginDefinition via definePlugin", () => {
    expect(holder.definition).not.toBeNull();
    expect(typeof holder.definition.setup).toBe("function");
    expect(typeof holder.definition.onHealth).toBe("function");
    expect(typeof holder.definition.onConfigChanged).toBe("function");
    expect(typeof holder.definition.onValidateConfig).toBe("function");
    expect(typeof holder.definition.onShutdown).toBe("function");
  });

  describe("setup", () => {
    it("subscribes to all 11 event types", async () => {
      const mockCtx = createMockPluginContext();
      await holder.definition.setup(mockCtx);

      const eventTypesSubscribed = mockCtx.events.on.mock.calls.map(
        (call: unknown[]) => call[0],
      );
      expect(eventTypesSubscribed).toContain("agent.run.started");
      expect(eventTypesSubscribed).toContain("agent.run.finished");
      expect(eventTypesSubscribed).toContain("agent.run.failed");
      expect(eventTypesSubscribed).toContain("agent.run.cancelled");
      expect(eventTypesSubscribed).toContain("cost_event.created");
      expect(eventTypesSubscribed).toContain("issue.created");
      expect(eventTypesSubscribed).toContain("issue.updated");
      expect(eventTypesSubscribed).toContain("agent.status_changed");
      expect(eventTypesSubscribed).toContain("approval.created");
      expect(eventTypesSubscribed).toContain("approval.decided");
      expect(eventTypesSubscribed).toContain("activity.logged");
      expect(eventTypesSubscribed).toContain("agent.session.created");
      expect(eventTypesSubscribed).toContain("agent.session.chunk");
      expect(eventTypesSubscribed).toContain("agent.session.status");
      expect(eventTypesSubscribed).toContain("agent.session.done");
      expect(eventTypesSubscribed).toContain("agent.session.error");
      expect(mockCtx.events.on).toHaveBeenCalledTimes(16);
    });

    it("registers the collect-metrics job", async () => {
      const mockCtx = createMockPluginContext();
      await holder.definition.setup(mockCtx);

      expect(mockCtx.jobs.register).toHaveBeenCalledOnce();
      expect(mockCtx.jobs.register.mock.calls[0][0]).toBe("collect-metrics");
      expect(typeof mockCtx.jobs.register.mock.calls[0][1]).toBe("function");
    });

    it("logs activity on successful initialization", async () => {
      const mockCtx = createMockPluginContext();
      await holder.definition.setup(mockCtx);

      expect(mockCtx.activity.log).toHaveBeenCalled();
    });

    it("creates observable gauges for agent, issue, and governance metrics", async () => {
      const mockCtx = createMockPluginContext();
      await holder.definition.setup(mockCtx);

      // 10 observable gauges registered in worker.ts
      expect(mockMeterCreateObservableGauge.mock.calls.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("onHealth", () => {
    it("returns ok status when OTel is initialised", async () => {
      const mockCtx = createMockPluginContext();
      await holder.definition.setup(mockCtx);

      const health = await holder.definition.onHealth();
      expect(health.status).toBe("ok");
      expect(health.message).toMatch(/events processed/);
    });
  });

  describe("onValidateConfig", () => {
    it("returns ok for valid config", async () => {
      const result = await holder.definition.onValidateConfig({
        otlpEndpoint: "http://localhost:4318",
        exportIntervalMs: 60000,
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects non-http otlpEndpoint", async () => {
      const result = await holder.definition.onValidateConfig({
        otlpEndpoint: "ftp://example.com",
      });
      expect(result.ok).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.errors![0]).toMatch(/http/);
    });

    it("warns on very low exportIntervalMs", async () => {
      const result = await holder.definition.onValidateConfig({
        exportIntervalMs: 500,
      });
      expect(result.ok).toBe(true);
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0]).toMatch(/1000ms/);
    });

    it("returns ok with no warnings for reasonable interval", async () => {
      const result = await holder.definition.onValidateConfig({
        exportIntervalMs: 30000,
      });
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("onConfigChanged", () => {
    it("shuts down old OTel SDK and reinitialises", async () => {
      const mockCtx = createMockPluginContext();
      await holder.definition.setup(mockCtx);
      vi.clearAllMocks();

      await holder.definition.onConfigChanged({
        otlpEndpoint: "http://new-collector:4318",
      });

      expect(mockOtelShutdown).toHaveBeenCalledOnce();
    });
  });

  describe("onShutdown", () => {
    it("shuts down the OTel SDK", async () => {
      const mockCtx = createMockPluginContext();
      await holder.definition.setup(mockCtx);
      vi.clearAllMocks();

      await holder.definition.onShutdown();

      expect(mockOtelShutdown).toHaveBeenCalledOnce();
    });
  });

  describe("collect-metrics job", () => {
    it("fetches companies, agents, projects, and issues", async () => {
      const mockCtx = createMockPluginContext();
      mockCtx.companies.list.mockResolvedValue([
        { id: "c1", budgetMonthlyCents: 10000, spentMonthlyCents: 5000 },
      ]);
      mockCtx.agents.list.mockResolvedValue([
        {
          id: "a1",
          name: "Agent A",
          role: "engineer",
          status: "running",
          lastHeartbeatAt: new Date().toISOString(),
          budgetMonthlyCents: 5000,
          spentMonthlyCents: 2000,
        },
      ]);
      mockCtx.projects.list.mockResolvedValue([
        { id: "p1", name: "Project 1", pauseReason: null },
      ]);
      mockCtx.issues.list.mockResolvedValue([
        { id: "i1", projectId: "p1", status: "in_progress" },
        { id: "i2", projectId: "p1", status: "done" },
      ]);
      mockCtx.state.get.mockResolvedValue(2);

      await holder.definition.setup(mockCtx);

      // Get the registered job callback
      const jobCallback = mockCtx.jobs.register.mock.calls[0][1] as (
        job: unknown,
      ) => Promise<void>;

      await jobCallback({
        jobKey: "collect-metrics",
        runId: "jr1",
        trigger: "schedule",
        scheduledAt: new Date().toISOString(),
      });

      expect(mockCtx.companies.list).toHaveBeenCalled();
      expect(mockCtx.agents.list).toHaveBeenCalled();
      expect(mockCtx.projects.list).toHaveBeenCalled();
      expect(mockCtx.issues.list).toHaveBeenCalled();
      expect(mockCtx.activity.log).toHaveBeenCalled();
    });
  });
});
