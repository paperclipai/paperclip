import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, completionContracts, createDb, heartbeatRuns, issueComments, issueRelations, issueThreadInteractions, issues, nativeRunFinalizations, nativeRunResults, pluginManagedResources, plugins, routineRuns, routines, statusDecisionEffects, statusDecisions, workAssessments } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { routineService } from "../routines.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";
import { INTERACTION_DELIVERY_DENIED } from "../agent-interaction-delivery.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_ROUTINE_STATUS_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping native routine status tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("native routine history status projection", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("native-routine-status-"); db = createDb(external ?? database.connectionString, { maxConnections: 6 });
    await db.insert(companies).values({ id: companyId, name: "Routine status fixture", issuePrefix: "NRS" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Routine worker", adapterType: "paperclip_runner", status: "running" });
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function seed(mode = "matching") {
    let issueId: string = randomUUID(), invocationId: string = randomUUID();
    const runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    const [routine] = await db.insert(routines).values({ companyId, title: "Daily summary", assigneeAgentId: agentId }).returning();
    const otherCompanyId = randomUUID();
    if (mode === "foreign-company") await db.insert(companies).values({ id: otherCompanyId, name: "Other fixture", issuePrefix: `X${otherCompanyId.slice(0, 5)}` });
    if (mode === "custom-origin") {
      const pluginKey = `paperclip.routine-status-${randomUUID()}`, originId = `operation:${randomUUID()}`;
      const [plugin] = await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0",
        manifestJson: { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Routine fixture", description: "Routine fixture",
          author: "Paperclip", categories: ["automation"], capabilities: ["routines.managed"], entrypoints: { worker: "./worker.js" } } }).returning();
      await db.insert(pluginManagedResources).values({ companyId, pluginId: plugin!.id, pluginKey, resourceKind: "routine", resourceKey: "summary",
        resourceId: routine!.id, defaultsJson: { issueTemplate: { originId } } });
      const invocation = await routineService(db, { heartbeat: { wakeup: async () => undefined } }).runRoutine(routine!.id, { source: "manual", idempotencyKey: randomUUID() });
      invocationId = invocation.id; issueId = invocation.linkedIssueId!;
      const [created] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(created).toMatchObject({ originKind: "routine_execution", originId, originRunId: invocationId });
      expect(created.originId).not.toBe(routine!.id);
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    } else {
      await db.insert(issues).values({ id: issueId, companyId, title: "Summary execution", status: "in_progress", workMode: "standard", assigneeAgentId: agentId,
        originKind: mode === "ordinary" ? "manual" : "routine_execution", originId: routine!.id, originRunId: mode === "wrong-invocation" ? randomUUID() : invocationId });
      await db.insert(routineRuns).values({ id: invocationId, companyId: mode === "foreign-company" ? otherCompanyId : companyId,
        routineId: routine!.id, linkedIssueId: mode === "wrong-issue" ? null : issueId, source: "manual", status: "issue_created", triggerPayload: { retainedInput: "Launch" } });
    }
    const [priorIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "routine-status-test", risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", objective: "Save summary", criteria: [] }, canonicalSha256: `contract-${contractId}`, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      completionContractId: contractId, completionContractSha256: `contract-${contractId}`, contextSnapshot: { issueId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: `fp-${resultId}`, schemaStatus: "accepted", resultJson: {}, canonicalSha256: `sha-${resultId}` });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId, contractId, resultId, triggerKind: "native_result",
      triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: priorIssue.statusVersion, policyVersion: "routine-status-test", assessmentJson: {}, inputDigest: `assessment-${assessmentId}` });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "arbitrating", resultId });
    return { issueId, invocationId, runId, assessmentId, priorStatusVersion: priorIssue.statusVersion, priorDecisionId: priorIssue.lastStatusDecisionId };
  }
  async function commit(f: Awaited<ReturnType<typeof seed>>, status: "done" | "blocked" | "cancelled" | "in_progress", executor: Db = db) {
    const decision: NativeStatusDecision = { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: status, toStatus: status,
      reasonCode: "routine_status_test", unblockDescriptor: null, effects: [] };
    return commitNativeStatusDecision({ db: executor, companyId, issueId: f.issueId, runId: f.runId, assessmentId: f.assessmentId,
      priorStatus: "in_progress", priorStatusVersion: f.priorStatusVersion, priorDecisionId: f.priorDecisionId, decision });
  }
  it.each(["done", "blocked", "cancelled", "in_progress"] as const)("projects real %s task status into the exact routine invocation", async status => {
    const f = await seed(); const first = await commit(f, status);
    const [saved] = await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId));
    expect(saved).toMatchObject({ linkedIssueId: f.issueId, status: status === "done" ? "completed" : status === "in_progress" ? "issue_created" : "failed", triggerPayload: expect.objectContaining({ retainedInput: "Launch" }) });
    expect(saved.completedAt !== null).toBe(status !== "in_progress");
    const replay = await commit(f, status); expect(replay.replayed).toBe(true); expect(replay.decision.id).toBe(first.decision.id);
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId)))[0]).toEqual(saved);
  });
  it("retains the native decision author when requesting a protected agent reviewer", async () => {
    const f = await seed(), reviewer = randomUUID();
    await db.insert(agents).values({ id: reviewer, companyId, name: "Protected reviewer", adapterType: "process", status: "active",
      permissions: { interactions: { canReceiveAssignmentsFromAgents: false } } });
    const requestReview = () => commitNativeStatusDecision({ db, companyId, issueId: f.issueId, runId: f.runId, assessmentId: f.assessmentId,
      priorStatus: "in_progress", priorStatusVersion: f.priorStatusVersion, priorDecisionId: f.priorDecisionId,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "preserve", toStatus: "in_progress",
        reasonCode: "review_requested", unblockDescriptor: null, effects: [{ kind: "bind_reviewer", ownerAgentId: reviewer,
          ownerUserId: null, prompt: "Review this work" }] },
    });
    await expect(requestReview()).rejects.toMatchObject({ status: 403, details: expect.objectContaining({ actorAgentId: agentId,
      permission: "canReceiveAssignmentsFromAgents" }) });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, reviewer))).toEqual([]);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, f.issueId))).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", failureCode: "agent_interaction_denied", nextAttemptAt: null });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, reviewer));
    await expect(requestReview()).rejects.toMatchObject({ status: 403,
      details: expect.objectContaining({ permission: "canReceiveAssignmentsFromAgents" }) });
  });
  it.each([false, true])("commits child completion while permanently refusing its protected parent report (dependency: %s)", async dependency => {
    const f = await seed(), parentId = randomUUID(), parentAgentId = randomUUID();
    const report = "PRIVATE_REPORT_TEXT: agent-authored completion instructions";
    await db.insert(agents).values({ id: parentAgentId, companyId, name: "Protected parent", adapterType: "process", status: "active",
      permissions: { interactions: { canReceiveCommentsFromAgents: false } } });
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent task", status: dependency ? "blocked" : "in_progress", assigneeAgentId: parentAgentId });
    await db.update(issues).set({ parentId }).where(eq(issues.id, f.issueId));
    await db.update(nativeRunResults).set({ resultJson: { result: { summary: report } } }).where(eq(nativeRunResults.runId, f.runId));
    if (dependency) await db.insert(issueRelations).values({ companyId, issueId: f.issueId, relatedIssueId: parentId, type: "blocks" });

    const completed = await commit(f, "done");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId)))[0].status).toBe("completed");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "committed", failureCode: null, nextAttemptAt: null });
    expect((await db.select().from(issues).where(eq(issues.id, parentId)))[0].status).toBe(dependency ? "blocked" : "in_progress");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, parentId))).toEqual([]);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, parentAgentId)).orderBy(agentWakeupRequests.id);
    const reportWake = wakes.find(wake => wake.reason === "issue_children_completed");
    expect(reportWake).toMatchObject({ status: "skipped", error: INTERACTION_DELIVERY_DENIED, finishedAt: expect.any(Date), runId: null,
      payload: { interactionOrigin: { actorType: "agent", actorId: agentId, operation: "comment" },
        interactionPermissionDenials: { assignment: { permission: "canReceiveCommentsFromAgents", targetAgentId: parentAgentId } } } });
    expect(JSON.stringify(wakes)).not.toContain(report);
    expect(wakes).toHaveLength(dependency ? 2 : 1);
    const dependencyWake = wakes.find(wake => wake.reason === "issue_blockers_resolved");
    if (dependency) expect(dependencyWake).toMatchObject({ status: "queued", requestedByActorType: "system", error: null,
      payload: { resolvedBlockerIssueId: f.issueId, blockerIssueIds: [f.issueId], interactionOrigin: { actorType: "system" } } });

    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, completed.decision.id));
    const reportEffect = effects.find(effect => effect.targetId === reportWake!.id);
    expect(reportEffect).toMatchObject({ deliveryState: "skipped", lastError: INTERACTION_DELIVERY_DENIED, deliveredAt: null, nextAttemptAt: null });
    expect(JSON.stringify(reportEffect)).not.toContain(report);
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, parentAgentId));
    expect((await commit(f, "done")).replayed).toBe(true);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, parentAgentId)).orderBy(agentWakeupRequests.id)).toEqual(wakes);
  });
  it.each(["ordinary", "wrong-invocation", "wrong-issue", "foreign-company"])("does not settle an invocation with %s custody", async mode => {
    const f = await seed(mode); const [before] = await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId));
    await commit(f, "done");
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId)))[0]).toEqual(before);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
  });
  it("settles a publicly dispatched plugin-managed invocation with its supported custom origin", async () => {
    const f = await seed("custom-origin"); await commit(f, "done");
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId)))[0]).toMatchObject({ linkedIssueId: f.issueId, status: "completed", completedAt: expect.any(Date) });
  });
  it("rolls back the task and routine projection together", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => { await commit(f, "done", tx as unknown as Db);
      expect((await tx.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId)))[0].status).toBe("completed");
      throw new Error("rollback fixture"); })).rejects.toThrow("rollback fixture");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId)))[0].status).toBe("issue_created");
  });
});
