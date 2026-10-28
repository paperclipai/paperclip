import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, routineRuns, routines, workAssessments } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping native routine status tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("native routine history status projection", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-routine-status-"); db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Routine status fixture", issuePrefix: "NRS" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Routine worker", adapterType: "paperclip_runner", status: "running" });
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function seed(mode = "matching") {
    const issueId = randomUUID(), runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), invocationId = randomUUID();
    const [routine] = await db.insert(routines).values({ companyId, title: "Daily summary" }).returning();
    const otherCompanyId = randomUUID();
    if (mode === "foreign-company") await db.insert(companies).values({ id: otherCompanyId, name: "Other fixture", issuePrefix: `X${otherCompanyId.slice(0, 5)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Summary execution", status: "in_progress", workMode: "standard", assigneeAgentId: agentId,
      originKind: mode === "ordinary" ? "manual" : "routine_execution", originId: mode === "wrong-routine" ? randomUUID() : routine!.id, originRunId: invocationId });
    await db.insert(routineRuns).values({ id: invocationId, companyId: mode === "foreign-company" ? otherCompanyId : companyId,
      routineId: routine!.id, linkedIssueId: mode === "wrong-issue" ? null : issueId, source: "manual", status: "issue_created", triggerPayload: { retainedInput: "Launch" } });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "routine-status-test", risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", objective: "Save summary", criteria: [] }, canonicalSha256: `contract-${contractId}`, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      completionContractId: contractId, completionContractSha256: `contract-${contractId}`, contextSnapshot: { issueId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: `fp-${resultId}`, schemaStatus: "accepted", resultJson: {}, canonicalSha256: `sha-${resultId}` });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId, contractId, resultId, triggerKind: "native_result",
      triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "routine-status-test", assessmentJson: {}, inputDigest: `assessment-${assessmentId}` });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "arbitrating", resultId });
    return { issueId, invocationId, runId, assessmentId };
  }
  async function commit(f: Awaited<ReturnType<typeof seed>>, status: "done" | "blocked" | "cancelled" | "in_progress", executor: Db = db) {
    const decision: NativeStatusDecision = { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: status, toStatus: status,
      reasonCode: "routine_status_test", unblockDescriptor: null, effects: [] };
    return commitNativeStatusDecision({ db: executor, companyId, issueId: f.issueId, runId: f.runId, assessmentId: f.assessmentId,
      priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null, decision });
  }
  it.each(["done", "blocked", "cancelled", "in_progress"] as const)("projects real %s task status into the exact routine invocation", async status => {
    const f = await seed(); const first = await commit(f, status);
    const [saved] = await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId));
    expect(saved).toMatchObject({ linkedIssueId: f.issueId, status: status === "done" ? "completed" : status === "in_progress" ? "issue_created" : "failed", triggerPayload: expect.objectContaining({ retainedInput: "Launch" }) });
    expect(saved.completedAt !== null).toBe(status !== "in_progress");
    const replay = await commit(f, status); expect(replay.replayed).toBe(true); expect(replay.decision.id).toBe(first.decision.id);
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId)))[0]).toEqual(saved);
  });
  it.each(["ordinary", "wrong-routine", "wrong-issue", "foreign-company"])("does not settle an invocation with %s custody", async mode => {
    const f = await seed(mode); const [before] = await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId));
    await commit(f, "done");
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, f.invocationId)))[0]).toEqual(before);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
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
