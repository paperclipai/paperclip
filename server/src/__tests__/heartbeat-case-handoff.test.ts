import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, authSessions, authUsers, caseEvents, caseHandoffs, cases, companies, companyMemberships,
  createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { issueRecoveryActions, issueRelations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertNoCaseHandoffMutation, isCaseHandoffSourceReleased, recordCaseHandoffExecutionReleased, recordLegacyCaseHandoffCleanupIntent, recordLegacyCaseHandoffCleanupVerified } from "../services/heartbeat/case-handoff-lifecycle.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { caseHandoffActorContext } from "../services/case-handoff-authority.js";
import { conflict } from "../errors.js";
import { prepareHeartbeatRunScratch, cleanupHeartbeatRunScratch } from "../services/run-scratch.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { createAgentIdentityRedactor } from "../services/agent-identity-redaction.js";
import { createHeartbeatRunOutput } from "../services/heartbeat/run-output.js";

describe("durable case handoff queue admission", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const heldRuns = new Set<string>();
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("case-handoff-queue-"); db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableCases: true }); });
  afterAll(async () => { for (const id of heldRuns) runningProcesses.delete(id); await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), caseId = randomUUID(), handoffId = randomUUID(),
      userId = randomUUID(), sessionId = randomUUID(), wakeupRequestId = randomUUID(), occupyingRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Factory", issuePrefix: `Q${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(authSessions).values({ id: sessionId, userId, token: randomUUID(), createdAt: new Date(), updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000) });
    const actorContext = caseHandoffActorContext({ type: "board", userId, source: "session", sessionId, companyIds: [companyId] }, companyId);
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "ceo", status: "running", adapterType: "process",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } } });
    // Hold the recipient's ordinary concurrency slot so admission remains
    // observable without a provider mock or racing background execution.
    await db.insert(heartbeatRuns).values({ id: occupyingRunId, companyId, agentId, status: "running", responsibleUserId: userId,
      contextSnapshot: { issueId: randomUUID() }, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    runningProcesses.set(occupyingRunId, { child: {} as never, graceSec: 0, processGroupId: null }); heldRuns.add(occupyingRunId);
    await db.insert(issues).values({ id: issueId, companyId, title: "Build", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId });
    await db.insert(cases).values({ id: caseId, companyId, caseNumber: 1, identifier: `CASE-${caseId}`, caseType: "work", title: "Build",
      workIssueId: issueId, handoffVersion: 1, phase: "implementation" });
    await db.insert(caseHandoffs).values({ id: handoffId, companyId, caseId, issueId, version: 1, toAgentId: agentId, phase: "implementation",
      instructions: "Build the requested change", actorType: "user", actorId: userId, actorContext, responsibleUserId: userId,
      expectedIssueStatusVersion: 0, appliedIssueStatusVersion: 0, wakeupRequestId, idempotencyKey: "start", inputFingerprint: "fixture", state: "pending_dispatch" });
    const options = { source: "assignment" as const, triggerDetail: "system" as const, reason: "case_handoff", requestedByActorType: "user" as const,
      requestedByActorId: userId, payload: { issueId, handoffId }, contextSnapshot: { issueId, taskKey: issueId, responsibleUserId: userId },
      durableCaseHandoffRequest: { handoffId, wakeupRequestId, issueId, expectedIssueStatusVersion: 0 } };
    return { companyId, agentId, issueId, caseId, handoffId, userId, sessionId, wakeupRequestId, occupyingRunId, options };
  }
  it("blocks generic wakes and admits one exact receipt across separate scheduler instances", async () => {
    const f = await fixture();
    expect(await heartbeatService(db).wakeup(f.agentId, { source: "assignment", reason: "issue_assigned", payload: { issueId: f.issueId } })).toBeNull();
    const first = await heartbeatService(db).wakeup(f.agentId, f.options);
    expect(first).toMatchObject({ status: "queued", wakeupRequestId: f.wakeupRequestId });
    const second = await heartbeatService(db).wakeup(f.agentId, f.options);
    expect(second?.id).toBe(first?.id);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId)))).toHaveLength(1);
  });
  it("does not spend the durable receipt on a paused recipient and retries the same identity", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    expect(await heartbeatService(db).wakeup(f.agentId, f.options)).toBeNull();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(0);
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.agentId));
    expect(await heartbeatService(db).wakeup(f.agentId, f.options)).toMatchObject({ wakeupRequestId: f.wakeupRequestId });
  });
  it("rejects an invented handoff version before creating a wake", async () => {
    const f = await fixture();
    await expect(heartbeatService(db).wakeup(f.agentId, { ...f.options,
      durableCaseHandoffRequest: { ...f.options.durableCaseHandoffRequest, expectedIssueStatusVersion: 42 } })).rejects.toThrow("assignment");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(0);
  });
  it.each(["dependencies", "workspace", "recovery", "daily_cap"] as const)(
    "retains the same unspent receipt across a %s hold and a delivery worker restart", async hold => {
      const f = await fixture();
      let clear!: () => Promise<void>;
      if (hold === "dependencies") {
        const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Late blocker", status: "todo" }).returning();
        await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issueId, type: "blocks" });
        clear = async () => { await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id)); };
      } else if (hold === "workspace") {
        await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
        await db.update(issues).set({ executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } } })
          .where(eq(issues.id, f.issueId));
        clear = async () => { await db.update(issues).set({ executionWorkspaceSettings: null }).where(eq(issues.id, f.issueId)); };
      } else if (hold === "recovery") {
        const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
          kind: "execution_reconciliation", cause: "uncertain_provider_action", fingerprint: randomUUID(), nextAction: "Confirm provider settlement", status: "active" }).returning();
        clear = async () => { await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issueRecoveryActions.id, action.id)); };
      } else {
        await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true, maxDailyRuns: 0 } } })
          .where(eq(agents.id, f.agentId));
        clear = async () => { await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } } }).where(eq(agents.id, f.agentId)); };
      }
      const at = new Date(Date.now() + 60_000);
      await caseHandoffDeliveryService(db, { heartbeat: heartbeatService(db), now: () => at }).sweepPending();
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0])
        .toMatchObject({ state: "pending_dispatch", wakeupRequestId: f.wakeupRequestId, leaseExpiresAt: null });
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
        .toMatchObject({ status: "todo", assigneeAgentId: f.agentId });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId))).toHaveLength(0);
      await clear();
      const restarted = heartbeatService(db);
      await caseHandoffDeliveryService(db, { heartbeat: restarted, now: () => new Date(at.getTime() + 61_000) }).sweepPending();
      const [accepted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId));
      expect(accepted).toMatchObject({ status: "queued", payload: { issueId: f.issueId } });
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]?.state).toBe("delivered");
      expect(await heartbeatService(db).wakeup(f.agentId, f.options)).toMatchObject({ id: accepted.runId, wakeupRequestId: f.wakeupRequestId });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId))).toHaveLength(1);
    },
  );
  it("retains a handoff and its mutation fence after an unconfirmed Stop, then delivers after settlement", async () => {
    const f = await fixture(), sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId }, responsibleUserId: f.userId });
    await db.update(issues).set({ executionRunId: sourceRunId }).where(eq(issues.id, f.issueId));
    await db.update(caseHandoffs).set({ state: "awaiting_release", sourceRunId, fromAgentId: f.agentId,
      createdAt: new Date(Date.now() - 31_000) }).where(eq(caseHandoffs.id, f.handoffId));
    const at = new Date(Date.now() + 60_000), heartbeat = heartbeatService(db);
    await caseHandoffDeliveryService(db, { now: () => at, heartbeat: { wakeup: heartbeat.wakeup,
      requestCaseHandoffYield: async () => { throw conflict("Adapter cleanup is still settling", { code: "adapter_stop_pending" }); },
    } }).sweepPending();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0])
      .toMatchObject({ state: "awaiting_release", cancelledAt: null, leaseExpiresAt: null });
    await expect(assertNoCaseHandoffMutation(db, sourceRunId, f.issueId)).rejects.toThrow("handed off");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, sourceRunId));
    await recordCaseHandoffExecutionReleased(db, sourceRunId, f.issueId);
    const restarted = heartbeatService(db);
    await caseHandoffDeliveryService(db, { now: () => new Date(at.getTime() + 61_000), heartbeat: {
      wakeup: async (agentId, options) => {
        await restarted.wakeup(agentId, options);
        throw new Error("Controller acknowledgement lost after queue commit");
      },
    } }).sweepPending();
    const [afterSettlement] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId));
    expect(afterSettlement).toMatchObject({ actorType: "user", actorId: f.userId,
      actorContext: { source: "session", actorId: f.userId, companyId: f.companyId, sessionId: f.sessionId } });
    expect(afterSettlement?.state, afterSettlement?.lastError ?? undefined).toBe("pending_dispatch");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId))).toHaveLength(1);
    await caseHandoffDeliveryService(db, { heartbeat: heartbeatService(db), now: () => new Date(at.getTime() + 122_000) }).sweepPending();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]?.state).toBe("delivered");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId))).toHaveLength(1);
  });
  it("retains a settled legacy transfer without authenticated original actor provenance", async () => {
    const f = await fixture(), sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId: f.issueId }, responsibleUserId: f.userId });
    await db.update(issues).set({ executionRunId: sourceRunId }).where(eq(issues.id, f.issueId));
    await db.update(caseHandoffs).set({ state: "awaiting_release", sourceRunId, fromAgentId: f.agentId,
      actorContext: null, appliedIssueStatusVersion: null, assignmentAppliedAt: null }).where(eq(caseHandoffs.id, f.handoffId));
    await recordCaseHandoffExecutionReleased(db, sourceRunId, f.issueId);
    expect(await isCaseHandoffSourceReleased(db, { runId: sourceRunId, issueId: f.issueId })).toBe(true);
    await caseHandoffDeliveryService(db, { heartbeat: heartbeatService(db), now: () => new Date(Date.now() + 60_000) }).sweepPending();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]).toMatchObject({
      state: "awaiting_release", actorContext: null, lastErrorCode: "access_or_admission_blocked",
      lastError: "Handoff original actor context is unavailable", assignmentAppliedAt: null, appliedIssueStatusVersion: null,
    });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "todo", statusVersion: 0, assigneeAgentId: f.agentId, executionRunId: sourceRunId });
    expect((await db.select().from(cases).where(eq(cases.id, f.caseId)))[0]!.phase).toBe("implementation");
    expect(await db.select().from(caseEvents).where(and(eq(caseEvents.caseId, f.caseId), eq(caseEvents.kind, "handoff_applied")))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId))).toHaveLength(0);
    await expect(assertNoCaseHandoffMutation(db, sourceRunId, f.issueId)).rejects.toThrow("handed off");
  });
  it.each(["after_removal", "before_removal"] as const)("recovers a clean local legacy handoff across a %s crash before the release marker", async crash => {
    const f = await fixture(), sourceRunId = randomUUID(), controllerBootId = randomUUID();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    const processId = child.pid!, processStartedAt = new Date();
    const scratch = await prepareHeartbeatRunScratch({ companyId: f.companyId, agentId: f.agentId, runId: sourceRunId, issueId: f.issueId });
    let restartedDb: ReturnType<typeof createDb> | undefined;
    try {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
        status: "succeeded", runtimeMode: "legacy", startedAt: processStartedAt, finishedAt: new Date(), controllerBootId,
        processPid: processId, processGroupId: processId, processStartedAt, contextSnapshot: { issueId: f.issueId }, responsibleUserId: f.userId });
      await db.update(issues).set({ executionRunId: sourceRunId }).where(eq(issues.id, f.issueId));
      await db.update(caseHandoffs).set({ state: "awaiting_release", sourceRunId, fromAgentId: f.agentId }).where(eq(caseHandoffs.id, f.handoffId));
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
      const output = createHeartbeatRunOutput(db, { run: source, runId: sourceRunId, issueId: f.issueId,
        runLogStore: { begin: async () => ({ store: "local_file", logRef: "synthetic-legacy-log" }), append: async () => 0 },
        identityRedactor: createAgentIdentityRedactor(), secretKeys: new Set(), getCurrentUserRedactionOptions: async () => ({ enabled: false }),
        appendRunEvent: (run, event) => appendHeartbeatRunEvent(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id, ...event }),
      });
      const handlers = await output.begin(source);
      await handlers.onAdapterEvent({ eventType: "legacy.case_handoff_cleanup_verified", stream: "system", payload: {
        schema: "paperclip.legacy-case-handoff-cleanup.v1", issueId: f.issueId, host: hostname(), controllerBootId,
        processPid: processId, processGroupId: processId, processStartedAt: processStartedAt.toISOString(), scratch,
      } });
      expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, sourceRunId),
        eq(heartbeatRunEvents.eventType, "legacy.case_handoff_cleanup_verified")))).toHaveLength(0);
      await handlers.onAdapterEvent({ eventType: "adapter.progress", stream: "system", payload: { stage: "finished" } });
      expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, sourceRunId),
        eq(heartbeatRunEvents.eventType, "adapter.progress")))).toHaveLength(1);
      expect(await isCaseHandoffSourceReleased(db, { runId: sourceRunId, issueId: f.issueId })).toBe(false);
      const groupAlive = (group: number | null | undefined) => { try { process.kill(-group!, 0); return true; } catch { return false; } };
      const cleanup = cleanupHeartbeatRunScratch({ scratch, processGroupId: processId, isProcessGroupAlive: groupAlive,
        beforeRemove: async () => {
          await recordLegacyCaseHandoffCleanupVerified(db, { runId: sourceRunId, controllerBootId, scratch });
          if (crash === "before_removal") throw new Error("Controller crashed before scratch removal");
        } });
      if (crash === "before_removal") await expect(cleanup).rejects.toThrow("Controller crashed");
      else expect(await cleanup).toMatchObject({ removed: true });
      const [receipt] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, sourceRunId),
        eq(heartbeatRunEvents.eventType, "legacy.case_handoff_cleanup_verified")));
      expect(receipt).toMatchObject({ sourceEventId: null, payload: { issueId: f.issueId, processPid: processId, processGroupId: processId } });

      // Provider-authored evidence and a different process/controller generation
      // cannot grant release, even if their payload copies the exact receipt.
      await db.update(heartbeatRunEvents).set({ sourceEventId: "provider-forged-stop" }).where(eq(heartbeatRunEvents.id, receipt.id));
      expect(await isCaseHandoffSourceReleased(db, { runId: sourceRunId, issueId: f.issueId })).toBe(false);
      await db.update(heartbeatRunEvents).set({ sourceEventId: null }).where(eq(heartbeatRunEvents.id, receipt.id));
      await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, sourceRunId));
      expect(await isCaseHandoffSourceReleased(db, { runId: sourceRunId, issueId: f.issueId })).toBe(false);
      await db.update(heartbeatRuns).set({ controllerBootId }).where(eq(heartbeatRuns.id, sourceRunId));
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId)))[0]?.resultJson ?? {}).not.toHaveProperty("caseHandoffExecutionReleased");

      restartedDb = createDb(temporary.connectionString);
      const at = new Date(Date.now() + 61_000);
      await caseHandoffDeliveryService(restartedDb, { heartbeat: heartbeatService(restartedDb), now: () => at }).sweepPending();
      const [afterRestart] = await restartedDb.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId));
      expect(afterRestart?.state, afterRestart?.lastError ?? undefined).toBe("delivered");
      expect(await restartedDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId))).toHaveLength(1);
      expect((await restartedDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId)))[0]?.resultJson)
        .toHaveProperty("caseHandoffExecutionReleased");
    } finally {
      try { process.kill(-processId, "SIGTERM"); } catch { /* already stopped */ }
      await rm(scratch.dir, { recursive: true, force: true });
      await restartedDb?.$client.end();
    }
  });
  it.each([true, false])("recovers a legacy crash before cleanup begins with scratch=%s, only after real stop and workspace settlement", async withScratch => {
    const f = await fixture(), sourceRunId = randomUUID(), controllerBootId = randomUUID(), startedAt = new Date();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    const processId = child.pid!;
    const scratch = withScratch ? await prepareHeartbeatRunScratch({ companyId: f.companyId, agentId: f.agentId,
      runId: sourceRunId, issueId: f.issueId }) : null;
    let restartedDb: ReturnType<typeof createDb> | undefined;
    try {
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
        status: "running", runtimeMode: "legacy", startedAt, controllerBootId, processPid: processId,
        processGroupId: processId, processStartedAt: startedAt, contextSnapshot: { issueId: f.issueId }, responsibleUserId: f.userId });
      // Preparation records intent even before a handoff references this run.
      await recordLegacyCaseHandoffCleanupIntent(db, { runId: sourceRunId, issueId: f.issueId, controllerBootId, scratch });
      await db.update(issues).set({ executionRunId: sourceRunId }).where(eq(issues.id, f.issueId));
      await db.update(caseHandoffs).set({ state: "awaiting_release", sourceRunId, fromAgentId: f.agentId }).where(eq(caseHandoffs.id, f.handoffId));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, sourceRunId));
      const at = new Date(Date.now() + 61_000);
      restartedDb = createDb(temporary.connectionString);
      await caseHandoffDeliveryService(restartedDb, { heartbeat: heartbeatService(restartedDb), now: () => at }).sweepPending();
      expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]?.state).toBe("awaiting_release");
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(0);
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;

      const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "execution_reconciliation", cause: "uncertain_provider_action", fingerprint: randomUUID(),
        nextAction: "Confirm workspace settlement", status: "active" }).returning();
      expect(await isCaseHandoffSourceReleased(restartedDb, { runId: sourceRunId, issueId: f.issueId })).toBe(false);
      await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issueRecoveryActions.id, hold.id));
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, sourceRunId));
      expect(await isCaseHandoffSourceReleased(restartedDb, { runId: sourceRunId, issueId: f.issueId })).toBe(false);
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, sourceRunId));
      expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, sourceRunId),
        eq(heartbeatRunEvents.eventType, "legacy.case_handoff_cleanup_verified")))).toHaveLength(0);

      await caseHandoffDeliveryService(restartedDb, { heartbeat: heartbeatService(restartedDb),
        now: () => new Date(at.getTime() + 61_000) }).sweepPending();
      const [afterRestart] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId));
      expect(afterRestart?.state, afterRestart?.lastError ?? undefined).toBe("delivered");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId))).toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId)))[0]?.resultJson)
        .toHaveProperty("caseHandoffExecutionReleased");
    } finally {
      try { process.kill(-processId, "SIGTERM"); } catch { /* already stopped */ }
      if (scratch) await rm(scratch.dir, { recursive: true, force: true });
      await restartedDb?.$client.end();
    }
  });
  it("admits an authenticated new phase after two case-only runs without treating its agent comment as an idle re-wake", async () => {
    const f = await fixture();
    for (const age of [20_000, 10_000]) await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", startedAt: new Date(Date.now() - age - 5_000), finishedAt: new Date(Date.now() - age),
      responsibleUserId: f.userId, contextSnapshot: { issueId: f.issueId } });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorAgentId: f.agentId, body: "Proceed to the next explicitly requested case phase" }).returning();
    await db.update(caseHandoffs).set({ actorType: "agent", actorId: f.agentId, fromAgentId: f.agentId, commentId: comment.id })
      .where(eq(caseHandoffs.id, f.handoffId));
    const run = await heartbeatService(db).wakeup(f.agentId, { ...f.options, requestedByActorType: "agent", requestedByActorId: f.agentId,
      payload: { ...f.options.payload, commentId: comment.id }, contextSnapshot: { ...f.options.contextSnapshot, wakeCommentId: comment.id } });
    expect(run).toMatchObject({ status: "queued", wakeupRequestId: f.wakeupRequestId });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId)))[0])
      .toMatchObject({ reason: "case_handoff", status: "queued" });
  });
  it("holds an accepted queued receipt while Cases is disabled, then cancels it if the ledger was cancelled", async () => {
    const f = await fixture(), heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(f.agentId, f.options);
    expect(queued?.status).toBe("queued");
    runningProcesses.delete(f.occupyingRunId); heldRuns.delete(f.occupyingRunId);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.occupyingRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await instanceSettingsService(db).updateExperimental({ enableCases: false });
    await heartbeat.resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
    await db.update(caseHandoffs).set({ state: "cancelled", cancelledAt: new Date() }).where(eq(caseHandoffs.id, f.handoffId));
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    await heartbeatService(db).resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0]).toMatchObject({ status: "cancelled", startedAt: null,
      errorCode: "case_handoff_superseded" });
  });
  it("an explicit Stop after source termination cancels the pending successor and records history", async () => {
    const f = await fixture(), sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId } });
    await db.update(caseHandoffs).set({ sourceRunId, state: "awaiting_release" }).where(eq(caseHandoffs.id, f.handoffId));
    await heartbeatService(db).cancelRun(sourceRunId, "Cancelled by a board operator", { resultJson: { cancelledByActorType: "user", cancelledByUserId: f.userId } });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]?.state).toBe("cancelled");
    expect(await db.select().from(caseEvents).where(and(eq(caseEvents.caseId, f.caseId), eq(caseEvents.kind, "handoff_cancelled")))).toHaveLength(1);
  });
  it("releases a paused source that was queued but never acquired execution", async () => {
    const f = await fixture(), sourceRunId = randomUUID();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
      status: "queued", contextSnapshot: { issueId: f.issueId }, responsibleUserId: f.userId });
    await db.update(issues).set({ executionRunId: sourceRunId }).where(eq(issues.id, f.issueId));
    await db.update(caseHandoffs).set({ sourceRunId, state: "awaiting_release", createdAt: new Date(Date.now() - 31_000),
      nextAttemptAt: new Date(Date.now() + 60_000) }).where(eq(caseHandoffs.id, f.handoffId));
    await heartbeatService(db).requestCaseHandoffYield({ runId: sourceRunId, issueId: f.issueId, handoffId: f.handoffId });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
    expect(source).toMatchObject({ status: "cancelled", startedAt: null, runtimeModeResolvedAt: null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        caseHandoffExecutionReleased: { runId: sourceRunId, issueId: f.issueId } } });
    expect(await isCaseHandoffSourceReleased(db, { runId: sourceRunId, issueId: f.issueId })).toBe(true);
    const [handoff] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId));
    expect(handoff.state).toBe("awaiting_release");
    expect(handoff.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
  it("does not launch an old same-agent receipt after a later phase without an assignment version change", async () => {
    const f = await fixture(), heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(f.agentId, f.options);
    await db.update(caseHandoffs).set({ state: "delivered" }).where(eq(caseHandoffs.id, f.handoffId));
    await db.update(cases).set({ handoffVersion: 2, phase: "verification" }).where(eq(cases.id, f.caseId));
    await db.insert(caseHandoffs).values({ companyId: f.companyId, caseId: f.caseId, issueId: f.issueId,
      version: 2, toAgentId: f.agentId, phase: "verification", instructions: "Verify the change", actorType: "user", actorId: f.userId,
      wakeupRequestId: randomUUID(), idempotencyKey: "second-phase", inputFingerprint: "second", state: "delivered",
      expectedIssueStatusVersion: 0, appliedIssueStatusVersion: 0 });
    runningProcesses.delete(f.occupyingRunId); heldRuns.delete(f.occupyingRunId);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.occupyingRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    await heartbeat.resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0])
      .toMatchObject({ status: "cancelled", startedAt: null, errorCode: "case_handoff_superseded" });
  });
});
