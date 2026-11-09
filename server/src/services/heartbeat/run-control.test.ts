import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, agentWakeupRequests, caseEvents, caseHandoffs, cases, companies, environmentLeases, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runningProcesses } from "../../adapters/index.js";
import {
  adapterExecutionControls,
  createAdapterExecutionControl,
  reportAdapterStopIfUnsettled,
  waitForAdapterStop,
} from "../adapter-execution-control.js";
import { AdapterStopTimeoutError } from "../adapter-stop-timeout.js";
import { HttpError } from "../../errors.js";
import { captureException } from "../../sentry.js";
import { terminateLocalService } from "../local-service-supervisor.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { preserveCancelledNativeWorkspaces } from "../native-runtime/native-failed-workspace-recovery.js";
import { createPostgresRunDispatchAdapter } from "../../modules/run-dispatch/adapters/postgres.js";
import { caseHandoffService } from "../case-handoffs.js";
import { withQueuedCommentIdsInWakePayload } from "../issue-queued-comment-queue.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueService } from "../issues.js";
import { callbacks, runControlPostgresSupport, setupRunControlDatabase } from "./__tests__/run-control-fixtures.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../adapter-execution-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapter-execution-control.js")>();
  return {
    ...actual,
    waitForAdapterStop: vi.fn(actual.waitForAdapterStop),
    reportAdapterStopIfUnsettled: vi.fn(actual.reportAdapterStopIfUnsettled),
  };
});
vi.mock("../local-service-supervisor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../local-service-supervisor.js")>(),
  terminateLocalService: vi.fn(async () => undefined),
}));

type Run = typeof heartbeatRuns.$inferSelect;
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

describe.skipIf(!runControlPostgresSupport.supported)("heartbeat run-control database wiring", () => {
  let db: Db;
  const { fixture, liveRun } = setupRunControlDatabase("paperclip-heartbeat-run-control-module", value => { db = value; });

  it.each(["queued", "running", "cancelled", "succeeded"] as const)("does not supersede a retry that becomes %s between lookup and the cancellation fence", async status => {
    const { company, agent } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "scheduled_retry",
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(),
      scheduledRetryReason: "execution_reconciliation_continuation",
    }).returning();
    const deps = callbacks(db);
    const originalGetRun = deps.getRun.getMockImplementation()!;
    deps.getRun.mockImplementationOnce(async id => {
      const snapshot = await originalGetRun(id);
      await db.update(heartbeatRuns).set({ status, startedAt: new Date() }).where(eq(heartbeatRuns.id, id));
      return snapshot;
    });

    const control = createHeartbeatRunControl(db, deps);
    const result = await control.cancelRunInternal(run.id, undefined, { expectedStatus: "scheduled_retry" });

    expect(result).toBeNull();
    expect(await originalGetRun(run.id)).toMatchObject({ status, resultJson: null });
    expect(deps.envOrchestrator.releaseForRun).not.toHaveBeenCalled();
    expect(deps.options.closeWarmNativeSessionsForRun).not.toHaveBeenCalled();
    expect(deps.appendRunEvent).not.toHaveBeenCalled();

    // An actual Stop still has authority over promoted, nonterminal work.
    if (status === "queued" || status === "running") {
      expect(await control.cancelRunInternal(run.id)).toMatchObject({ status: "cancelled" });
    }
  });

  it("can supersede a retry that is still scheduled", async () => {
    const { company, agent } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "scheduled_retry",
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(),
    }).returning();
    const deps = callbacks(db);

    expect(await createHeartbeatRunControl(db, deps).cancelRunInternal(
      run.id, undefined, { expectedStatus: "scheduled_retry" },
    )).toMatchObject({ status: "cancelled" });
  });

  it.each(["queued", "running"] as const)("preserves case intent when a guarded Stop loses to %s promotion", async status => {
    const { company, agent } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Promoted case work", status: "todo", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      status: "scheduled_retry", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning();
    const [caseRow] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: `CASE-${randomUUID()}`,
      caseType: "work", title: "Promoted case work", workIssueId: issue.id, handoffVersion: 1 }).returning();
    const [handoff] = await db.insert(caseHandoffs).values({ companyId: company.id, caseId: caseRow.id, issueId: issue.id, version: 1,
      sourceRunId: run.id, fromAgentId: agent.id, toAgentId: agent.id, phase: "verification", instructions: "Verify",
      actorType: "user", actorId: "operator", state: "awaiting_release", wakeupRequestId: randomUUID(),
      idempotencyKey: randomUUID(), inputFingerprint: "fixture" }).returning();
    const deps = callbacks(db), originalGetRun = deps.getRun.getMockImplementation()!;
    deps.getRun.mockImplementationOnce(async id => {
      const snapshot = await originalGetRun(id);
      await db.update(heartbeatRuns).set({ status, startedAt: new Date() }).where(eq(heartbeatRuns.id, id));
      return snapshot;
    });
    expect(await createHeartbeatRunControl(db, deps).cancelRunInternal(run.id, "Recover previous Stop", {
      expectedStatus: "scheduled_retry", resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" },
    })).toBeNull();
    expect(await originalGetRun(run.id)).toMatchObject({ status, resultJson: null });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, handoff.id)))[0])
      .toMatchObject({ state: "awaiting_release", cancelledAt: null });
    expect(deps.appendRunEvent).not.toHaveBeenCalled();
  });

  it("blocks promotion after guarded cancellation wins but before it settles", async () => {
    const { company, agent } = await fixture();
    await db.update(companies).set({ defaultResponsibleUserId: "operator" }).where(eq(companies.id, company.id));
    const [issue] = await db.insert(issues).values({
      companyId: company.id, title: "Keep the cancellation claim", status: "in_progress", assigneeAgentId: agent.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, issueId: issue.id, status: "scheduled_retry",
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), responsibleUserId: "operator",
      scheduledRetryAt: new Date(), scheduledRetryReason: "transient_failure", contextSnapshot: { issueId: issue.id },
    }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
    const deps = callbacks(db);
    const settle = deps.setRunStatusFromLive.getMockImplementation()!;
    let claimed!: () => void, release!: () => void;
    const claimReached = new Promise<void>(resolve => { claimed = resolve; });
    const continueSettlement = new Promise<void>(resolve => { release = resolve; });
    deps.setRunStatusFromLive.mockImplementation(async (...args) => {
      claimed();
      await continueSettlement;
      return settle(...args);
    });
    const cancellation = createHeartbeatRunControl(db, deps).cancelRunInternal(
      run.id, undefined, { expectedStatus: "scheduled_retry" },
    );
    try {
      await Promise.race([claimReached, cancellation.then(() => { throw new Error("Cancellation did not reach settlement"); })]);
      expect((await deps.getRun(run.id))?.resultJson?.startupCancellation).toBeTruthy();
      expect(await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry({
        companyId: company.id, runId: run.id, now: new Date(),
      })).toMatchObject({ outcome: "not_promoted" });
      expect(await deps.getRun(run.id)).toMatchObject({ status: "scheduled_retry" });
    } finally {
      release();
      await cancellation;
    }
    expect(await deps.getRun(run.id)).toMatchObject({ status: "cancelled" });
  });

  it.each(["agent", "done"] as const)("fences a concurrent %s handoff before waiting for Stop execution", async destination => {
    const { company, agent } = await fixture();
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, agent.id));
    const [recipient] = await db.insert(agents).values({ companyId: company.id, name: "Recipient", role: "engineer", reportsTo: agent.id }).returning();
    const run = await liveRun(company.id, agent.id);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Concurrent handoff", status: "in_progress",
      assigneeAgentId: agent.id, executionRunId: run.id, checkoutRunId: run.id }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue.id, contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, run.id));
    const [caseRow] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: `CASE-${randomUUID()}`,
      caseType: "work", title: "Concurrent handoff", workIssueId: issue.id }).returning();
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const deps = callbacks(db), state = createHeartbeatRunState(db);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    // Stop has committed its durable task/run fence, but provider/process
    // cancellation has not started. This was the old acceptance race window.
    deps.getAgent.mockImplementationOnce(async id => { enter(); await released; return state.getAgent(id); });
    const stopping = createHeartbeatRunControl(db, deps).cancelRunInternal(run.id, "Operator Stop", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" },
    });
    try {
      await entered;
      expect((await state.getRun(run.id))?.status).toBe("running");
      const routing = { idempotencyKey: `after-stop-${destination}`, case: { id: caseRow.id }, instructions: "Attempt a late handoff",
        expectedHandoffVersion: 0, expectedIssueStatusVersion: 0 };
      await expect(caseHandoffService(db).handoff(company.id, { type: "agent", companyId: company.id, agentId: agent.id, runId: run.id },
        destination === "done" ? { ...routing, to: "done" } : { ...routing, toAgentId: recipient.id, phase: "verification" }))
        .rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
      expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, caseRow.id))).toHaveLength(0);
    } finally { release(); await stopping; }
    expect((await state.getRun(run.id))?.status).toBe("cancelled");
  });

  it.each(["agent", "done"] as const)("does not let a repeated Stop for an old run cancel a newer %s handoff", async destination => {
    const { company, agent } = await fixture();
    const [successor] = await db.insert(agents).values({ companyId: company.id, name: "Successor", role: "ceo", status: "running" }).returning();
    const [oldRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "succeeded", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), finishedAt: new Date() }).returning();
    const [currentRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: successor.id,
      status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Same-task later phase", status: "in_progress",
      assigneeAgentId: successor.id, executionRunId: currentRun.id, checkoutRunId: currentRun.id }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue.id, contextSnapshot: { issueId: issue.id } })
      .where(inArray(heartbeatRuns.id, [oldRun.id, currentRun.id]));
    const [caseRow] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: `CASE-${randomUUID()}`,
      caseType: "work", title: issue.title, workIssueId: issue.id, handoffVersion: 1, phase: "implementation" }).returning();
    await db.insert(caseHandoffs).values({ companyId: company.id, caseId: caseRow.id, issueId: issue.id, version: 1,
      sourceRunId: oldRun.id, fromAgentId: agent.id, toAgentId: successor.id, phase: "implementation", instructions: "Continue on the same task",
      actorType: "user", actorId: "operator", state: "delivered", wakeupRequestId: randomUUID(),
      idempotencyKey: randomUUID(), inputFingerprint: "fixture" });
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const routing = { idempotencyKey: randomUUID(), case: { id: caseRow.id }, instructions: "The later phase owns this intent",
      expectedHandoffVersion: 1, expectedIssueStatusVersion: issue.statusVersion };
    const receipt = await caseHandoffService(db).handoff(company.id,
      { type: "agent", companyId: company.id, agentId: successor.id, runId: currentRun.id, source: "agent_jwt" },
      destination === "done" ? { ...routing, to: "done" } : { ...routing, toAgentId: agent.id, phase: "verification" });
    const snapshot = async () => ({
      handoffs: await db.select().from(caseHandoffs).orderBy(caseHandoffs.version),
      tasks: await db.select().from(issues), cases: await db.select().from(cases),
      currentRun: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, currentRun.id)),
      events: await db.select().from(caseEvents).orderBy(caseEvents.id),
      activity: await db.select().from(activityLog).orderBy(activityLog.id),
    });
    const before = await snapshot();
    expect(before.handoffs.find(row => row.id === receipt.handoffId)).toMatchObject({
      sourceRunId: currentRun.id, state: destination === "done" ? "awaiting_completion" : "awaiting_release",
    });
    const deps = callbacks(db), control = createHeartbeatRunControl(db, deps);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await control.cancelRunInternal(oldRun.id, "Delayed operator Stop", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" },
      })).toMatchObject({ id: oldRun.id, status: "succeeded" });
      expect(await snapshot()).toEqual(before);
    }
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.envOrchestrator.releaseForRun).not.toHaveBeenCalled();
    expect(await control.cancelRunInternal(currentRun.id, "Stop the current phase", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" },
    })).toMatchObject({ id: currentRun.id, status: "cancelled" });
    expect((await db.select().from(caseHandoffs).orderBy(caseHandoffs.version)).map(row => row.state))
      .toEqual(["delivered", "cancelled"]);
    expect((await db.select().from(caseEvents)).filter(event => event.kind === "handoff_cancelled"))
      .toHaveLength(1);
  });

  async function boardTerminalFixture(requestedWhile: "idle" | "running", runtime: "legacy" | "native" = "legacy",
    options: { staleCheckout?: boolean } = {}) {
    const { company, agent } = await fixture();
    const [oldRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "succeeded", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), finishedAt: new Date() }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Board completion intent", status: "in_progress",
      assigneeAgentId: agent.id }).returning();
    const [caseRow] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: `CASE-${randomUUID()}`,
      caseType: "work", title: issue.title, workIssueId: issue.id, status: "in_progress", phase: "verification" }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue.id, contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, oldRun.id));
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const startRun = async () => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
        nativeIssueId: runtime === "native" ? issue.id : null, contextSnapshot: { issueId: issue.id },
        status: runtime === "native" ? "failed" : "running", runtimeMode: runtime, runtimeModeResolvedAt: new Date(),
        ...(options.staleCheckout ? { executionStage: "preparing" } : {}) }).returning();
      await db.update(issues).set({ executionRunId: run.id, checkoutRunId: options.staleCheckout ? oldRun.id : run.id }).where(eq(issues.id, issue.id));
      if (runtime === "native") await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: company.id,
        issueId: issue.id, phase: "retryable_failure", nextAttemptAt: new Date(Date.now() + 30_000) });
      return run;
    };
    let run = requestedWhile === "running" ? await startRun() : null;
    // Exercise the actual board operation: its sourceRunId is deliberately NULL,
    // including when an agent execution already owns the primary task.
    const receipt = await caseHandoffService(db).handoff(company.id, { type: "board", source: "local_implicit" }, {
      idempotencyKey: randomUUID(), case: { id: caseRow.id }, to: "done", instructions: "Close the case after accepted task completion",
      expectedHandoffVersion: 0, expectedIssueStatusVersion: issue.statusVersion,
    });
    run ??= await startRun();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))[0])
      .toMatchObject({ sourceRunId: null, destinationKind: "done", state: "awaiting_completion" });
    return { company, agent, issue, caseRow, oldRun, run, receipt };
  }

  it.each(["idle", "running"] as const)("only current Stop cancels board terminal intent accepted while %s", async requestedWhile => {
    const f = await boardTerminalFixture(requestedWhile);
    const snapshot = async () => ({
      handoffs: await db.select().from(caseHandoffs), tasks: await db.select().from(issues), cases: await db.select().from(cases),
      currentRun: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)),
      events: await db.select().from(caseEvents).orderBy(caseEvents.id), activity: await db.select().from(activityLog).orderBy(activityLog.id),
    });
    const before = await snapshot(), control = createHeartbeatRunControl(db, callbacks(db));
    const stop = { resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" } };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await control.cancelRunInternal(f.oldRun.id, "Delayed old Stop", stop)).toMatchObject({ status: "succeeded" });
      expect(await snapshot()).toEqual(before);
    }
    expect(await control.cancelRunInternal(f.run.id, "Current Stop", stop)).toMatchObject({ status: "cancelled" });
    expect((await snapshot()).handoffs[0]).toMatchObject({ state: "cancelled", completedAt: null });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await snapshot()).cases[0]).toMatchObject({ status: "in_progress", phase: "verification", completedAt: null });
    expect((await snapshot()).events.filter(event => event.kind === "handoff_cancelled")).toHaveLength(1);
    expect((await snapshot()).events.filter(event => event.kind === "handoff_completed")).toHaveLength(0);
  });

  it.each([false, true])("cancels board terminal intent with current failed native retry Stop (correlated=%s)", async correlated => {
    const f = await boardTerminalFixture("running", "native"), control = createHeartbeatRunControl(db, callbacks(db));
    const stop = { resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" },
      ...(correlated ? { cancellationRequestId: randomUUID(), cancellationRequestedByUserId: "operator" } : {}) };
    expect(await control.cancelRunInternal(f.run.id, "Stop the current native retry", stop)).toMatchObject({ status: "cancelled" });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0])
      .toMatchObject({ state: "cancelled", completedAt: null });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0])
      .toMatchObject({ phase: "terminal_failure", failureCode: "native_retry_cancelled", nextAttemptAt: null });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await db.select().from(cases).where(eq(cases.id, f.caseRow.id)))[0])
      .toMatchObject({ status: "in_progress", phase: "verification", completedAt: null });
  });

  it("stops current preparing execution despite a prior terminal checkout when cancelling board intent", async () => {
    // Queue admission binds the new execution before preparation adopts its
    // predecessor's checkout. The execution owner is authoritative in this gap.
    const f = await boardTerminalFixture("running", "legacy", { staleCheckout: true });
    const control = createHeartbeatRunControl(db, callbacks(db));
    const stop = { resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" } };
    expect(await control.cancelRunInternal(f.oldRun.id, "Stop the previous checkout", stop)).toMatchObject({ status: "succeeded" });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0])
      .toMatchObject({ state: "awaiting_completion", cancelledAt: null });
    expect(await control.cancelRunInternal(f.run.id, "Stop current preparation", stop)).toMatchObject({ status: "cancelled" });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0])
      .toMatchObject({ state: "cancelled", completedAt: null });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await db.select().from(cases).where(eq(cases.id, f.caseRow.id)))[0])
      .toMatchObject({ status: "in_progress", phase: "verification", completedAt: null });
  });

  it.each(["legacy", "native"] as const)("does not let an older cancellable %s execution cancel the current board terminal intent", async runtime => {
    const f = await boardTerminalFixture("running");
    await db.update(heartbeatRuns).set({ status: runtime === "native" ? "failed" : "running", runtimeMode: runtime,
      nativeIssueId: runtime === "native" ? f.issue.id : null, finishedAt: null }).where(eq(heartbeatRuns.id, f.oldRun.id));
    if (runtime === "native") await db.insert(nativeRunFinalizations).values({ runId: f.oldRun.id, companyId: f.company.id,
      issueId: f.issue.id, phase: "retryable_failure", nextAttemptAt: new Date(Date.now() + 30_000) });
    const control = createHeartbeatRunControl(db, callbacks(db));
    expect(await control.cancelRunInternal(f.oldRun.id, "Stop the superseded execution", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" },
    })).toMatchObject({ id: f.oldRun.id, status: "cancelled" });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.receipt.handoffId)))[0])
      .toMatchObject({ sourceRunId: null, state: "awaiting_completion", cancelledAt: null });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0])
      .toMatchObject({ status: "running", resultJson: null });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await db.select().from(cases).where(eq(cases.id, f.caseRow.id)))[0])
      .toMatchObject({ status: "done", phase: "done", completedAt: expect.any(Date) });
  });

  it("keeps pre-Stop input pending until a later user message authorizes one continuation", async () => {
    const { company, agent } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Retain my direction after Stop",
      status: "in_progress", assigneeAgentId: agent.id }).returning();
    const runId = randomUUID(), stoppedAt = new Date();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId: agent.id,
      nativeIssueId: issue.id, runtimeMode: "native", status: "cancelled", finishedAt: stoppedAt, processPid: 2_000_000_000,
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId: company.id, issueId: issue.id,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } },
    }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId: company.id, issueId: issue.id,
      phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    const [earlier] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
      authorType: "user", authorUserId: "operator", body: "Keep my changed label", createdAt: new Date(stoppedAt.getTime() - 1000) }).returning();
    const payload = (ids: string[]) => withQueuedCommentIdsInWakePayload({ issueId: issue.id, commentId: ids.at(-1),
      _paperclipWakeContext: { issueId: issue.id, wakeReason: "issue_commented", wakeCommentId: ids.at(-1), wakeCommentIds: ids } }, ids);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id,
      source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "operator", payload: payload([earlier.id]) }).returning();
    const deps = callbacks(db), control = createHeartbeatRunControl(db, deps);
    await control.resumeRemoteStopComments(run);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
    const [later] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
      authorType: "user", authorUserId: "operator", body: "Resume the same task", createdAt: new Date(stoppedAt.getTime() + 1000) }).returning();
    await db.update(agentWakeupRequests).set({ payload: payload([earlier.id, later.id]) }).where(eq(agentWakeupRequests.id, wake.id));
    await control.resumeRemoteStopComments(run);
    expect(deps.enqueueWakeup).toHaveBeenCalledExactlyOnceWith(agent.id, expect.objectContaining({ requestedByActorType: "user",
      requestedByActorId: "operator", queuedCommentRequestId: wake.id,
      payload: expect.objectContaining({ _paperclipWakeContext: expect.objectContaining({ wakeCommentIds: [earlier.id, later.id] }) }),
    }), wake.id);
  });

  it.each(["ephemeral", "reuse_by_environment"] as const)("keeps %s cancellation eligible for retention when teardown loses the task lock", async leasePolicy => {
    const { company, agent } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Retain cancelled work",
      status: "in_progress", assigneeAgentId: agent.id }).returning();
    const runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId: agent.id,
      issueId: issue.id, nativeIssueId: issue.id, runtimeMode: "native", status: "cancelled", finishedAt: new Date(),
      runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: randomUUID(), leaseId, providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy" } },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId: company.id, issueId: issue.id,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } },
    });
    await db.insert(nativeRunFinalizations).values({ runId, companyId: company.id, issueId: issue.id,
      phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId: company.id, heartbeatRunId: runId,
      issueId: issue.id, provider: "daytona", providerLeaseId, status: "active", leasePolicy,
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } });
    const deps = callbacks(db), control = createHeartbeatRunControl(db, deps);
    let ready!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
      ready(); await released;
    });
    await acquired;
    try {
      await control.releaseEnvironmentLeasesForRun({ runId, companyId: company.id, agentId: agent.id,
        status: "cancelled", providerResourceDisposition: "stop_and_retain" });
      expect(deps.envOrchestrator.releaseForRun).not.toHaveBeenCalled();
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0])
        .toMatchObject({ status: "active", leasePolicy });
    } finally { release(); await holding; }
    await preserveCancelledNativeWorkspaces(db);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0])
      .toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    await control.releaseEnvironmentLeasesForRun({ runId, companyId: company.id, agentId: agent.id,
      status: "cancelled", providerResourceDisposition: "destroy" });
    expect(deps.envOrchestrator.releaseForRun).toHaveBeenCalledWith(expect.objectContaining({
      heartbeatRunId: runId, providerResourceDisposition: "stop_and_retain",
    }));
    expect(deps.options.closeWarmNativeSessionsForRun).not.toHaveBeenCalled();
    expect((await deps.getRun(runId))?.status).toBe("cancelled");
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("in_progress");
  }, 15_000);

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

  async function ownedAdapterRun() {
    const { company, agent } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }).returning();
    const control = createAdapterExecutionControl();
    adapterExecutionControls.set(run.id, control);
    return { run, control };
  }

  it("answers an owned adapter Stop that is still settling with a pending conflict", async () => {
    const { run, control } = await ownedAdapterRun();
    const deps = callbacks(db);
    deps.activeRunExecutions.add(run.id);
    try {
      let waitStartedAt = 0;
      vi.mocked(waitForAdapterStop).mockImplementationOnce(async () => {
        waitStartedAt = Date.now();
        throw new AdapterStopTimeoutError(60_000, { runId: run.id });
      });
      const requestedAt = Date.now();
      const error = await createHeartbeatRunControl(db, deps).cancelRunInternal(run.id).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 409,
        message: "Execution is still stopping; termination has not been verified.",
        details: { code: "adapter_stop_pending", runId: run.id },
      });
      expect(control.controller.signal.aborted).toBe(true);
      // Only a Stop that never settles is reported, from the same execution.
      expect(reportAdapterStopIfUnsettled).toHaveBeenCalledWith(control.settled, captureException,
        expect.objectContaining({ runId: run.id, adapterType: "codex_local", runtimeMode: "legacy", abortRequested: true }), control,
        { stopRequestedAt: expect.any(Number) });
      // Its report bound runs from the Stop request, before the response wait.
      const { stopRequestedAt } = vi.mocked(reportAdapterStopIfUnsettled).mock.calls.at(-1)![4]!;
      expect(stopRequestedAt).toBeGreaterThanOrEqual(requestedAt);
      expect(stopRequestedAt).toBeLessThanOrEqual(waitStartedAt);
      // A pending Stop is not a cancellation receipt.
      expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
      expect(deps.finalizeAgentStatus).not.toHaveBeenCalled();
      expect((await deps.getRun(run.id))?.status).toBe("running");
      expect(deps.failedProcessRunCancellations.has(run.id)).toBe(false);
    } finally {
      control.finish();
      adapterExecutionControls.delete(run.id);
    }
  });

  it("keeps other owned adapter Stop failures unchanged", async () => {
    const { run, control } = await ownedAdapterRun();
    const deps = callbacks(db);
    vi.mocked(reportAdapterStopIfUnsettled).mockClear();
    try {
      const failure = new Error("owner wait failed");
      vi.mocked(waitForAdapterStop).mockRejectedValueOnce(failure);
      await expect(createHeartbeatRunControl(db, deps).cancelRunInternal(run.id)).rejects.toBe(failure);
      expect(reportAdapterStopIfUnsettled).not.toHaveBeenCalled();
    } finally {
      control.finish();
      adapterExecutionControls.delete(run.id);
    }
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

});
