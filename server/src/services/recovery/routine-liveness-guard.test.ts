import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  routines,
} from "@paperclipai/db";
import { recoveryService } from "./service.js";

// --- Module mocks ---

vi.mock("../agent-invokability.js", () => ({
  evaluateAgentInvokabilityFromDb: vi.fn(async () => ({ invokable: true })),
}));
vi.mock("./pause-hold-guard.js", () => ({
  isAutomaticRecoverySuppressedByPauseHold: vi.fn(async () => false),
}));
vi.mock("../issues.js", () => ({
  issueService: vi.fn(() => ({
    update: vi.fn(async (id: string) => ({ id, status: "blocked", companyId: "company-1", assigneeAgentId: "agent-1" })),
    addComment: vi.fn(async () => null),
    create: vi.fn(),
  })),
}));
vi.mock("../issue-recovery-actions.js", () => ({
  issueRecoveryActionService: vi.fn(() => ({
    upsertSourceScoped: vi.fn(async () => ({
      id: "recovery-1",
      ownerAgentId: null,
      previousOwnerAgentId: "agent-1",
      returnOwnerAgentId: "agent-1",
      attemptCount: 1,
      wakePolicy: null,
    })),
  })),
}));
vi.mock("../budgets.js", () => ({
  budgetService: vi.fn(() => ({
    getInvocationBlock: vi.fn(async () => null),
  })),
}));
vi.mock("../instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getGeneral: vi.fn(async () => ({
      censorUsernameInLogs: false,
      autoRecoveryEnabled: true,
    })),
    get: vi.fn(async () => ({})),
  })),
}));
vi.mock("../run-log-store.js", () => ({
  getRunLogStore: vi.fn(() => ({ readOutputTail: vi.fn(async () => null) })),
}));
vi.mock("../issue-tree-control.js", () => ({
  issueTreeControlService: vi.fn(() => ({})),
}));
vi.mock("../activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

// --- DB stub helpers ---

/** Minimal chainable that resolves like a Drizzle result list. */
function row(rows: unknown[]) {
  const p = Promise.resolve(rows);
  const chain: Record<string, unknown> & { then: typeof p.then } = {
    where: () => chain,
    limit: () => chain,
    orderBy: () => chain,
    innerJoin: () => chain,
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  };
  return chain;
}

type TableRows = {
  routineRows: unknown[];
  latestRunRows?: unknown[];
};

function makeDb(opts: TableRows) {
  const heartbeatCallCount = { n: 0 };
  const agentCallCount = { n: 0 };

  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === issues) return row([testIssue]);
        if (table === agents) {
          agentCallCount.n += 1;
          // role-query (inArray "cto","ceo") vs getAgent lookup: both return the mock agent
          return row([testAgent]);
        }
        if (table === heartbeatRuns) {
          heartbeatCallCount.n += 1;
          if (heartbeatCallCount.n === 1) return row([]); // hasActiveExecutionPath
          return row(opts.latestRunRows ?? []); // getLatestIssueRun
        }
        if (table === agentWakeupRequests) return row([]); // hasActiveExecutionPath + hasQueuedIssueWake
        if (table === routines) return row(opts.routineRows);
        if (table === issueRelations) return row([]); // existingUnresolvedBlockerIssueIds
        if (table === companies) return row([]); // getCompanyIssuePrefix → "PAP"
        if (table === issueComments) return row([]); // hasEscalationComment
        return row([]);
      },
    }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  } as unknown as Parameters<typeof recoveryService>[0];
}

// --- Fixtures ---

const testIssue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "TST-1",
  title: "Weekly sweep issue",
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  originKind: null, // NOT a recovery origin
  originId: null,
  createdByAgentId: null,
  checkoutRunId: "run-0",
  executionRunId: null,
  projectId: null,
  goalId: null,
  billingCode: null,
  blockedByIssueIds: [],
} as unknown as typeof issues.$inferSelect;

const testAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Test Agent",
  status: "active",
  role: "developer",
  reportsTo: null,
} as unknown as typeof agents.$inferSelect;

/** A run that satisfies isRepeatedProductiveContinuationRecovery */
const repeatedProductiveRun = {
  id: "run-1",
  agentId: "agent-1",
  status: "succeeded",
  livenessState: "advanced",
  error: null,
  errorCode: null,
  contextSnapshot: {
    issueId: "issue-1",
    retryReason: "issue_continuation_needed",
    source: "issue.productive_terminal_continuation_recovery",
  },
} as unknown as typeof heartbeatRuns.$inferSelect;

// --- Tests ---

describe("hasActiveRoutineLivenessPath skip-guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips an in_progress issue that has an active parent routine, even when the latest run would trip isRepeatedProductiveContinuationRecovery", async () => {
    const activeRoutineRow = [{ id: "routine-42" }];
    const db = makeDb({ routineRows: activeRoutineRow, latestRunRows: [repeatedProductiveRun] });
    const svc = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await svc.reconcileStrandedAssignedIssues();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.escalated).toBe(0);
  });

  it("does NOT skip (proceeds to escalation) when the parent routine has status='paused'", async () => {
    // paused routine: the status filter eq(routines.status, 'active') returns no rows
    const db = makeDb({ routineRows: [], latestRunRows: [repeatedProductiveRun] });
    const svc = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await svc.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBe(0);
  });
});
