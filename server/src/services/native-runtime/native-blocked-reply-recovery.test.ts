import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues,
  nativeRunFinalizations, statusDecisions, workAssessments, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { finalizeNativeRun, recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_BLOCKED_REPLY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("blocked task reply after a retried workspace copy-back", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("native-blocked-reply-");
    db = createDb(external ?? database!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const summary = "Blocked: the deploy key for the staging bucket was revoked. Please re-issue it so I can finish the upload.";
  const finalReply = "I could not finish the upload because the staging deploy key was revoked. Please re-issue it.";

  async function blockedRun(options: { finalReply?: boolean; source?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocked reply fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Uploader", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Upload the build", status: "in_progress", assigneeAgentId: agentId });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Upload the build", criteria: [] },
      canonicalSha256: `blocked-${runId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId, source: options.source ?? "assignment" } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const port = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: [] });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "blocked", summary,
      blocker: { reasonCode: "access", owner: { kind: "user", name: "Board operator" }, unblockAction: "Re-issue the deploy key",
        scope: "task_wide" },
      completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed",
        reportedWorkDisposition: "blocked" },
      turnId: "upload-turn" });
    if (options.finalReply) await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 90, eventType: "item.completed",
      payload: { prpEvent: { runId, normalizedSessionId: sessionId, turnId: "upload-turn", sourceEventId: "upload-final",
        payload: { kind: "agentMessage", channel: "final", providerPhase: "final", text: finalReply } } } });
    await recordNativeFinalizationFailure({ db, runId, error: new Error("native_workspace_sync_out_failed"),
      failureScope: "workspace", projectRunStatus: true });
    return { companyId, agentId, issueId, runId };
  }
  const retryCopyBack = (runId: string, options: { skipNativeResponsePresentation?: boolean } = {}) =>
    finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true, preserveProviderAttempt: true,
      ...options });
  const comments = (issueId: string) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  const run = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
  const issue = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];

  it("posts the blocker summary once when the retried copy-back commits the blocked status", async () => {
    const f = await blockedRun();
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase)
      .toBe("retryable_failure");
    await retryCopyBack(f.runId);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase)
      .toBe("committed");
    expect((await issue(f.issueId)).status).toBe("blocked");
    expect((await run(f.runId)).status).toBe("succeeded");

    expect(await comments(f.issueId)).toEqual([expect.objectContaining({ body: summary, authorAgentId: f.agentId,
      createdByRunId: f.runId })]);
    expect(((await run(f.runId)).resultJson as Record<string, any>).presentationDecision).toMatchObject({
      commentAction: "create", chosenSource: "semantic_result_summary", commentId: expect.any(String) });

    expect(await nativeResponsePresentationWork(db).load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
    await retryCopyBack(f.runId);
    expect(await comments(f.issueId)).toHaveLength(1);
  });

  it("presents the agent's final reply from the background worker exactly once", async () => {
    const f = await blockedRun({ finalReply: true });
    await retryCopyBack(f.runId, { skipNativeResponsePresentation: true });
    expect((await issue(f.issueId)).status).toBe("blocked");
    expect(await comments(f.issueId)).toEqual([]);

    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load({ companyId: f.companyId, issueId: f.issueId });
    expect(entry).toMatchObject({ id: f.runId });
    await expect(work.check(entry)).resolves.toBeNull();
    expect(await comments(f.issueId)).toEqual([expect.objectContaining({ body: finalReply, createdByRunId: f.runId })]);
    expect(await work.load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
    await expect(work.check(entry)).resolves.toBeNull();
    expect(await comments(f.issueId)).toHaveLength(1);
  });

  it("presents a channel task's blocker from the worker instead of recording a publication failure", async () => {
    const f = await blockedRun({ source: "chat:slack" });
    await retryCopyBack(f.runId, { skipNativeResponsePresentation: true });
    expect((await issue(f.issueId)).status).toBe("blocked");

    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load({ companyId: f.companyId, issueId: f.issueId });
    expect(entry).toMatchObject({ id: f.runId });
    await expect(work.check(entry)).resolves.toBeNull();
    expect(await comments(f.issueId)).toEqual([expect.objectContaining({ body: summary, createdByRunId: f.runId })]);
    const result = (await run(f.runId)).resultJson as Record<string, any>;
    expect(result.presentationDecision).toMatchObject({ commentId: expect.any(String) });
    expect(result.responsePublication?.state).not.toBe("failed");
    expect(await work.load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
    await retryCopyBack(f.runId);
    expect(await comments(f.issueId)).toHaveLength(1);
  });

  it("does not present a stale blocker after a later status decision or once the task moved on", async () => {
    const f = await blockedRun();
    await retryCopyBack(f.runId, { skipNativeResponsePresentation: true });
    const work = nativeResponsePresentationWork(db);
    expect(await work.load({ companyId: f.companyId, issueId: f.issueId })).toHaveLength(1);

    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    const [assessment] = await db.select().from(workAssessments).where(eq(workAssessments.id, decision.assessmentId));
    const [laterAssessment] = await db.insert(workAssessments).values({ ...assessment, id: randomUUID(),
      inputDigest: `${assessment.inputDigest}-later` }).returning();
    const [later] = await db.insert(statusDecisions).values({ ...decision, id: randomUUID(), assessmentId: laterAssessment.id,
      decisionVersion: decision.decisionVersion + 1, decisionDigest: `${decision.decisionDigest}-later` }).returning();
    expect(await work.load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
    await retryCopyBack(f.runId);
    expect(await comments(f.issueId)).toEqual([]);

    await db.delete(statusDecisions).where(eq(statusDecisions.id, later.id));
    await db.delete(workAssessments).where(eq(workAssessments.id, laterAssessment.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    expect(await work.load({ companyId: f.companyId, issueId: f.issueId })).toEqual([]);
    await retryCopyBack(f.runId);
    expect(await comments(f.issueId)).toEqual([]);
  });
});
