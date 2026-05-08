import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockTrack = vi.fn();
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: mockTrack }),
}));

const mockGetExperimental = vi.fn();
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
}));

const mockIssueCreate = vi.fn();
const mockIssueUpdate = vi.fn();
const mockIssueAddComment = vi.fn();
vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    create: mockIssueCreate,
    update: mockIssueUpdate,
    addComment: mockIssueAddComment,
  }),
}));

vi.mock("@paperclipai/shared", async () => {
  const actual = await vi.importActual("@paperclipai/shared");
  return { ...actual };
});

/**
 * Minimal mock Db that simulates agent_failure_state in-memory
 * behind Drizzle's chainable API.
 */
function createMockDb(options: {
  agents?: Map<string, any>;
  companies?: Map<string, any>;
}) {
  const failureState = new Map<string, {
    agentId: string;
    consecutiveAdapterFailures: number;
    consecutiveSuccesses: number;
    firstFailureRunId: string | null;
    lastFailureRunId: string | null;
    openAutoIssueId: string | null;
    updatedAt: Date;
  }>();

  const openOriginIssues: Array<{ id: string }> = [];

  const mockTx = {
    execute: vi.fn(async (query: any) => {
      const chunks = query?.queryChunks ?? [];
      const sqlText = chunks
        .filter((c: any) => c?.value)
        .map((c: any) => c.value.join(""))
        .join("");
      if (sqlText.includes("INSERT INTO")) {
        const agentId = chunks.find((c: any) => typeof c === "string");
        if (agentId && !failureState.has(agentId)) {
          failureState.set(agentId, {
            agentId,
            consecutiveAdapterFailures: 0,
            consecutiveSuccesses: 0,
            firstFailureRunId: null,
            lastFailureRunId: null,
            openAutoIssueId: null,
            updatedAt: new Date(),
          });
        }
      }
      return [];
    }),
    select: vi.fn((...args: any[]) => {
      const isProjectedSelect = args.length > 0 && typeof args[0] === "object";
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => {
            if (isProjectedSelect) {
              return Promise.resolve([...openOriginIssues]);
            }
            return Promise.resolve([...failureState.values()]);
          }),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((vals: any) => {
        if (!failureState.has(vals?.agentId ?? "")) {
          failureState.set(vals.agentId, {
            agentId: vals.agentId,
            consecutiveAdapterFailures: 0,
            consecutiveSuccesses: 0,
            firstFailureRunId: null,
            lastFailureRunId: null,
            openAutoIssueId: null,
            updatedAt: new Date(),
          });
        }
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: any) => ({
        where: vi.fn((pred: any) => {
          for (const [key, row] of failureState) {
            const next = { ...row, updatedAt: new Date() };
            if ("consecutiveAdapterFailures" in vals) next.consecutiveAdapterFailures = vals.consecutiveAdapterFailures;
            if ("consecutiveSuccesses" in vals) next.consecutiveSuccesses = vals.consecutiveSuccesses;
            if ("firstFailureRunId" in vals) next.firstFailureRunId = vals.firstFailureRunId;
            if ("lastFailureRunId" in vals) next.lastFailureRunId = vals.lastFailureRunId;
            if ("openAutoIssueId" in vals) {
              next.openAutoIssueId = typeof vals.openAutoIssueId === "object"
                ? randomUUID() : vals.openAutoIssueId;
            }
            failureState.set(key, next);
          }
          return Promise.resolve();
        }),
      })),
    })),
  };

  const db: any = {
    transaction: vi.fn(async (fn: any) => fn(mockTx)),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: vi.fn(async (fn: any) => {
            return fn([]);
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: randomUUID() }]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {}),
      })),
    })),
    _failureState: failureState,
    _openOriginIssues: openOriginIssues,
    _tx: mockTx,
  };

  return db;
}

describe("adapter-failure-hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flag-off: no side effects", async () => {
    mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: false });
    const db = createMockDb({ agents: new Map(), companies: new Map() });

    const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
    const hook = adapterFailureHookService(db);

    await hook.executeHook({
      runId: randomUUID(),
      agentId: randomUUID(),
      companyId: randomUUID(),
      status: "failed",
      errorCode: "adapter_failed",
      errorMessage: "boom",
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("single failure: counter=1, no issue created, telemetry emitted", async () => {
    mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
    const db = createMockDb({ agents: new Map(), companies: new Map() });
    const agentId = randomUUID();

    const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
    const hook = adapterFailureHookService(db);

    await hook.executeHook({
      runId: randomUUID(),
      agentId,
      companyId: randomUUID(),
      status: "failed",
      errorCode: "adapter_failed",
      errorMessage: "error",
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueCreate).not.toHaveBeenCalled();
    const state = db._failureState.get(agentId);
    expect(state?.consecutiveAdapterFailures).toBe(1);

    expect(mockTrack).toHaveBeenCalledWith(
      "agent.adapter_failure.consecutive_count",
      expect.objectContaining({ agent_id: agentId, count: 1 }),
    );
  });

  it("two consecutive failures: creates exactly one auto-issue, emits both metrics", async () => {
    mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
    const db = createMockDb({ agents: new Map(), companies: new Map() });
    const agentId = randomUUID();
    const companyId = randomUUID();
    const run1 = randomUUID();
    const run2 = randomUUID();

    // Mock the outer db.select for agent/company lookups in createAutoIssue
    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: vi.fn(async (fn: any) => fn([{
            id: agentId,
            name: "TestAgent",
            companyId,
            adapterType: "claude_local",
            adapterConfig: { provider: "anthropic", model: "opus" },
            status: "idle",
            reportsTo: null,
          }])),
        })),
      })),
    });

    mockIssueCreate.mockResolvedValue({ id: randomUUID() });

    const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
    const hook = adapterFailureHookService(db);

    // First failure
    await hook.executeHook({
      runId: run1, agentId, companyId,
      status: "failed", errorCode: "adapter_failed", errorMessage: "e1",
    });

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(db._failureState.get(agentId)?.consecutiveAdapterFailures).toBe(1);

    // Second failure — failureState map already holds counter=1 row from first call
    await hook.executeHook({
      runId: run2, agentId, companyId,
      status: "failed", errorCode: "adapter_failed", errorMessage: "e2",
    });

    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    const [callCompanyId, payload] = mockIssueCreate.mock.calls[0];
    expect(callCompanyId).toBe(companyId);
    expect(payload.status).toBe("todo");
    expect(payload.priority).toBe("high");
    expect(payload.billingCode).toBe("platform-ops");
    expect(payload.idempotencyKey).toMatch(/^auto-adapter-failure:/);
    expect(payload.originKind).toBe("adapter_failure");
    expect(payload.originId).toBe(agentId);
    expect(payload.originFingerprint).toBe("default");

    // Verify consecutive_count emitted for both calls
    const countCalls = mockTrack.mock.calls.filter(
      ([name]: [string]) => name === "agent.adapter_failure.consecutive_count",
    );
    expect(countCalls).toHaveLength(2);
    expect(countCalls[0][1].count).toBe(1);
    expect(countCalls[1][1].count).toBe(2);

    // Verify auto_issue_created emitted once
    const issueCalls = mockTrack.mock.calls.filter(
      ([name]: [string]) => name === "agent.adapter_failure.auto_issue_created",
    );
    expect(issueCalls).toHaveLength(1);
    expect(issueCalls[0][1]).toEqual(
      expect.objectContaining({ agent_id: agentId, provider: "anthropic" }),
    );
  });

  it("third failure after issue exists: no second issue", async () => {
    mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
    const db = createMockDb({ agents: new Map(), companies: new Map() });
    const agentId = randomUUID();
    const companyId = randomUUID();

    db.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: vi.fn(async (fn: any) => fn([{
            id: agentId, name: "TestAgent", companyId,
            adapterType: "process", adapterConfig: {},
            status: "idle", reportsTo: null,
          }])),
        })),
      })),
    });
    mockIssueCreate.mockResolvedValue({ id: randomUUID() });

    const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
    const hook = adapterFailureHookService(db);

    // Simulate: row already has counter=2 and openAutoIssueId set
    db._failureState.set(agentId, {
      agentId,
      consecutiveAdapterFailures: 2,
      consecutiveSuccesses: 0,
      firstFailureRunId: randomUUID(),
      lastFailureRunId: randomUUID(),
      openAutoIssueId: randomUUID(),
      updatedAt: new Date(),
    });
    db._tx.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([db._failureState.get(agentId)])),
      })),
    });

    await hook.executeHook({
      runId: randomUUID(), agentId, companyId,
      status: "failed", errorCode: "adapter_failed", errorMessage: "e3",
    });

    expect(mockIssueCreate).not.toHaveBeenCalled();
    expect(db._failureState.get(agentId)?.consecutiveAdapterFailures).toBe(3);
  });

  it("success resets counter but NOT openAutoIssueId, increments consecutiveSuccesses", async () => {
    mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
    const db = createMockDb({ agents: new Map(), companies: new Map() });
    const agentId = randomUUID();
    const existingIssueId = randomUUID();

    db._failureState.set(agentId, {
      agentId,
      consecutiveAdapterFailures: 3,
      consecutiveSuccesses: 0,
      firstFailureRunId: randomUUID(),
      lastFailureRunId: randomUUID(),
      openAutoIssueId: existingIssueId,
      updatedAt: new Date(),
    });
    db._tx.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([db._failureState.get(agentId)])),
      })),
    });

    const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
    const hook = adapterFailureHookService(db);

    await hook.executeHook({
      runId: randomUUID(), agentId, companyId: randomUUID(),
      status: "succeeded", errorCode: null, errorMessage: null,
    });

    const state = db._failureState.get(agentId)!;
    expect(state.consecutiveAdapterFailures).toBe(0);
    expect(state.consecutiveSuccesses).toBe(1);
    expect(state.firstFailureRunId).toBeNull();
    expect(state.lastFailureRunId).toBeNull();
    expect(state.openAutoIssueId).toBe(existingIssueId);

    // Reset should emit count=0
    expect(mockTrack).toHaveBeenCalledWith(
      "agent.adapter_failure.consecutive_count",
      expect.objectContaining({ agent_id: agentId, count: 0 }),
    );
  });

  describe("auto-close after consecutive successes", () => {
    it("auto-closes issue after 3 consecutive successes", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const agentId = randomUUID();
      const openIssueId = randomUUID();

      db._failureState.set(agentId, {
        agentId,
        consecutiveAdapterFailures: 0,
        consecutiveSuccesses: 2,
        firstFailureRunId: null,
        lastFailureRunId: null,
        openAutoIssueId: openIssueId,
        updatedAt: new Date(),
      });
      db._tx.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([db._failureState.get(agentId)])),
        })),
      });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await hook.executeHook({
        runId: randomUUID(), agentId, companyId: randomUUID(),
        status: "succeeded", errorCode: null, errorMessage: null,
      });

      expect(mockIssueAddComment).toHaveBeenCalledWith(
        openIssueId,
        expect.stringContaining("3 consecutive successful runs"),
        {},
      );
      expect(mockIssueUpdate).toHaveBeenCalledWith(openIssueId, { status: "done" });

      const state = db._failureState.get(agentId)!;
      expect(state.consecutiveSuccesses).toBe(0);
      expect(state.consecutiveAdapterFailures).toBe(0);

      const closedCalls = mockTrack.mock.calls.filter(
        ([name]: [string]) => name === "agent.adapter_failure.auto_issue_closed",
      );
      expect(closedCalls).toHaveLength(1);
      expect(closedCalls[0][1]).toEqual(
        expect.objectContaining({ agent_id: agentId }),
      );
    });

    it("does NOT auto-close after only 2 consecutive successes", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const agentId = randomUUID();
      const openIssueId = randomUUID();

      db._failureState.set(agentId, {
        agentId,
        consecutiveAdapterFailures: 0,
        consecutiveSuccesses: 1,
        firstFailureRunId: null,
        lastFailureRunId: null,
        openAutoIssueId: openIssueId,
        updatedAt: new Date(),
      });
      db._tx.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([db._failureState.get(agentId)])),
        })),
      });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await hook.executeHook({
        runId: randomUUID(), agentId, companyId: randomUUID(),
        status: "succeeded", errorCode: null, errorMessage: null,
      });

      expect(mockIssueUpdate).not.toHaveBeenCalled();
      expect(mockIssueAddComment).not.toHaveBeenCalled();

      const state = db._failureState.get(agentId)!;
      expect(state.consecutiveSuccesses).toBe(2);
      expect(state.openAutoIssueId).toBe(openIssueId);
    });

    it("failure resets consecutiveSuccesses to 0", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const agentId = randomUUID();
      const openIssueId = randomUUID();

      db._failureState.set(agentId, {
        agentId,
        consecutiveAdapterFailures: 0,
        consecutiveSuccesses: 2,
        firstFailureRunId: null,
        lastFailureRunId: null,
        openAutoIssueId: openIssueId,
        updatedAt: new Date(),
      });
      db._tx.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([db._failureState.get(agentId)])),
        })),
      });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await hook.executeHook({
        runId: randomUUID(), agentId, companyId: randomUUID(),
        status: "failed", errorCode: "adapter_failed", errorMessage: "fail",
      });

      const state = db._failureState.get(agentId)!;
      expect(state.consecutiveSuccesses).toBe(0);
      expect(state.consecutiveAdapterFailures).toBe(1);
    });

    it("no double-close when openAutoIssueId is already null", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const agentId = randomUUID();

      db._failureState.set(agentId, {
        agentId,
        consecutiveAdapterFailures: 2,
        consecutiveSuccesses: 0,
        firstFailureRunId: randomUUID(),
        lastFailureRunId: randomUUID(),
        openAutoIssueId: null,
        updatedAt: new Date(),
      });
      db._tx.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([db._failureState.get(agentId)])),
        })),
      });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      // 3 consecutive successes but no open issue
      for (let i = 0; i < 3; i++) {
        await hook.executeHook({
          runId: randomUUID(), agentId, companyId: randomUUID(),
          status: "succeeded", errorCode: null, errorMessage: null,
        });
      }

      expect(mockIssueUpdate).not.toHaveBeenCalled();
      expect(mockIssueAddComment).not.toHaveBeenCalled();

      const closedCalls = mockTrack.mock.calls.filter(
        ([name]: [string]) => name === "agent.adapter_failure.auto_issue_closed",
      );
      expect(closedCalls).toHaveLength(0);
    });
  });

  describe("dedup by agent + errorFamily", () => {
    it("first failure for agent+family creates issue with origin metadata", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const agentId = randomUUID();
      const companyId = randomUUID();

      db.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            then: vi.fn(async (fn: any) => fn([{
              id: agentId, name: "TestAgent", companyId,
              adapterType: "claude_local", adapterConfig: { provider: "anthropic", model: "opus" },
              status: "idle", reportsTo: null,
            }])),
          })),
        })),
      });
      mockIssueCreate.mockResolvedValue({ id: randomUUID() });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await hook.executeHook({
        runId: randomUUID(), agentId, companyId,
        status: "failed", errorCode: "adapter_failed", errorMessage: "e1",
        errorFamily: "quota_exhausted",
      });
      await hook.executeHook({
        runId: randomUUID(), agentId, companyId,
        status: "failed", errorCode: "adapter_failed", errorMessage: "e2",
        errorFamily: "quota_exhausted",
      });

      expect(mockIssueCreate).toHaveBeenCalledTimes(1);
      const [, payload] = mockIssueCreate.mock.calls[0];
      expect(payload.originKind).toBe("adapter_failure");
      expect(payload.originId).toBe(agentId);
      expect(payload.originFingerprint).toBe("quota_exhausted");
    });

    it("second failure with existing open issue appends comment instead of creating", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const agentId = randomUUID();
      const companyId = randomUUID();
      const existingIssueId = randomUUID();

      db._failureState.set(agentId, {
        agentId,
        consecutiveAdapterFailures: 1,
        consecutiveSuccesses: 0,
        firstFailureRunId: randomUUID(),
        lastFailureRunId: randomUUID(),
        openAutoIssueId: null,
        updatedAt: new Date(),
      });

      db._openOriginIssues.push({ id: existingIssueId });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await hook.executeHook({
        runId: randomUUID(), agentId, companyId,
        status: "failed", errorCode: "adapter_failed", errorMessage: "recurring",
        errorFamily: "quota_exhausted",
      });

      expect(mockIssueCreate).not.toHaveBeenCalled();
      expect(mockIssueAddComment).toHaveBeenCalledWith(
        existingIssueId,
        expect.stringContaining("Adapter failure recurring"),
        {},
      );
      expect(db._failureState.get(agentId)?.consecutiveAdapterFailures).toBe(2);
    });

    it("after issue closed, new failure for same agent+family creates fresh issue", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const agentId = randomUUID();
      const companyId = randomUUID();

      db._failureState.set(agentId, {
        agentId,
        consecutiveAdapterFailures: 1,
        consecutiveSuccesses: 0,
        firstFailureRunId: randomUUID(),
        lastFailureRunId: randomUUID(),
        openAutoIssueId: null,
        updatedAt: new Date(),
      });

      db.select.mockReturnValue({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            then: vi.fn(async (fn: any) => fn([{
              id: agentId, name: "TestAgent", companyId,
              adapterType: "claude_local", adapterConfig: { provider: "anthropic", model: "opus" },
              status: "idle", reportsTo: null,
            }])),
          })),
        })),
      });
      mockIssueCreate.mockResolvedValue({ id: randomUUID() });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await hook.executeHook({
        runId: randomUUID(), agentId, companyId,
        status: "failed", errorCode: "adapter_failed", errorMessage: "new failure",
        errorFamily: "quota_exhausted",
      });

      expect(mockIssueCreate).toHaveBeenCalledTimes(1);
      const [, payload] = mockIssueCreate.mock.calls[0];
      expect(payload.originKind).toBe("adapter_failure");
      expect(payload.originId).toBe(agentId);
      expect(payload.originFingerprint).toBe("quota_exhausted");
    });

    it("dedup sets openAutoIssueId to existing issue id", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const agentId = randomUUID();
      const companyId = randomUUID();
      const existingIssueId = randomUUID();

      db._failureState.set(agentId, {
        agentId,
        consecutiveAdapterFailures: 1,
        consecutiveSuccesses: 0,
        firstFailureRunId: randomUUID(),
        lastFailureRunId: randomUUID(),
        openAutoIssueId: null,
        updatedAt: new Date(),
      });

      db._openOriginIssues.push({ id: existingIssueId });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await hook.executeHook({
        runId: randomUUID(), agentId, companyId,
        status: "failed", errorCode: "adapter_failed", errorMessage: "recurring",
        errorFamily: "transient_upstream",
      });

      expect(db.update).toHaveBeenCalled();
    });
  });

  describe("clearSlotOnIssueClosed", () => {
    it("calls db.update to clear openAutoIssueId for matching issueId", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });
      const issueId = randomUUID();

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await hook.clearSlotOnIssueClosed(issueId);

      expect(db.update).toHaveBeenCalled();
    });

    it("is a no-op (does not throw) when no matching row exists", async () => {
      mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
      const db = createMockDb({ agents: new Map(), companies: new Map() });

      const { adapterFailureHookService } = await import("../services/adapter-failure-hook.js");
      const hook = adapterFailureHookService(db);

      await expect(hook.clearSlotOnIssueClosed(randomUUID())).resolves.toBeUndefined();
    });
  });
});
