import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the issue-assignment-wakeup module before importing the SUT.
const mockQueueWakeup = vi.hoisted(() => vi.fn());
vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueWakeup,
}));

// Mock logger
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { readyQueueGovernanceService } from "../services/ready-queue-governance.ts";

/**
 * Create a mock DB that supports the Drizzle query builder chains used in
 * ready-queue-governance.ts.
 *
 * All query chains are eventually `await`-ed, so terminal nodes must be thenable.
 * Chain patterns in the source:
 *   1. await db.select(...).from(...).where(...)
 *   2. await db.select(...).from(...).where(...).groupBy(...)
 *   3. await db.select(...).from(...).where(...).orderBy(...).limit(...)
 *   4. await db.update(...).set(...).where(...)
 */
interface MockDb {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  _selectResults: unknown[][];
  _updateResults: unknown[][];
}

function createMockDb(): MockDb {
  const selectResults: unknown[][] = [];
  const updateResults: unknown[][] = [];

  function nextSelectRows(): unknown[] {
    return selectResults.shift() ?? [];
  }

  function nextUpdateRows(): unknown[] {
    return updateResults.shift() ?? [];
  }

  /**
   * Create a thenable that resolves to `rows`, but also has extra methods
   * attached so chained calls like `.groupBy()`, `.orderBy()` etc. work.
   */
  function thenableSelectRows(rows: unknown[]): Promise<unknown[]> {
    const p = Promise.resolve(rows);
    // Attach chain methods so Drizzle-style chains work
    const t = p as Promise<unknown[]> & {
      groupBy: ReturnType<typeof vi.fn>;
      orderBy: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    t.groupBy = vi.fn(() => thenableSelectRows(rows));
    t.orderBy = vi.fn(() => {
      const inner = thenableSelectRows(rows);
      // limit is already handled by thenable, but add it explicitly
      return inner;
    });
    t.limit = vi.fn(() => thenableSelectRows(rows));
    return t;
  }

  const select = vi.fn(() => {
    const chain: Record<string, ReturnType<typeof vi.fn>> & { then: ReturnType<typeof vi.fn> } = {
      from: vi.fn(() => chain),
      where: vi.fn(() => thenableSelectRows(nextSelectRows())),
      // If someone awaits the select directly without .where()
      then: vi.fn((resolve: (v: unknown) => void) => thenableSelectRows(nextSelectRows()).then(resolve)),
    };
    return chain;
  });

  const update = vi.fn(() => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve(nextUpdateRows())),
        })),
      })),
    };
    return chain;
  });

  return {
    select,
    update,
    _selectResults: selectResults,
    _updateResults: updateResults,
  };
}

function enqueueSelect(db: MockDb, rows: unknown[]) {
  db._selectResults.push(rows);
}

function enqueueUpdate(db: MockDb, rows: unknown[]) {
  db._updateResults.push(rows);
}

describe("readyQueueGovernanceService", () => {
  let db: MockDb;
  const mockHeartbeat = {};

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
  });

  it("deprioritizes todo issues on error-status agents to backlog", async () => {
    // Phase 1: unhealthy agents query → one error agent
    enqueueSelect(db, [
      { id: "agent-error", name: "BrokenBot", companyId: "co", status: "error", adapterType: "openclaw" },
    ]);
    // Phase 1: todo issues on unhealthy agents → two issues
    enqueueSelect(db, [
      { id: "issue-1", assigneeAgentId: "agent-error", title: "Some work" },
      { id: "issue-2", assigneeAgentId: "agent-error", title: "More work" },
    ]);
    // Phase 1: two updates (one per issue)
    enqueueUpdate(db, [{ id: "issue-1", status: "backlog" }]);
    enqueueUpdate(db, [{ id: "issue-2", status: "backlog" }]);
    // Phase 2: healthy agents query
    enqueueSelect(db, [
      { id: "agent-ok", name: "GoodBot", companyId: "co", status: "idle", adapterType: "openclaw" },
    ]);
    // Phase 2: todo counts per agent (with groupBy) → already at minimum
    enqueueSelect(db, [
      { assigneeAgentId: "agent-ok", count: 3 },
    ]);

    const service = readyQueueGovernanceService(db as unknown as Parameters<typeof readyQueueGovernanceService>[0], {
      heartbeat: mockHeartbeat as never,
    });

    const result = await service.tick();

    expect(result.issuesDeprioritized).toBe(2);
    expect(result.unhealthyLanesDeprioritized).toBe(1);
    expect(result.deprioritizationDetails).toEqual([
      {
        agentId: "agent-error",
        agentName: "BrokenBot",
        agentStatus: "error",
        issuesMovedToBacklog: 2,
      },
    ]);
  });

  it("does not deprioritize issues on healthy agents", async () => {
    // Phase 1: no unhealthy agents
    enqueueSelect(db, []);
    // Phase 2: healthy agents
    enqueueSelect(db, [
      { id: "agent-ok", name: "GoodBot", companyId: "co", status: "idle", adapterType: "openclaw" },
    ]);
    // Phase 2: todo counts
    enqueueSelect(db, [
      { assigneeAgentId: "agent-ok", count: 5 },
    ]);

    const service = readyQueueGovernanceService(db as unknown as Parameters<typeof readyQueueGovernanceService>[0], {
      heartbeat: mockHeartbeat as never,
    });

    const result = await service.tick();

    expect(result.issuesDeprioritized).toBe(0);
    expect(result.unhealthyLanesDeprioritized).toBe(0);
    expect(result.deprioritizationDetails).toEqual([]);
  });

  it("skips deprioritization when unhealthy agent has no todo issues", async () => {
    // Phase 1: unhealthy agents → one error agent
    enqueueSelect(db, [
      { id: "agent-error", name: "EmptyBot", companyId: "co", status: "error", adapterType: "openclaw" },
    ]);
    // Phase 1: no todo issues on unhealthy agents
    enqueueSelect(db, []);
    // Phase 2: healthy agents
    enqueueSelect(db, [
      { id: "agent-ok", name: "GoodBot", companyId: "co", status: "idle", adapterType: "openclaw" },
    ]);
    // Phase 2: todo counts
    enqueueSelect(db, [
      { assigneeAgentId: "agent-ok", count: 2 },
    ]);

    const service = readyQueueGovernanceService(db as unknown as Parameters<typeof readyQueueGovernanceService>[0], {
      heartbeat: mockHeartbeat as never,
    });

    const result = await service.tick();

    expect(result.issuesDeprioritized).toBe(0);
    expect(result.unhealthyLanesDeprioritized).toBe(0);
  });

  it("handles concurrent update race (update returns empty) gracefully", async () => {
    // Phase 1: unhealthy agent
    enqueueSelect(db, [
      { id: "agent-error", name: "RaceBot", companyId: "co", status: "error", adapterType: "openclaw" },
    ]);
    // Phase 1: one todo issue
    enqueueSelect(db, [
      { id: "issue-race", assigneeAgentId: "agent-error", title: "Race condition" },
    ]);
    // Phase 1: update returns empty (race: someone else moved it already)
    enqueueUpdate(db, []);
    // Phase 2: healthy agents (empty)
    enqueueSelect(db, []);

    const service = readyQueueGovernanceService(db as unknown as Parameters<typeof readyQueueGovernanceService>[0], {
      heartbeat: mockHeartbeat as never,
    });

    const result = await service.tick();

    expect(result.issuesDeprioritized).toBe(0);
    expect(result.unhealthyLanesDeprioritized).toBe(0);
  });

  it("still promotes backlog to todo for healthy lanes after deprioritization", async () => {
    // Phase 1: unhealthy agents
    enqueueSelect(db, [
      { id: "agent-error", name: "BrokenBot", companyId: "co", status: "error", adapterType: "openclaw" },
    ]);
    // Phase 1: todo issues on unhealthy → one issue
    enqueueSelect(db, [
      { id: "issue-x", assigneeAgentId: "agent-error", title: "Deprioritize me" },
    ]);
    // Phase 1: update succeeds
    enqueueUpdate(db, [{ id: "issue-x", status: "backlog" }]);
    // Phase 2: healthy agents
    enqueueSelect(db, [
      { id: "agent-ok", name: "GoodBot", companyId: "co", status: "idle", adapterType: "openclaw" },
    ]);
    // Phase 2: todo counts → 0 todos (below minimum of 2)
    enqueueSelect(db, []);
    // Phase 2: backlog candidates for healthy agent → 2 issues (with orderBy + limit)
    enqueueSelect(db, [
      { id: "issue-a", companyId: "co", status: "backlog", priority: "high", assigneeAgentId: "agent-ok", title: "Promote me" },
      { id: "issue-b", companyId: "co", status: "backlog", priority: "medium", assigneeAgentId: "agent-ok", title: "Promote me too" },
    ]);
    // Phase 2: two update calls for promotions
    enqueueUpdate(db, [{ id: "issue-a", status: "todo" }]);
    enqueueUpdate(db, [{ id: "issue-b", status: "todo" }]);

    const service = readyQueueGovernanceService(db as unknown as Parameters<typeof readyQueueGovernanceService>[0], {
      heartbeat: mockHeartbeat as never,
    });

    const result = await service.tick();

    // Unhealthy deprioritization happened
    expect(result.issuesDeprioritized).toBe(1);
    // Healthy promotion also happened
    expect(result.issuesPromoted).toBe(2);
    expect(result.details).toHaveLength(1);
    expect(result.details[0].agentId).toBe("agent-ok");
  });
});
