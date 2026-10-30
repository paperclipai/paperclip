import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { randomBytes } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issues, subscribeDatabaseWork } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import type { CurrentUserRedactionOptions } from "../../log-redaction.js";
import { publishLiveEvent } from "../live-events.js";
import { getHeartbeatRunRuntimeStatus } from "../heartbeat-run-runtime-status.js";
import { createHeartbeatRunState } from "./run-state.js";
import { heartbeatService } from "../heartbeat.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatLifecycle, persistHeartbeatRunProcessMetadata, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

type Run = typeof heartbeatRuns.$inferSelect;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  return {
    ...state,
    ...createHeartbeatRunPreparation(db),
    getRunStatus: vi.fn(state.getRunStatus),
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
    deps.getRunStatus.mockResolvedValue({ ...run, status: "succeeded" });
    expect(await createHeartbeatLifecycle(database.db, deps).recordCurrentHeartbeatRunRuntimeProgress(run, { phase: "finalize", message: "late update" }, null)).toBeNull();
    expect(deps.getRunStatus).toHaveBeenCalledWith(run.id);
    expect(getHeartbeatRunRuntimeStatus(run.id)).toBeNull();
    expect(database.access).not.toHaveBeenCalled();
  });

  it("does not publish progress when the current status read fails", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getRunStatus.mockRejectedValue(new Error("status read failed"));
    const run = { id: "unavailable-progress", companyId: "company", agentId: "agent", status: "running" };
    vi.mocked(publishLiveEvent).mockClear();
    await expect(createHeartbeatLifecycle(database.db, deps)
      .recordCurrentHeartbeatRunRuntimeProgress(run, { phase: "restore", message: "restoring" }, null))
      .rejects.toThrow("status read failed");
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true as const } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping lifecycle module database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat lifecycle database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-lifecycle-module");
    db = createDb(external ?? database.connectionString);
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

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "deleted"])(
    "rechecks progress after a run becomes %s without reading its large payloads",
    async (status) => {
      const { run } = await fixture({
        contextSnapshot: { prompt: randomBytes(128 * 1024).toString("hex") },
        runnerProfileJson: { configuration: randomBytes(128 * 1024).toString("hex") },
        resultJson: { providerData: randomBytes(128 * 1024).toString("hex") },
      });
      const deps = callbacks(db);
      const lifecycle = createHeartbeatLifecycle(db, deps);
      const update = { phase: "restore" as const, message: "Restoring workspace", currentToolName: "sync" };
      const progress = await lifecycle.recordCurrentHeartbeatRunRuntimeProgress(run, update, null);
      expect(progress).toMatchObject({
        companyId: run.companyId, agentId: run.agentId, runId: run.id,
        phase: update.phase, message: update.message, currentToolName: "sync",
      });
      expect(await deps.getRunStatus.mock.results[0].value).toEqual({
        id: run.id, companyId: run.companyId, agentId: run.agentId, status: "running",
      });
      expect(publishLiveEvent).toHaveBeenCalledTimes(1);
      expect(publishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
        companyId: run.companyId,
        type: "heartbeat.run.progress",
        payload: expect.objectContaining({ runId: run.id, agentId: run.agentId, phase: update.phase, message: update.message }),
      }));

      if (status === "deleted") await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      else await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, run.id));

      expect(await lifecycle.recordCurrentHeartbeatRunRuntimeProgress(run, update, null)).toBeNull();
      expect(deps.getRunStatus).toHaveBeenCalledTimes(2);
      expect(getHeartbeatRunRuntimeStatus(run.id)).toBeNull();
      expect(publishLiveEvent).toHaveBeenCalledTimes(1);
    },
  );

  it("wires fresh progress status reads through the public heartbeat service", async () => {
    const { run } = await fixture();
    const service = heartbeatService(db);
    const update = { phase: "config_sync" as const, message: "Syncing workspace" };
    expect(await service.recordRuntimeProgress(run, update, null)).toMatchObject({ runId: run.id, message: update.message });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
    expect(await service.recordRuntimeProgress(run, update, null)).toBeNull();
    expect(getHeartbeatRunRuntimeStatus(run.id)).toBeNull();
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
  });

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

  it.each(["setRunStatus", "setRunStatusIfRunning"] as const)("signals committed terminal accounting before %s publishes a failed live event", async operation => {
    const { run } = await fixture({ costAccountingPending: true });
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, settled);
    vi.mocked(publishLiveEvent).mockImplementationOnce(() => { throw new Error("Live publication unavailable"); });
    try {
      await expect(createHeartbeatLifecycle(db, callbacks(db))[operation](run.id, "succeeded", { finishedAt: new Date() }))
        .rejects.toThrow("Live publication unavailable");
      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(persisted.status).toBe("succeeded");
      expect(persisted.costAccountingPending).toBe(true);
      expect(settled).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it.each(["native", "legacy", "unbound"] as const)("keeps %s run-status response recovery scoped to its task or run", async binding => {
    const { run } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: run.companyId, title: "Scope owner" }).returning();
    await db.update(heartbeatRuns).set(binding === "native" ? { nativeIssueId: issue.id }
      : binding === "legacy" ? { contextSnapshot: { issueId: issue.id } } : { contextSnapshot: {} }).where(eq(heartbeatRuns.id, run.id));
    const hints: unknown[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.nativeResponsePresentation, (event, scopes) => {
      if (event === "settled") for (const hint of scopes ?? []) hints.push(JSON.parse(hint));
    });
    try {
      await createHeartbeatLifecycle(db, callbacks(db)).setRunStatusIfRunning(run.id, "succeeded", { finishedAt: new Date() });
      expect(hints).toEqual([binding === "unbound" ? { companyId: run.companyId, runId: run.id }
        : { companyId: run.companyId, issueId: issue.id }]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("succeeded");
    } finally { unsubscribe(); }
  });

  it.each(["setRunStatus", "setRunStatusIfRunning"] as const)("wakes retained cleanup only after the outer %s terminal write commits", async operation => {
    const { run } = await fixture();
    const hints: unknown[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.retainedNativeSessionCleanup, (event, scopes) => {
      if (event === "settled") for (const scope of scopes ?? []) hints.push(JSON.parse(scope));
    });
    try {
      await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await createHeartbeatLifecycle(tx, callbacks(tx))[operation](run.id, "succeeded", { finishedAt: new Date() });
        expect(hints).toEqual([]);
        expect((await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("succeeded");
      });
      expect(hints).toEqual([{ companyId: run.companyId, runId: run.id }]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].finishedAt).not.toBeNull();
      hints.length = 0;

      await createHeartbeatLifecycle(db, callbacks(db)).setRunStatus(run.id, "succeeded", { error: "repaired metadata" });
      expect(hints).toEqual([{ companyId: run.companyId, runId: run.id }]);
    } finally { unsubscribe(); }
  });

  it("does not wake retained cleanup for running progress", async () => {
    const { run } = await fixture();
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.retainedNativeSessionCleanup, settled);
    try {
      await createHeartbeatLifecycle(db, callbacks(db)).setRunStatus(run.id, "running");
      expect(settled).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it("does not request accounting for an unchanged running status", async () => {
    const { run } = await fixture();
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, settled);
    try {
      await createHeartbeatLifecycle(db, callbacks(db)).setRunStatus(run.id, "running");
      expect(settled).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it("signals legacy terminal accounting after the nested terminalizer transaction commits", async () => {
    const { run } = await fixture({ runtimeMode: "legacy", costAccountingPending: true });
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, settled);
    try {
      const result = await createHeartbeatLifecycle(db, callbacks(db)).setRunStatusIfRunning(run.id, "failed", { finishedAt: new Date() });
      expect(result.updated).toBe(true);
      expect(result.run?.status).toBe("failed");
      expect(settled).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
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

  it.each(["legacy.case_handoff_cleanup_intent", "legacy.case_handoff_cleanup_verified"])(
    "does not count controller cleanup bookkeeping as agent progress (%s)", async (eventType) => {
      const { run } = await fixture({ status: "succeeded", runtimeMode: "legacy" });
      const lifecycle = createHeartbeatLifecycle(db, callbacks(db));
      await lifecycle.appendRunEvent(run, { eventType, stream: "system", message: "Controller cleanup receipt" });
      const result = { summary: "I will inspect the repo next and then implement the fix." };
      const planning = await lifecycle.classifyAndPersistRunLiveness(run, result);
      expect(planning).toMatchObject({ livenessState: "plan_only", lastUsefulActionAt: null });

      await lifecycle.appendRunEvent(run, { eventType: "item.completed", stream: "stdout", message: "Read the source file" });
      const progressed = await lifecycle.classifyAndPersistRunLiveness(run, result);
      expect(progressed?.livenessState).toBe("advanced");
      expect(progressed?.lastUsefulActionAt).toBeInstanceOf(Date);
    },
  );

  it("reads current redaction settings for each event and persists the published sanitized payload", async () => {
    const { run } = await fixture();
    const deps = callbacks(db);
    deps.getCurrentUserRedactionOptions.mockResolvedValueOnce({ enabled: true, userNames: ["alice"], homeDirs: ["/Users/alice"] });
    deps.getCurrentUserRedactionOptions.mockResolvedValueOnce({ enabled: true, userNames: ["bob"], homeDirs: ["/Users/bob"] });
    const lifecycle = createHeartbeatLifecycle(db, deps);
    for (const name of ["alice", "bob"]) await lifecycle.appendRunEvent(run, {
      eventType: "lifecycle", message: `Opening /Users/${name}/project`, payload: { path: `/Users/${name}/project`, token: "test-credential-material", notes: ["EXPORTED_API_TOKEN=canary-fake-event-000"] },
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
      expect(text).not.toContain("canary-fake-event-000");
      expect(published.find(event => event.payload?.seq === row.seq)?.payload).toMatchObject({ message: row.message, payload: row.payload });
    }
  });
});
