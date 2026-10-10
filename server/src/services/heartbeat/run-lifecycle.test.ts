import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import type { CurrentUserRedactionOptions } from "../../log-redaction.js";
import { publishLiveEvent } from "../live-events.js";
import { getHeartbeatRunRuntimeStatus } from "../heartbeat-run-runtime-status.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatLifecycle, persistHeartbeatRunProcessMetadata, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

type Run = typeof heartbeatRuns.$inferSelect;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  return {
    ...state,
    ...createHeartbeatRunPreparation(db),
    getRun: vi.fn(state.getRun),
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
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected lifecycle database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

describe("heartbeat lifecycle module boundary", () => {
  it("constructs without database work or reporting effects", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatLifecycle(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
  });

  it("ignores absent wake requests without accessing the database", async () => {
    const database = guardedDatabase();
    const lifecycle = createHeartbeatLifecycle(database.db, callbacks(database.db));
    await lifecycle.setWakeupStatus(null, "completed");
    await lifecycle.setWakeupStatus(undefined, "completed");
    expect(database.access).not.toHaveBeenCalled();
  });

  it.each([
    { livenessState: "empty_response", contextSnapshot: { goalControlRequestId: "goal" } },
    { livenessState: "plan_only", contextSnapshot: { resumeSessionGoalHeartbeat: true } },
    { livenessState: "productive", contextSnapshot: { issueId: "issue" } },
    { livenessState: "empty_response", contextSnapshot: {} },
  ])("keeps ineligible continuations out of wake admission (%j)", async (input) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    await createHeartbeatLifecycle(database.db, deps).handleRunLivenessContinuation(input as unknown as Run);
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    expect(deps.budgets.getInvocationBlock).not.toHaveBeenCalled();
  });

  it("preserves retained native ownership before lease-release teardown reads or writes", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const run = { runtimeMode: "native", status: "running", nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified" } as Run;
    expect(await createHeartbeatLifecycle(database.db, deps).terminalizeRunOnLeaseRelease(run)).toBe(run);
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.emitTerminalAgentTaskRun).not.toHaveBeenCalled();
  });

  it("rejects late progress after re-reading a terminal run through the service callback", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const run = { id: "late-progress", companyId: "company", agentId: "agent", status: "running", contextSnapshot: {} } as Run;
    deps.getRun.mockResolvedValue({ ...run, status: "succeeded" });
    expect(await createHeartbeatLifecycle(database.db, deps).recordCurrentHeartbeatRunRuntimeProgress(run, { phase: "finalize", message: "late update" }, null)).toBeNull();
    expect(deps.getRun).toHaveBeenCalledWith(run.id);
    expect(getHeartbeatRunRuntimeStatus(run.id)).toBeNull();
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping lifecycle module database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat lifecycle database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-lifecycle-module");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    vi.mocked(publishLiveEvent).mockClear();
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [company] = await db.insert(companies).values({ name: "Lifecycle module", issuePrefix: "LM" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Lifecycle agent" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, wakeupRequestId: wake.id, status: "running", runtimeMode: "native", ...patch }).returning();
    return { company, agent, wake, run };
  }

  it("preserves sandbox process birth instead of inspecting a colliding controller PID", async () => {
    const { run } = await fixture();
    const remoteBirth = "2026-10-09T00:00:00.000Z";
    const persisted = await persistHeartbeatRunProcessMetadata(db, run.id, {
      pid: process.pid, processGroupId: null, startedAt: remoteBirth, targetKind: "remote",
    });
    expect(persisted?.processStartedAt?.toISOString()).toBe(remoteBirth);
    expect(persisted?.processPid).toBe(process.pid);
  });

  it("keeps one terminal outcome and reports only the winner of competing writes", async () => {
    const { run } = await fixture();
    const deps = callbacks(db);
    const lifecycle = createHeartbeatLifecycle(db, deps);
    const results = await Promise.all([
      lifecycle.setRunStatusIfRunning(run.id, "succeeded", { finishedAt: new Date() }),
      lifecycle.setRunStatusIfRunning(run.id, "failed", { errorCode: "late_failure", finishedAt: new Date() }),
    ]);
    const winner = results.find(result => result.updated)!;
    expect(results.filter(result => result.updated)).toHaveLength(1);
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persisted.status).toBe(winner.run?.status);
    expect(results.every(result => result.run?.status === persisted.status)).toBe(true);
    expect(deps.emitTerminalAgentTaskRun).toHaveBeenCalledTimes(1);
    expect(deps.emitTerminalAgentTaskRun).toHaveBeenCalledWith(winner.run, "running", undefined);
    expect(vi.mocked(publishLiveEvent).mock.calls.filter(([event]) => event.type === "heartbeat.run.status")).toHaveLength(1);
  });

  it("rechecks native ownership atomically before a terminal write", async () => {
    const { run } = await fixture({ errorCode: "native_execution_ownership_unverified", nativePhase: "terminal_failure" });
    const deps = callbacks(db);
    const result = await createHeartbeatLifecycle(db, deps).setRunStatusIfRunning(run.id, "failed");
    expect(result).toMatchObject({ updated: false, run: { status: "running", errorCode: run.errorCode } });
    expect(deps.emitTerminalAgentTaskRun).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it.each(["setRunStatus", "setRunStatusIfRunning"] as const)("preserves accounting metadata while %s enriches usage", async (operation) => {
    const { run } = await fixture({ usageJson: { accountingReceiptReady: false, usageSource: "per_run", inputTokens: 5 } });
    await createHeartbeatLifecycle(db, callbacks(db))[operation](run.id, "succeeded", { usageJson: { inputTokens: 8, outputTokens: 3 } });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persisted.usageJson).toEqual({ accountingReceiptReady: false, usageSource: "per_run", inputTokens: 8, outputTokens: 3 });
  });

  it.each(["claimed", "cancelled"] as const)("settles a %s wake without reviving a revoked request", async (status) => {
    const { wake } = await fixture();
    await db.update(agentWakeupRequests).set({ status }).where(eq(agentWakeupRequests.id, wake.id));
    await createHeartbeatLifecycle(db, callbacks(db)).setWakeupStatus(wake.id, "completed", { reason: "settled" });
    const [persisted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(persisted.status).toBe(status === "cancelled" ? "cancelled" : "completed");
    expect(persisted.reason).toBe(status === "cancelled" ? wake.reason : "settled");
  });

  it("publishes the persisted sequence for concurrent event writes", async () => {
    const { run } = await fixture();
    const lifecycle = createHeartbeatLifecycle(db, callbacks(db));
    await Promise.all(["first", "second"].map(message => lifecycle.appendRunEvent(run, { eventType: "lifecycle", message })));
    const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)).orderBy(heartbeatRunEvents.seq);
    expect(rows.map(row => row.seq)).toEqual([1, 2]);
    const published = vi.mocked(publishLiveEvent).mock.calls.map(([event]) => event).filter(event => event.type === "heartbeat.run.event");
    expect(published).toHaveLength(2);
    for (const row of rows) expect(published.find(event => event.payload?.seq === row.seq)?.payload).toMatchObject({ runId: run.id, message: row.message });
  });

  it("reads current redaction settings for each event and persists the published sanitized payload", async () => {
    const { run } = await fixture();
    const deps = callbacks(db);
    deps.getCurrentUserRedactionOptions.mockResolvedValueOnce({ enabled: true, userNames: ["alice"], homeDirs: ["/Users/alice"] });
    deps.getCurrentUserRedactionOptions.mockResolvedValueOnce({ enabled: true, userNames: ["bob"], homeDirs: ["/Users/bob"] });
    const lifecycle = createHeartbeatLifecycle(db, deps);
    for (const name of ["alice", "bob"]) await lifecycle.appendRunEvent(run, {
      eventType: "lifecycle", message: `Opening /Users/${name}/project`, payload: { path: `/Users/${name}/project`, token: "test-credential-material" },
    });
    const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)).orderBy(heartbeatRunEvents.seq);
    expect(deps.getCurrentUserRedactionOptions).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    const published = vi.mocked(publishLiveEvent).mock.calls.map(([event]) => event).filter(event => event.type === "heartbeat.run.event");
    expect(published).toHaveLength(2);
    for (const row of rows) {
      const text = JSON.stringify({ message: row.message, payload: row.payload });
      expect(text).not.toContain("alice");
      expect(text).not.toContain("bob");
      expect(text).not.toContain("test-credential-material");
      expect(published.find(event => event.payload?.seq === row.seq)?.payload).toMatchObject({ message: row.message, payload: row.payload });
    }
  });
});
