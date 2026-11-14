import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db, heartbeatRuns } from "@paperclipai/db";
import type { CurrentUserRedactionOptions } from "../../log-redaction.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";

const { terminalize } = vi.hoisted(() => ({ terminalize: vi.fn() }));
vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../legacy-execution-recovery.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../legacy-execution-recovery.js")>()),
  terminalizeLegacyExecution: terminalize,
}));

type Run = typeof heartbeatRuns.$inferSelect;
const dialect = new PgDialect();

function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  return {
    ...state,
    ...createHeartbeatRunPreparation(db),
    issuesSvc: {
      addComment: vi.fn<HeartbeatLifecycleDependencies["issuesSvc"]["addComment"]>(),
      listReviewAttention: vi.fn<HeartbeatLifecycleDependencies["issuesSvc"]["listReviewAttention"]>(),
    },
    recovery: { escalateStrandedAssignedIssue: vi.fn<HeartbeatLifecycleDependencies["recovery"]["escalateStrandedAssignedIssue"]>() },
    companySkills: { completeTestRunForIssue: vi.fn<HeartbeatLifecycleDependencies["companySkills"]["completeTestRunForIssue"]>() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn<HeartbeatLifecycleDependencies["enqueueWakeup"]>(),
    getCurrentUserRedactionOptions: vi.fn(async (): Promise<CurrentUserRedactionOptions> => ({})),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn<HeartbeatLifecycleDependencies["emitTerminalAgentTaskRun"]>(),
    budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
}

function queuedRun(patch: Partial<Run> = {}) {
  return {
    id: "run-1", companyId: "company-1", agentId: "agent-1", status: "queued", runtimeMode: "legacy",
    startedAt: null, processPid: null, nativeIssueId: null, issueId: null, contextSnapshot: {},
    scheduledRetryReason: null, resultJson: null, ...patch,
  } as Run;
}

function database(row: Run) {
  const read = (rows: unknown[]) => {
    const query = {
      from: () => query, where: () => query, for: async () => rows,
      then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
    };
    return query;
  };
  return {
    select: (fields?: unknown) => read(fields ? [{ run: row, rowVersion: "1" }] : [row]),
    transaction: async (write: (tx: unknown) => unknown) => write({ execute: async () => [], select: () => read([]) }),
  } as unknown as Db;
}

function renderedConditions() {
  const conditions = (terminalize.mock.calls[0]?.[0]?.writeConditions ?? []) as SQL[];
  return conditions.map(condition => {
    const { sql, params } = dialect.sqlToQuery(condition);
    return { sql, params };
  });
}

const queuedPin = { sql: "\"heartbeat_runs\".\"status\" = $1", params: ["queued"] };
const unstartedPins = [
  { sql: "\"heartbeat_runs\".\"started_at\" is null", params: [] },
  { sql: "\"heartbeat_runs\".\"process_pid\" is null", params: [] },
];

describe("queued run cancellation never-started marker", () => {
  beforeEach(() => {
    terminalize.mockReset();
    terminalize.mockResolvedValue(null);
  });

  it("pins a Stop write that certifies no provider work to the still-queued, unstarted row", async () => {
    const db = database(queuedRun());
    await createHeartbeatLifecycle(db, callbacks(db))
      .setRunStatusFromLive("run-1", "cancelled", ["queued", "running", "scheduled_retry"], { errorCode: "cancelled" });
    expect(terminalize).toHaveBeenCalledTimes(1);
    expect(terminalize.mock.calls[0]![0].patch.resultJson.executionRecovery)
      .toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(renderedConditions()).toEqual(expect.arrayContaining([queuedPin, ...unstartedPins]));
  });

  it("pins a plain cancellation that certifies no provider work to the still-queued, unstarted row", async () => {
    const db = database(queuedRun());
    await createHeartbeatLifecycle(db, callbacks(db)).setRunStatus("run-1", "cancelled", { errorCode: "cancelled" });
    expect(terminalize.mock.calls[0]![0].patch.resultJson.executionRecovery)
      .toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(renderedConditions()).toEqual(expect.arrayContaining([queuedPin, ...unstartedPins]));
  });

  it.each([
    ["a running run", { status: "running", startedAt: new Date("2026-01-01T00:00:00Z") }],
    ["a queued run that already started once", { startedAt: new Date("2026-01-01T00:00:00Z") }],
    ["a queued run with a recorded process", { processPid: 4242 }],
  ])("adds neither the marker nor the queued pin for %s", async (_label, patch) => {
    const db = database(queuedRun(patch as Partial<Run>));
    await createHeartbeatLifecycle(db, callbacks(db))
      .setRunStatusFromLive("run-1", "cancelled", ["queued", "running", "scheduled_retry"], { errorCode: "cancelled" });
    expect(terminalize.mock.calls[0]![0].patch.resultJson?.executionRecovery).toBeUndefined();
    expect(renderedConditions()).not.toEqual(expect.arrayContaining([queuedPin]));
  });
});
