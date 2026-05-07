import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetExperimental = vi.fn();
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
}));

const mockIssueCreate = vi.fn();
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ create: mockIssueCreate }),
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
    firstFailureRunId: string | null;
    lastFailureRunId: string | null;
    openAutoIssueId: string | null;
    updatedAt: Date;
  }>();

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
            firstFailureRunId: null,
            lastFailureRunId: null,
            openAutoIssueId: null,
            updatedAt: new Date(),
          });
        }
      }
      return [];
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((pred: any) => {
          const all = [...failureState.values()];
          return Promise.resolve(all);
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: any) => {
        if (!failureState.has(vals?.agentId ?? "")) {
          failureState.set(vals.agentId, {
            agentId: vals.agentId,
            consecutiveAdapterFailures: 0,
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
  });

  it("single failure: counter=1, no issue created", async () => {
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
  });

  it("two consecutive failures: creates exactly one auto-issue", async () => {
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

  it("success resets counter but NOT openAutoIssueId", async () => {
    mockGetExperimental.mockResolvedValue({ enableAdapterFailureAutoIssue: true });
    const db = createMockDb({ agents: new Map(), companies: new Map() });
    const agentId = randomUUID();
    const existingIssueId = randomUUID();

    db._failureState.set(agentId, {
      agentId,
      consecutiveAdapterFailures: 3,
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
    expect(state.firstFailureRunId).toBeNull();
    expect(state.lastFailureRunId).toBeNull();
    expect(state.openAutoIssueId).toBe(existingIssueId);
  });
});
