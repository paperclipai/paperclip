import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, browserUseRuns, browserUseSessions, budgetPolicies, companies, connectionGrants, costEvents, environmentLeases, heartbeatRuns, issues, projects, toolApplications, toolConnections } from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { runningProcesses } from "../../adapters/index.js";
import { terminateLocalService } from "../local-service-supervisor.js";
import { persistUsageReceipt } from "../usage-receipts.js";
import { registerBudgetEnforcementWork } from "../budget-enforcement-worker.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";
import { PROCESS_START_REQUESTED } from "../native-local-process-stop.js";
import { createPostgresRunDispatchAdapter } from "../../modules/run-dispatch/adapters/postgres.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { listPendingBudgetCancellationScopes } from "./budget-cancellation.js";
import { callbacks, runControlPostgresSupport, setupRunControlDatabase } from "./__tests__/run-control-fixtures.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../local-service-supervisor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../local-service-supervisor.js")>(),
  terminateLocalService: vi.fn(async () => undefined),
}));

describe.skipIf(!runControlPostgresSupport.supported)("scoped budget cancellation", () => {
  let db: Db;
  const { fixture, liveRun } = setupRunControlDatabase("paperclip-heartbeat-budget-cancellation", value => { db = value; });

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

  it("does not apply an earlier enforcement generation after a budget increase", async () => {
    const { company, agent } = await fixture();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: company.id,
      scopeType: "agent", scopeId: agent.id, windowKind: "lifetime", amount: 10_000,
      enforcementVersion: 2, enforcementDeliveredVersion: 1 }).returning();
    const run = await liveRun(company.id, agent.id);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id,
      source: "assignment", status: "queued" }).returning();
    await createHeartbeatRunControl(db, callbacks(db)).cancelBudgetScopeWork({ companyId: company.id,
      scopeType: "agent", scopeId: agent.id, enforcement: { policyId: policy.id, version: 1 } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "running", resultJson: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("queued");
    expect(terminateLocalService).not.toHaveBeenCalled();
  });

  it("fences every affected run and queued wake before bounded provider delivery", async () => {
    const { company, agent } = await fixture();
    const runs = await db.insert(heartbeatRuns).values(Array.from({ length: 5 }, () => ({
      companyId: company.id, agentId: agent.id, status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(),
    }))).returning();
    const [unrelatedAgent] = await db.insert(agents).values({ companyId: company.id, name: "Unrelated" }).returning();
    const unrelated = await db.insert(heartbeatRuns).values({ companyId: company.id,
      agentId: unrelatedAgent.id, status: "running", runtimeMode: "legacy" }).returning().then(rows => rows[0]);
    const wakes = await db.insert(agentWakeupRequests).values([
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "queued" },
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "deferred_issue_execution" },
      { companyId: company.id, agentId: unrelatedAgent.id, source: "assignment", status: "queued" },
    ]).returning();
    runs.forEach((run, i) => runningProcesses.set(run.id, {
      child: { pid: 425000 + i } as never, graceSec: 4, processGroupId: 425000 + i,
    }));
    const releases = new Map<number, () => void>();
    let active = 0, maximumActive = 0, releaseAll = false;
    vi.mocked(terminateLocalService).mockImplementation(async input => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (!releaseAll) await new Promise<void>(resolve => releases.set(input.pid, resolve));
      active -= 1;
    });
    const deps = callbacks(db);
    const delivery = createHeartbeatRunControl(db, deps).cancelBudgetScopeWork({ companyId: company.id,
      scopeType: "agent", scopeId: agent.id });
    try {
      await vi.waitFor(() => expect(releases.size).toBe(4));
      const persisted = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runs.map(run => run.id)));
      expect(persisted.every(run => run.status === "running" && Boolean(run.resultJson?.startupCancellation))).toBe(true);
      const pendingWakes = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakes.map(wake => wake.id)));
      expect(wakes.map(wake => pendingWakes.find(row => row.id === wake.id)?.status)).toEqual(["cancelled", "cancelled", "queued"]);
      expect((await deps.getRun(unrelated.id))?.resultJson).toBeNull();
      // A slow first Stop must not stop another slot from making progress.
      const firstPid = releases.keys().next().value!;
      const otherPid = [...releases.keys()].find(pid => pid !== firstPid)!;
      releases.get(otherPid)!();
      await vi.waitFor(() => expect(releases.size).toBe(5));
      expect(maximumActive).toBe(4);
      expect(active).toBe(4);
    } finally {
      releaseAll = true;
      releases.forEach(release => release());
      await delivery;
    }
    expect((await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runs.map(run => run.id))))
      .every(run => run.status === "cancelled" && (run.resultJson?.executionCancellation as { state?: string })?.state === "acknowledged")).toBe(true);
    expect((await deps.getRun(unrelated.id))?.status).toBe("running");
  });

  it("wakes scoped Stop delivery from a partial usage overrun without waiting for adapter termination", async () => {
    const { company, agent } = await fixture();
    const [project, otherProject] = await db.insert(projects).values([
      { companyId: company.id, name: "Over budget" }, { companyId: company.id, name: "Still admitted" },
    ]).returning();
    const sourceId = randomUUID();
    const run = await liveRun(company.id, agent.id);
    await db.update(heartbeatRuns).set({ contextSnapshot: { projectId: project.id }, costAccountingPending: true,
      usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0,
        accountingReceiptReady: false, ledgerScope: { projectId: project.id } },
    }).where(eq(heartbeatRuns.id, run.id));
    const [queued, unrelated] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: agent.id, status: "queued", runtimeMode: "legacy", contextSnapshot: { projectId: project.id } },
      { companyId: company.id, agentId: agent.id, status: "running", runtimeMode: "legacy", contextSnapshot: { projectId: otherProject.id } },
    ]).returning();
    const wakes = await db.insert(agentWakeupRequests).values([
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "queued", payload: { projectId: project.id } },
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "deferred_issue_execution", payload: { projectId: project.id } },
      { companyId: company.id, agentId: agent.id, source: "assignment", status: "queued", payload: { projectId: otherProject.id } },
    ]).returning();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: company.id, scopeType: "project",
      scopeId: project.id, windowKind: "lifetime", amount: 100, notifyEnabled: false }).returning();
    let releaseTermination!: () => void;
    const termination = new Promise<void>(resolve => { releaseTermination = resolve; });
    vi.mocked(terminateLocalService).mockImplementation(async () => termination);
    const deps = callbacks(db);
    const control = createHeartbeatRunControl(db, deps);
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: errors });
    const worker = registerBudgetEnforcementWork(db, coordinator, { cancelWorkForScope: control.cancelBudgetScopeWork });
    try {
      // Drain startup recovery first: only the receipt's committed notification
      // may wake the idle worker below. Do not call wake or deliver explicitly.
      await worker.ready;
      expect(terminateLocalService).not.toHaveBeenCalled();
      expect(coordinator.nextWakeAt()).toBeNull();
      const startedAt = performance.now();
      await persistUsageReceipt(db, { schema: "paperclip/accounting-receipt/v1", id: randomUUID(),
        companyId: company.id, runId: run.id, sourceId, sequence: 1, receivedAt: new Date().toISOString(),
        adapterType: agent.adapterType, receipt: { complete: false, usageBasis: "per_run", costUsd: 1.1,
          provider: "test", biller: "test", model: "budget-stop-fixture", billingType: "metered_api", costStatus: "unpriced" },
      });
      const receiptReturnedAt = performance.now();
      await vi.waitFor(async () => {
        const persisted = await deps.getRun(run.id);
        expect(persisted).toMatchObject({ status: "running", usageJson: { budgetExposure: { sequence: 1, costCents: "110.0000000" } },
          resultJson: { startupCancellation: { budgetEnforcement: { policyId: policy.id, scopeType: "project", scopeId: project.id } } } });
        expect(terminateLocalService).toHaveBeenCalledTimes(1);
      }, { interval: 10, timeout: 3_000 });
      const fenceObservedAt = performance.now();
      const fenced = await deps.getRun(run.id);
      expect(fenced?.resultJson?.executionCancellation).toBeUndefined();
      expect((await deps.getRun(queued.id))?.resultJson?.startupCancellation).toBeTruthy();
      const persistedWakes = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakes.map(wake => wake.id)));
      expect(wakes.map(wake => persistedWakes.find(row => row.id === wake.id)?.status)).toEqual(["cancelled", "cancelled", "queued"]);
      const [pending] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
      expect(pending.enforcementVersion).toBeGreaterThan(pending.enforcementDeliveredVersion);

      const requestStartedAt = performance.now();
      let responseTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const rows = await Promise.race([
          db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.id)),
          new Promise<never>((_, reject) => { responseTimeout = setTimeout(() => reject(new Error("Unrelated database request blocked by Stop delivery")), 1_000); }),
        ]);
        expect(rows[0]).toMatchObject({ status: "running", resultJson: null });
      } finally { clearTimeout(responseTimeout); }
      const unrelatedRequestMs = performance.now() - requestStartedAt;
      const terminationReleasedAt = performance.now();
      releaseTermination();
      await vi.waitFor(async () => {
        expect(await deps.getRun(run.id)).toMatchObject({ status: "cancelled", resultJson: { executionCancellation: { state: "acknowledged" } } });
        const [delivered] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
        expect(delivered.enforcementDeliveredVersion).toBe(delivered.enforcementVersion);
      }, { interval: 10, timeout: 3_000 });
      expect((await deps.getRun(unrelated.id))?.status).toBe("running");
      expect(errors).not.toHaveBeenCalled();
      console.info("Partial usage budget Stop timing", { receiptMs: Math.round(receiptReturnedAt - startedAt),
        receiptReturnToFenceMs: Math.round(fenceObservedAt - receiptReturnedAt), unrelatedRequestMs: Math.round(unrelatedRequestMs),
        controlledTerminationWaitMs: Math.round(terminationReleasedAt - fenceObservedAt),
        terminationReleaseToAcknowledgementMs: Math.round(performance.now() - terminationReleasedAt) });
    } finally {
      releaseTermination();
      await coordinator.stop();
    }
  });

  it("drains other provider stops after a failed delivery and retries the unfinished run", async () => {
    const { company, agent } = await fixture();
    const failed = await liveRun(company.id, agent.id);
    const [other] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }).returning();
    runningProcesses.set(other.id, { child: { pid: 434343 } as never, graceSec: 4, processGroupId: 434343 });
    vi.mocked(terminateLocalService).mockImplementation(async input => {
      if (input.pid === 424242) throw new Error("provider unreachable");
    });
    const deps = callbacks(db);
    const control = createHeartbeatRunControl(db, deps);
    const scope = { companyId: company.id, scopeType: "agent" as const, scopeId: agent.id };
    await expect(control.cancelBudgetScopeWork(scope)).rejects.toThrow("Budget cancellation delivery remains pending");
    expect((await deps.getRun(other.id))?.status).toBe("cancelled");
    expect(await deps.getRun(failed.id)).toMatchObject({ status: "running", resultJson: { startupCancellation: expect.any(Object) } });
    expect(runningProcesses.has(failed.id)).toBe(true);
    vi.mocked(terminateLocalService).mockResolvedValue(undefined);
    await control.cancelBudgetScopeWork(scope);
    expect(await deps.getRun(failed.id)).toMatchObject({ status: "cancelled", resultJson: { executionCancellation: { state: "acknowledged" } } });
  });

  it("shares four Stop slots across independent scopes and service instances", async () => {
    const { company, agent } = await fixture();
    const [otherAgent] = await db.insert(agents).values({ companyId: company.id, name: "Another scope" }).returning();
    const runs = await db.insert(heartbeatRuns).values([agent.id, otherAgent.id].flatMap(agentId =>
      Array.from({ length: 3 }, () => ({ companyId: company.id, agentId,
        status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date() })))).returning();
    runs.forEach((run, i) => runningProcesses.set(run.id, {
      child: { pid: 435000 + i } as never, graceSec: 4, processGroupId: 435000 + i,
    }));
    let active = 0, maximumActive = 0, releaseAll = false;
    const releases = new Map<number, () => void>();
    vi.mocked(terminateLocalService).mockImplementation(async input => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (!releaseAll) await new Promise<void>(resolve => releases.set(input.pid, resolve));
      active -= 1;
    });
    const deliveries = [agent, otherAgent].map(selected => createHeartbeatRunControl(db, callbacks(db))
      .cancelBudgetScopeWork({ companyId: company.id, scopeType: "agent", scopeId: selected.id }));
    try {
      await vi.waitFor(() => expect(releases.size).toBe(4));
      expect(maximumActive).toBe(4);
      expect((await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runs.map(run => run.id))))
        .every(run => Boolean(run.resultJson?.startupCancellation))).toBe(true);
      releases.values().next().value!();
      await vi.waitFor(() => expect(releases.size).toBe(5));
      expect(maximumActive).toBe(4);
    } finally {
      releaseAll = true;
      releases.forEach(release => release());
      await Promise.all(deliveries);
    }
  });

  it("blocks retry promotion after the budget batch commits but before Stop delivery", async () => {
    const { company, agent } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "scheduled_retry", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(),
      scheduledRetryAt: new Date(), scheduledRetryReason: "transient_failure" }).returning();
    const deps = callbacks(db);
    const getAgent = deps.getAgent.getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const deliveryEntered = new Promise<void>(resolve => { entered = resolve; });
    const continueDelivery = new Promise<void>(resolve => { release = resolve; });
    deps.getAgent.mockImplementationOnce(async id => { entered(); await continueDelivery; return getAgent(id); });
    const cancellation = createHeartbeatRunControl(db, deps).cancelBudgetScopeWork({ companyId: company.id,
      scopeType: "agent", scopeId: agent.id });
    try {
      await deliveryEntered;
      expect(await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry({
        companyId: company.id, runId: run.id, now: new Date(),
      })).toMatchObject({ outcome: "not_promoted" });
      expect(await deps.getRun(run.id)).toMatchObject({ status: "scheduled_retry",
        resultJson: { startupCancellation: expect.any(Object) } });
    } finally {
      release();
      await cancellation;
    }
    expect(await deps.getRun(run.id)).toMatchObject({ status: "cancelled" });
  });

  it("recovers a committed Stop after its policy was deleted without fencing newly admitted work", async () => {
    const { company, agent } = await fixture();
    const oldRun = await liveRun(company.id, agent.id);
    const [newRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "queued", runtimeMode: "legacy" }).returning();
    const intent = { companyId: company.id, scopeType: "agent", scopeId: agent.id,
      policyId: randomUUID(), version: 1 };
    await db.update(heartbeatRuns).set({ resultJson: { startupCancellation: {
      requestedAt: new Date().toISOString(), budgetEnforcement: intent,
    } } }).where(eq(heartbeatRuns.id, oldRun.id));
    const scopes = await listPendingBudgetCancellationScopes(db);
    expect(scopes).toHaveLength(1);
    const deps = callbacks(db);
    await createHeartbeatRunControl(db, deps).cancelBudgetScopeWork(scopes[0]);
    expect(await deps.getRun(oldRun.id)).toMatchObject({ status: "cancelled",
      resultJson: { startupCancellation: { budgetEnforcement: { deliveredAt: expect.any(String) } } } });
    expect(await deps.getRun(newRun.id)).toMatchObject({ status: "queued", resultJson: null });
    expect(await listPendingBudgetCancellationScopes(db)).toEqual([]);
  });

  it("retains a terminal budget Stop until actual stop acknowledgement exists", async () => {
    const { company, agent } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), resultJson: {
        startupCancellation: { budgetEnforcement: { companyId: company.id, scopeType: "agent", scopeId: agent.id,
          policyId: randomUUID(), version: 1 } },
      } }).returning();
    const control = createHeartbeatRunControl(db, callbacks(db));
    const [scope] = await listPendingBudgetCancellationScopes(db);
    await expect(control.cancelBudgetScopeWork(scope)).rejects.toThrow("Budget cancellation delivery remains pending");
    expect(await listPendingBudgetCancellationScopes(db)).toHaveLength(1);
    expect(terminateLocalService).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
      executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() },
    } }).where(eq(heartbeatRuns.id, run.id));
    await control.cancelBudgetScopeWork(scope);
    expect(await listPendingBudgetCancellationScopes(db)).toEqual([]);
  });

  it.each(["local exit", "remote receipt", "unproven", "later launch"] as const)("reconciles normal completion before queued budget Stop using %s evidence", async evidence => {
    const { company, agent } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "running", runtimeMode: "native", startedAt: new Date() }).returning();
    const deps = callbacks(db);
    if (evidence === "local exit" || evidence === "later launch") {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 50)"], { detached: true, stdio: "ignore" });
      const exited = once(child, "exit");
      try {
        expect(child.pid).toBeGreaterThan(1);
        await deps.persistRunProcessMetadata(run.id, { pid: child.pid!, processGroupId: child.pid!,
          startedAt: new Date().toISOString(), targetKind: "local" });
        await exited;
      } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
      if (evidence === "later launch") await deps.appendRunEvent(run, {
        eventType: PROCESS_START_REQUESTED, stream: "system", level: "info", message: "A later launch invalidated the earlier exit proof",
      });
    }
    if (evidence === "remote receipt") {
      const leaseId = randomUUID(), providerLeaseId = randomUUID();
      await db.insert(environmentLeases).values({ id: leaseId, companyId: company.id, heartbeatRunId: run.id,
        provider: "daytona", providerLeaseId, status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId: company.id,
          runId: run.id, leaseId, provider: "daytona", providerLeaseId, state: "stopped", confirmedAt: new Date().toISOString() } },
      });
    }
    const getRun = deps.getRun.getMockImplementation()!;
    deps.getRun.mockImplementationOnce(async id => {
      // Budget delivery persisted its fence, then ordinary native completion
      // won the race before this run acquired a provider Stop delivery slot.
      expect((await getRun(id))?.resultJson?.startupCancellation).toBeTruthy();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), nativePhase: "committed",
        processPid: null, processGroupId: null, processStartedAt: null }).where(eq(heartbeatRuns.id, id));
      return getRun(id);
    });
    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({ id: policyId, companyId: company.id, scopeType: "agent",
      scopeId: agent.id, windowKind: "lifetime", amount: 1, enforcementVersion: 1 });
    await db.insert(costEvents).values({ companyId: company.id, agentId: agent.id, provider: "test",
      model: "overrun", inputTokens: 1, outputTokens: 1, costCents: 2, occurredAt: new Date() });
    const scope = { companyId: company.id, scopeType: "agent" as const, scopeId: agent.id,
      enforcement: { policyId, version: 1 } };
    const control = createHeartbeatRunControl(db, deps);
    const succeeded = evidence === "local exit" || evidence === "remote receipt";
    const delivery = control.cancelBudgetScopeWork(scope);
    if (succeeded) await delivery;
    else await expect(delivery).rejects.toThrow("Budget cancellation delivery remains pending");
    const persisted = await getRun(run.id);
    expect(persisted).toMatchObject({ status: "succeeded", nativePhase: "committed" });
    expect(persisted?.resultJson?.executionCancellation).toBeUndefined();
    const intent = (persisted?.resultJson?.startupCancellation as { budgetEnforcement?: Record<string, unknown> })?.budgetEnforcement;
    if (succeeded) expect(intent).toMatchObject({ deliveredAt: expect.any(String),
      terminationProof: evidence === "local exit" ? "local_process_exit" : "provider_termination_receipt" });
    else expect(intent?.deliveredAt).toBeUndefined();
    expect(await listPendingBudgetCancellationScopes(db)).toHaveLength(succeeded ? 0 : 1);
    expect(terminateLocalService).not.toHaveBeenCalled();
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
  });

  it("moves an attempted failed Stop behind another pending scope", async () => {
    const { company, agent } = await fixture();
    const [otherAgent] = await db.insert(agents).values({ companyId: company.id, name: "Later recovery" }).returning();
    await db.insert(heartbeatRuns).values([agent, otherAgent].map((selected, index) => ({
      companyId: company.id, agentId: selected.id, status: "cancelled", runtimeMode: "legacy",
      resultJson: { startupCancellation: { requestedAt: `2020-01-0${index + 1}T00:00:00.000Z`,
        budgetEnforcement: { companyId: company.id, scopeType: "agent", scopeId: selected.id,
          policyId: randomUUID(), version: 1 } } },
    })));
    const [first] = await listPendingBudgetCancellationScopes(db, 1);
    expect(first.scopeId).toBe(agent.id);
    await expect(createHeartbeatRunControl(db, callbacks(db)).cancelBudgetScopeWork(first))
      .rejects.toThrow("Budget cancellation delivery remains pending");
    const [next] = await listPendingBudgetCancellationScopes(db, 1);
    expect(next.scopeId).toBe(otherAgent.id);
    const [attempted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id));
    expect((attempted.resultJson?.startupCancellation as { budgetEnforcement?: { lastAttemptAt?: string } })
      ?.budgetEnforcement?.lastAttemptAt).toEqual(expect.any(String));
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

  it("fences detached browsers after their parent run finishes using admitted project scope and cutoff", async () => {
    const { company, agent } = await fixture();
    const [project, otherProject] = await db.insert(projects).values([
      { companyId: company.id, name: "Stopped project" }, { companyId: company.id, name: "Other project" },
    ]).returning();
    const [movedIssue, targetIssue] = await db.insert(issues).values([
      { companyId: company.id, projectId: otherProject.id, title: "Moved after browser admission" },
      { companyId: company.id, projectId: project.id, title: "Current project" },
    ]).returning();
    const [parent] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "succeeded", finishedAt: new Date(), runtimeMode: "legacy" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "Browser fixture", type: "rest_api" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id,
      name: "Browser fixture", uid: "budget-browser-fixture", transport: "rest_api" }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, kind: "organization" }).returning();
    const cutoff = new Date();
    const old = new Date(cutoff.getTime() - 1_000);
    const later = new Date(cutoff.getTime() + 60_000);
    const [admitted, other, legacy, newer, noProject] = await db.insert(browserUseSessions).values([
      { issueId: movedIssue.id, stopRequested: "cancel" }, { issueId: targetIssue.id },
      { issueId: targetIssue.id }, { issueId: targetIssue.id, createdAt: later }, { issueId: targetIssue.id },
    ].map(values => ({ companyId: company.id, agentId: agent.id, connectionId: connection.id, grantId: grant.id,
      providerSessionId: randomUUID(), status: "running", createdAt: old, nextPollAt: later,
      leaseToken: randomUUID(), leaseUntil: later, error: "retained cleanup context", ...values }))).returning();
    await db.insert(browserUseRuns).values([admitted, other, legacy, noProject].map((session, index) => {
      const invocationId = randomUUID();
      return { companyId: company.id, sessionId: session.id, heartbeatRunId: parent.id, invocationId,
        status: "running", detachedUntil: later, createdAt: old,
        result: index === 2 ? null : { paperclipBudgetHold: { invocationId, amountCents: "10", state: "held",
          projectId: index === 0 ? project.id : index === 1 ? otherProject.id : null } },
      };
    }));
    const wake = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.browser, wake);
    const deps = callbacks(db);
    try {
      await createHeartbeatRunControl(db, deps).cancelBudgetScopeWork({ companyId: company.id,
        scopeType: "project", scopeId: project.id, createdBefore: cutoff });
      const persisted = await db.select().from(browserUseSessions).where(eq(browserUseSessions.companyId, company.id));
      for (const original of [admitted, legacy]) {
        const stopped = persisted.find(session => session.id === original.id)!;
        expect(stopped).toMatchObject({ status: "stopping", stopRequested: "end", providerSessionId: original.providerSessionId,
          leaseToken: original.leaseToken, leaseUntil: original.leaseUntil, error: original.error });
        expect(stopped.nextPollAt.getTime()).toBeLessThan(later.getTime());
      }
      for (const original of [other, newer, noProject]) expect(persisted.find(session => session.id === original.id)).toEqual(original);
      expect(await deps.getRun(parent.id)).toMatchObject({ status: "succeeded", resultJson: null });
      expect(wake).toHaveBeenCalledTimes(1);
      expect(terminateLocalService).not.toHaveBeenCalled();
      expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});
