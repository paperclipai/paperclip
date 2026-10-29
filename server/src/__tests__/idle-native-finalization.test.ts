import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, completionContracts, createDb, environments, environmentLeases, heartbeatRuns, issues, issueComments,
  nativeRunFinalizations, nativeRunResults, statusDecisionEffects, statusDecisions,
  workAssessments, workspaceOperations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import { beginIdleTrackedWork } from "../services/task-admission.js";
import { nativeResponsePresentationWork } from "../services/native-runtime/native-response-presentation-work.js";

const now = Date.UTC(2020, 0, 1);
const ownerId = "0e421722-e69c-45ca-ac42-80fbd0d66739";
const future = new Date("2099-01-01T00:00:00Z");
const none = { version: 1, backgroundWork: "none" };
const present = { version: 1, backgroundWork: "present" };
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping finalization idle-sleep Postgres tests: ${support.reason}`);

(support.supported ? describe : describe.skip)("committed native finalization idle safety", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("idle-native-finalization-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await database?.cleanup(); });

  const read = () => readIdleSleepSafety(db, () => ({
    ownerId, draining: true, startedAt: new Date(now - 1000), expiresAt: new Date(now + 60_000),
    activeRuns: 0, pendingWakes: 0,
  }), () => now, ownerId, async () => "none");

  async function seed(status = "succeeded") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID();
    const assessmentId = randomUUID(), decisionId = randomUUID();
    const operationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Finalization fixture", issuePrefix: "FIN" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Idle worker", adapterType: "process", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Completed task", status: "done" });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "fixture" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      completionContractId: contractId, runtimeMode: "native", nativePhase: "committed",
      status, finishedAt: new Date(now), resultJson: { finalizationPhase: "committed" },
      processPid: 123, processStartedAt: new Date(now - 1000) });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: resultId, schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: status } },
      canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId, contractId, resultId,
      triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress",
      priorStatusVersion: 0, policyVersion: "fixture", assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId, assessmentId,
      decisionVersion: 1, policyVersion: "fixture", fromStatus: "in_progress", toStatus: "done",
      reasonCode: "fixture", decisionJson: {}, decisionDigest: decisionId, applicationState: "applied", appliedAt: new Date(now) });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, resultId, assessmentId, decisionId,
      phase: "committed", controllerBootId: "historical-controller", controllerPid: 123 });
    await db.insert(workspaceOperations).values({ id: operationId, companyId, issueId, heartbeatRunId: runId,
      phase: "workspace_finalize", status: "succeeded", startedAt: new Date(now), finishedAt: new Date(now) });
    return { companyId, agentId, issueId, runId, resultId, assessmentId, decisionId, operationId };
  }

  it.each(["succeeded", "failed", "cancelled"])("permits a fully settled %s run and preserves its audit history", async status => {
    const f = await seed(status);
    const before = await db.select().from(nativeRunFinalizations);
    expect(await read()).toEqual(none);
    expect(await db.select().from(nativeRunFinalizations)).toEqual(before);
    expect(await db.select({ id: nativeRunResults.id }).from(nativeRunResults)).toEqual([{ id: f.resultId }]);
  });

  it.each(["observed", "result_accepted", "workspace_finalizing", "arbitrating", "retryable_failure", "terminal_failure", "unknown"])(
    "retains finalization phase %s", async phase => {
      const f = await seed();
      await db.update(nativeRunFinalizations).set({ phase }).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(await read()).toEqual(present);
    },
  );

  it.each([
    { leaseOwner: "still-owned" }, { leaseExpiresAt: future }, { nextAttemptAt: future },
    { controlDeadlineAt: future }, { recoveryState: "resuming_session" }, { recoveryRequestId: "pending-recovery" },
    { failureCode: "pending_cleanup" }, { failureDetail: { cleanupPending: true } },
    { decisionId: null }, { assessmentId: null, decisionId: null }, { resultId: null, assessmentId: null, decisionId: null },
  ])("retains unresolved finalization intent %j", async change => {
    const f = await seed();
    await db.update(nativeRunFinalizations).set(change).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await read()).toEqual(present);
  });

  it.each([
    { status: "running" }, { finishedAt: null }, { costAccountingPending: true }, { scheduledRetryAt: future },
    { nativePhase: "arbitrating" }, { runtimeMode: "legacy" }, { resultJson: {} },
    { resultJson: { finalizationPhase: "committed", nextAttemptAt: future.toISOString() } },
    { resultJson: { finalizationPhase: "committed", failureCode: "projection_pending" } },
    { resultJson: { finalizationPhase: "committed", originalFailureCode: "projection_pending" } },
  ])("retains an unfinished run projection %j", async change => {
    const f = await seed();
    await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, f.runId));
    expect(await read()).toEqual(present);
  });

  it.each([
    { schemaStatus: "rejected" }, { resultJson: {} },
    { resultJson: { terminal: { runTerminalState: "active" } } },
  ])("retains a missing or inconsistent accepted result %j", async change => {
    const f = await seed();
    await db.update(nativeRunResults).set(change).where(eq(nativeRunResults.id, f.resultId));
    expect(await read()).toEqual(present);
  });

  it.each([{ applicationState: "proposed" }, { appliedAt: null }])("retains an unapplied decision %j", async change => {
    const f = await seed();
    await db.update(statusDecisions).set(change).where(eq(statusDecisions.id, f.decisionId));
    expect(await read()).toEqual(present);
  });

  it.each([
    { deliveryState: "pending", deliveredAt: null }, { deliveryState: "failed", deliveredAt: null },
    { deliveryState: "unknown", deliveredAt: new Date(now) }, { deliveryState: "delivered", deliveredAt: null },
    { deliveryState: "delivered", deliveredAt: new Date(now), nextAttemptAt: future },
  ])("retains incomplete status effects %j", async change => {
    const f = await seed();
    await db.insert(statusDecisionEffects).values({ companyId: f.companyId, issueId: f.issueId,
      decisionId: f.decisionId, ordinal: 0, effectKind: "release_checkout", targetType: "issue",
      idempotencyKey: randomUUID(), payload: {}, ...change });
    expect(await read()).toEqual(present);
  });

  it("permits acknowledged effects without deleting their receipts", async () => {
    const f = await seed();
    await db.insert(statusDecisionEffects).values({ companyId: f.companyId, issueId: f.issueId,
      decisionId: f.decisionId, ordinal: 0, effectKind: "release_checkout", targetType: "issue",
      idempotencyKey: randomUUID(), payload: {}, deliveryState: "delivered", deliveredAt: new Date(now) });
    expect(await read()).toEqual(none);
    expect(await db.select({ state: statusDecisionEffects.deliveryState }).from(statusDecisionEffects))
      .toEqual([{ state: "delivered" }]);
  });

  it("retains an active provider allocation after the finalization commits", async () => {
    const f = await seed();
    const [environment] = await db.insert(environments).values({
      name: "Sandbox fixture", driver: "sandbox", config: {},
    }).returning();
    await db.insert(environmentLeases).values({ companyId: f.companyId,
      heartbeatRunId: f.runId, environmentId: environment.id, provider: "sandbox",
      providerLeaseId: "live-fixture", status: "active" });
    expect(await read()).toEqual(present);
  });

  it("retains live local work after the finalization commits", async () => {
    await seed();
    const finish = beginIdleTrackedWork();
    try {
      expect(await read()).toEqual({ version: 1, backgroundWork: "unknown" });
    } finally { finish(); }
    expect(await read()).toEqual(none);
  });

  it.each([
    { status: "failed" }, { status: "cancelled" }, { phase: "workspace_prepare" },
    { issueId: null }, { heartbeatRunId: null },
  ])("retains workspace repair without its owned successful receipt %j", async change => {
    const f = await seed();
    await db.update(workspaceOperations).set(change).where(eq(workspaceOperations.id, f.operationId));
    expect(await read()).toEqual(present);
  });

  it("retains a committed run with no workspace-finalization receipt", async () => {
    const f = await seed();
    await db.delete(workspaceOperations).where(eq(workspaceOperations.id, f.operationId));
    expect(await read()).toEqual(present);
  });

  async function seedPendingReply() {
    const f = await seed();
    await db.update(nativeRunResults).set({ resultJson: {
      result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Completed task" },
      terminal: { runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" },
    } }).where(eq(nativeRunResults.id, f.resultId));
    return f;
  }

  it("retains final-reply recovery between result commit and comment creation", async () => {
    const f = await seedPendingReply();
    expect(await nativeResponsePresentationWork(db).load()).toMatchObject([{ id: f.runId }]);
    expect(await read()).toEqual(present);
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorAgentId: f.agentId, createdByRunId: f.runId, body: "Final reply fixture" }).returning();
    await db.update(heartbeatRuns).set({ resultJson: { finalizationPhase: "committed",
      presentationDecision: { commentAction: "create", commentId: comment.id } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await nativeResponsePresentationWork(db).load()).toEqual([]);
    expect(await read()).toEqual(none);
    expect(await db.select({ id: issueComments.id }).from(issueComments)).toEqual([{ id: comment.id }]);
  });

  it.each([true, "true", false])("respects the exact skipIssueComment contract %j", async skipIssueComment => {
    const f = await seedPendingReply();
    await db.update(heartbeatRuns).set({ contextSnapshot: { skipIssueComment } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await read()).toEqual(skipIssueComment === true ? none : present);
  });

  it.each(["reuse", "none"])("preserves an explicit final-reply presentation choice %s", async commentAction => {
    const f = await seedPendingReply();
    await db.update(heartbeatRuns).set({ resultJson: { finalizationPhase: "committed",
      presentationDecision: { commentAction } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await read()).toEqual(none);
  });
});
