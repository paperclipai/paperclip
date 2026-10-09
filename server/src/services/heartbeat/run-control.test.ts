import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { runningProcesses } from "../../adapters/index.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { terminateLocalService } from "../local-service-supervisor.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { createHeartbeatRunControl, type HeartbeatRunControlDependencies } from "./run-control.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../local-service-supervisor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../local-service-supervisor.js")>(),
  terminateLocalService: vi.fn(async () => undefined),
}));

type Run = typeof heartbeatRuns.$inferSelect;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const lifecycleDependencies = {
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
    getCurrentUserRedactionOptions: vi.fn(async () => ({})),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn<HeartbeatLifecycleDependencies["emitTerminalAgentTaskRun"]>(),
    budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDependencies);
  return {
    ...state,
    ...lifecycle,
    getRun: vi.fn(state.getRun),
    getAgent: vi.fn(state.getAgent),
    setRunStatusFromLive: vi.fn(lifecycle.setRunStatusFromLive),
    setRunStatus: vi.fn(lifecycle.setRunStatus),
    setWakeupStatus: vi.fn(lifecycle.setWakeupStatus),
    appendRunEvent: vi.fn(lifecycle.appendRunEvent),
    finalizeAgentStatus: vi.fn<HeartbeatRunControlDependencies["finalizeAgentStatus"]>(),
    options: { closeWarmNativeSessionsForRun: vi.fn(async () => ({ closed: 1, busy: 0, failed: 0 })) },
    envOrchestrator: { releaseForRun: vi.fn<HeartbeatRunControlDependencies["envOrchestrator"]["releaseForRun"]>(async () => ({ released: [], errors: [] })) },
    enqueueWakeup: lifecycleDependencies.enqueueWakeup,
    startNextQueuedRunForAgent: vi.fn<HeartbeatRunControlDependencies["startNextQueuedRunForAgent"]>(),
    sweepPendingCleanupLeases: vi.fn<HeartbeatRunControlDependencies["sweepPendingCleanupLeases"]>(),
    timerClaimWasFirstHeartbeat: vi.fn<HeartbeatRunControlDependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    wakeQueue: { releaseIssueExecution: vi.fn<HeartbeatRunControlDependencies["wakeQueue"]["releaseIssueExecution"]>(async () => ({ outcome: { kind: "released" }, postCommitEffects: [] })) },
    applyWakeQueuePostCommitEffects: vi.fn(async () => undefined),
    getSchedulingSuppression: vi.fn(async () => ({ suppressed: false })),
    activeRunExecutions: new Set<string>(),
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean; error?: unknown }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean; error?: unknown }>(),
  } satisfies HeartbeatRunControlDependencies;
}
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected run-control database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

describe("heartbeat run-control module boundary", () => {
  afterEach(() => adapterExecutionControls.clear());

  it("constructs without database access, cancellation, or cleanup", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatRunControl(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
    expect(deps.envOrchestrator.releaseForRun).not.toHaveBeenCalled();
    expect(deps.options.closeWarmNativeSessionsForRun).not.toHaveBeenCalled();
  });

  it("keeps an already completed run out of cancellation effects", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const run = { id: "finished", status: "succeeded", runtimeMode: "legacy" } as Run;
    deps.getRun.mockResolvedValue(run);
    expect(await createHeartbeatRunControl(database.db, deps).cancelRunInternal(run.id)).toBe(run);
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.appendRunEvent).not.toHaveBeenCalled();
  });

  it("keeps a suppressed saved-input scan out of the database and wake admission", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true });
    await createHeartbeatRunControl(database.db, deps).resumeExecutionWaitComments();
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("ignores an empty cancellation batch", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    expect(await createHeartbeatRunControl(database.db, deps).cancelInvocationsForAgentsInternal(["", ""], "pause")).toEqual({ agentIds: [], runsCancelled: 0, wakeupsCancelled: 0 });
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
  });

  it("waits for an owned adapter before admitting saved comments", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const run = { id: "owned", status: "cancelled", runtimeMode: "legacy" } as Run;
    adapterExecutionControls.set(run.id, {} as never);
    await createHeartbeatRunControl(database.db, deps).resumeRemoteStopComments(run);
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("retains leases while native execution ownership is unverified", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getRun.mockResolvedValue({ runtimeMode: "native", status: "running", nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified" } as Run);
    await createHeartbeatRunControl(database.db, deps).releaseEnvironmentLeasesForRun({ runId: "held", companyId: "company", agentId: "agent", status: "failed", providerResourceDisposition: "destroy" });
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.options.closeWarmNativeSessionsForRun).not.toHaveBeenCalled();
    expect(deps.envOrchestrator.releaseForRun).not.toHaveBeenCalled();
  });

  it("uses the persisted terminal outcome when choosing warm resource retention", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getRun.mockResolvedValue({ status: "failed", runtimeMode: "legacy" } as Run);
    await createHeartbeatRunControl(database.db, deps).releaseEnvironmentLeasesForRun({ runId: "failed", companyId: "company", agentId: "agent", status: "succeeded", providerResourceDisposition: "keep_running" });
    expect(deps.envOrchestrator.releaseForRun).toHaveBeenCalledWith(expect.objectContaining({ heartbeatRunId: "failed", status: "failed", providerResourceDisposition: "stop_and_retain" }));
    expect(database.access).not.toHaveBeenCalled();
  });

  it("defers destruction when a warm session remains busy", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getRun.mockResolvedValue({ status: "failed", runtimeMode: "legacy" } as Run);
    deps.options.closeWarmNativeSessionsForRun.mockResolvedValue({ closed: 0, busy: 1, failed: 0 });
    await createHeartbeatRunControl(database.db, deps).releaseEnvironmentLeasesForRun({ runId: "busy", companyId: "company", agentId: "agent", status: "failed", providerResourceDisposition: "destroy" });
    expect(deps.options.closeWarmNativeSessionsForRun).toHaveBeenCalledWith({ runId: "busy", reason: "terminal heartbeat run destroyed its environment lease" });
    expect(deps.envOrchestrator.releaseForRun).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping run-control database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat run-control database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-control-module");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    vi.mocked(terminateLocalService).mockReset().mockResolvedValue(undefined);
    await db.execute(sql`truncate table companies restart identity cascade`);
  });
  afterEach(() => runningProcesses.clear());

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Run control", issuePrefix: "RC" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Controlled agent", adapterType: "codex_local" }).returning();
    return { company, agent };
  }
  async function liveRun(companyId: string, agentId: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }).returning();
    runningProcesses.set(run.id, { child: { pid: 424242 } as never, graceSec: 4, processGroupId: 424242 });
    return run;
  }

  it("reports a missing run without entering cancellation", async () => {
    const deps = callbacks(db);
    await expect(createHeartbeatRunControl(db, deps).cancelRunInternal(randomUUID())).rejects.toThrow("Heartbeat run not found");
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
    expect(deps.appendRunEvent).not.toHaveBeenCalled();
  });

  it("joins concurrent Stop requests across factories through the shared process barrier", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    const deps = callbacks(db);
    const cancellationLookup = vi.spyOn(deps.processRunCancellationSettlements, "get");
    let releaseTermination!: () => void;
    const terminating = new Promise<void>(resolve => { releaseTermination = resolve; });
    vi.mocked(terminateLocalService).mockReturnValue(terminating);
    const first = createHeartbeatRunControl(db, deps).cancelRunInternal(run.id, "Stop", { terminationGraceMs: 1 });
    await vi.waitFor(() => expect(deps.processRunCancellationSettlements.has(run.id)).toBe(true));
    const second = createHeartbeatRunControl(db, deps).cancelRunInternal(run.id, "Stop again");
    await vi.waitFor(() => expect(cancellationLookup).toHaveBeenCalledTimes(2));
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
    expect(terminateLocalService).toHaveBeenCalledTimes(1);
    releaseTermination();
    const results = await Promise.all([first, second]);
    expect(results.map(result => result?.status)).toEqual(["cancelled", "cancelled"]);
    expect(deps.setRunStatusFromLive).toHaveBeenCalledTimes(1);
    expect(deps.appendRunEvent).toHaveBeenCalledTimes(1);
    expect(deps.finalizeAgentStatus).toHaveBeenCalledTimes(1);
    expect(deps.startNextQueuedRunForAgent).toHaveBeenCalledTimes(1);
    expect(deps.processRunCancellationSettlements.size).toBe(0);
    expect(runningProcesses.has(run.id)).toBe(false);
    expect(terminateLocalService).toHaveBeenCalledWith({ pid: 424242, processGroupId: 424242 }, { forceAfterMs: 100, signal: "SIGINT" });
  });

  it("settles every joined Stop caller with the same termination failure", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    const deps = callbacks(db);
    const cancellationLookup = vi.spyOn(deps.processRunCancellationSettlements, "get");
    deps.activeRunExecutions.add(run.id);
    let rejectTermination!: (error: Error) => void;
    vi.mocked(terminateLocalService).mockReturnValue(new Promise<void>((_resolve, reject) => { rejectTermination = reject; }));
    const first = createHeartbeatRunControl(db, deps).cancelRunInternal(run.id);
    await vi.waitFor(() => expect(deps.processRunCancellationSettlements.has(run.id)).toBe(true));
    const second = createHeartbeatRunControl(db, deps).cancelRunInternal(run.id);
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(cancellationLookup).toHaveBeenCalledTimes(2));
    const failure = new Error("provider did not stop");
    rejectTermination(failure);
    expect(await results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(terminateLocalService).toHaveBeenCalledTimes(1);
    expect(deps.processRunCancellationSettlements.size).toBe(0);
    expect(deps.failedProcessRunCancellations.get(run.id)?.error).toBe(failure);
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
    expect((await deps.getRun(run.id))?.status).toBe("running");
  });

  it("retains failed Stop evidence and the owned process until a later request succeeds", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    const deps = callbacks(db);
    deps.activeRunExecutions.add(run.id);
    const failure = new Error("termination failed");
    vi.mocked(terminateLocalService).mockRejectedValueOnce(failure);
    await expect(createHeartbeatRunControl(db, deps).cancelRunInternal(run.id)).rejects.toBe(failure);
    expect(deps.failedProcessRunCancellations.get(run.id)).toMatchObject({ failed: true, error: failure });
    expect(deps.processRunCancellationSettlements.size).toBe(0);
    expect(runningProcesses.has(run.id)).toBe(true);
    expect((await deps.getRun(run.id))?.status).toBe("running");
    expect(deps.finalizeAgentStatus).not.toHaveBeenCalled();
    expect(await createHeartbeatRunControl(db, deps).cancelRunInternal(run.id)).toMatchObject({ status: "cancelled" });
    expect(terminateLocalService).toHaveBeenCalledTimes(2);
    // The executor still owns removal of this evidence after it observes Stop.
    expect(deps.failedProcessRunCancellations.get(run.id)?.error).toBe(failure);
  });

  it("deduplicates agent batches and cancels only unclaimed pending wakes", async () => {
    const { company, agent } = await fixture();
    const [otherAgent] = await db.insert(agents).values({ companyId: company.id, name: "Other agent" }).returning();
    const [finished] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "succeeded" }).returning();
    const wakes = await db.insert(agentWakeupRequests).values([
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "queued" },
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "deferred_issue_execution" },
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "claimed" },
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "queued", runId: finished.id },
      { companyId: company.id, agentId: otherAgent.id, source: "assignment", status: "queued" },
    ]).returning();
    const deps = callbacks(db);
    expect(await createHeartbeatRunControl(db, deps).cancelInvocationsForAgentsInternal([agent.id, "", agent.id], "pause")).toEqual({ agentIds: [agent.id], runsCancelled: 0, wakeupsCancelled: 2 });
    const persisted = await db.select().from(agentWakeupRequests);
    expect(wakes.map(wake => persisted.find(row => row.id === wake.id)?.status)).toEqual(["cancelled", "cancelled", "claimed", "queued", "queued"]);
  });

  it("rechecks stale budget enforcement before cancelling runs or queued wakes", async () => {
    const { company, agent } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "queued", runtimeMode: "legacy" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "queued" }).returning();
    const deps = callbacks(db);
    await createHeartbeatRunControl(db, deps).cancelBudgetScopeWork({ companyId: company.id, scopeType: "agent", scopeId: agent.id, enforcement: { policyId: randomUUID(), version: 1 } });
    expect((await deps.getRun(run.id))?.status).toBe("queued");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("queued");
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
    expect(deps.finalizeAgentStatus).not.toHaveBeenCalled();
    expect(terminateLocalService).not.toHaveBeenCalled();
  });

  it("limits project budget cancellation by company, effective project, and admission cutoff", async () => {
    const { company, agent } = await fixture();
    const [otherCompany] = await db.insert(companies).values({ name: "Other company", issuePrefix: "OC" }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: otherCompany.id, name: "Other company agent" }).returning();
    const projectRows = await db.insert(projects).values([
      { companyId: company.id, name: "Target" }, { companyId: company.id, name: "Override" },
    ]).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: projectRows[0].id, title: "Bound task", issueNumber: 1, identifier: "RC-1" }).returning();
    const old = new Date("2026-01-01T00:00:00Z");
    const cutoff = new Date("2026-01-02T00:00:00Z");
    const wakes = await db.insert(agentWakeupRequests).values([
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "queued", createdAt: old, payload: { issueId: issue.id } },
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "queued", createdAt: old, payload: { issueId: issue.id, projectId: projectRows[1].id } },
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "queued", createdAt: cutoff, payload: { projectId: projectRows[0].id } },
      { companyId: otherCompany.id, agentId: otherAgent.id, source: "assignment", status: "queued", createdAt: old, payload: { projectId: projectRows[0].id } },
    ]).returning();
    await createHeartbeatRunControl(db, callbacks(db)).cancelBudgetScopeWork({ companyId: company.id, scopeType: "project", scopeId: projectRows[0].id, createdBefore: cutoff });
    const persisted = await db.select().from(agentWakeupRequests);
    expect(wakes.map(wake => persisted.find(row => row.id === wake.id)?.status)).toEqual(["cancelled", "queued", "queued", "queued"]);
  });
});
