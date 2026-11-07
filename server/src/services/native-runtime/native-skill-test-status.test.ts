import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, companySkills, companySkillVersions, companySkillTestRuns,
  completionContracts, createDb, documents, heartbeatRuns, issueDocuments, issues,
  nativeRunFinalizations, nativeRunResults, workAssessments, type Db,
} from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";

describe.skipIf(!recoveryPostgresSupport.supported)("native Studio status publication", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => {
    database = await startRecoveryPostgres("native-skill-test-status-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const skillId = randomUUID(), versionId = randomUUID(), testId = randomUUID(), documentId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio status", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Tester", adapterType: "paperclip_runner" });
    await db.insert(companySkills).values({ id: skillId, companyId, key: "company/test", slug: "test", name: "Test", markdown: "# Test", sourceType: "managed" });
    await db.insert(companySkillVersions).values({ id: versionId, companyId, companySkillId: skillId, revisionNumber: 1 });
    // Task mode can change after admission; the saved Studio obligation survives.
    await db.insert(issues).values({ id: issueId, companyId, title: "Studio output", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(companySkillTestRuns).values({ id: testId, companyId, skillId, skillVersionId: versionId, agentId, issueId, inputSnapshot: "Execute the skill" });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Verified the selected immutable bytes." });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "output" });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "studio-test", risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", criteria: [] }, canonicalSha256: randomUUID(), createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      completionContractId: contractId, contextSnapshot: { issueId, paperclipAgentJwtScope: { kind: "skill_test", issueId } } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId, contractId, resultId, triggerKind: "native_result",
      triggerActorCompanyId: companyId, priorIssueStatus: task.status, priorStatusVersion: task.statusVersion,
      policyVersion: "studio-test", assessmentJson: {}, inputDigest: randomUUID() });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "arbitrating", resultId });
    const read = async () => (await db.select().from(companySkillTestRuns).where(eq(companySkillTestRuns.id, testId)))[0]!;
    const audit = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "company.skill_test_run_completed")));
    const commit = (status: "done" | "cancelled" | "blocked", executor: Db = db) => commitNativeStatusDecision({ db: executor,
      companyId, issueId, runId, assessmentId, priorStatus: task.status, priorStatusVersion: task.statusVersion, priorDecisionId: task.lastStatusDecisionId,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: status, toStatus: status,
        reasonCode: "studio_status_test", unblockDescriptor: null, effects: [] } });
    return { companyId, issueId, testId, documentId, read, audit, commit };
  }

  it.each(["done", "cancelled"] as const)("atomically publishes %s and its output once across replay", async status => {
    const f = await seed();
    await f.commit(status);
    const saved = await f.read();
    expect(saved).toMatchObject({ status: status === "done" ? "succeeded" : "cancelled", outputSnapshot: "Verified the selected immutable bytes." });
    expect(await f.audit()).toHaveLength(1);
    await db.update(documents).set({ latestBody: "Changed after completion" }).where(eq(documents.id, f.documentId));
    const reopened = createDb(database.connectionString);
    try { expect((await f.commit(status, reopened)).replayed).toBe(true); }
    finally { await reopened.$client.end(); }
    expect(await f.read()).toEqual(saved);
    expect(await f.audit()).toHaveLength(1);
  });

  it("rolls back task, Studio output, and audit together", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => {
      await f.commit("done", tx as unknown as Db);
      expect((await tx.select().from(companySkillTestRuns).where(eq(companySkillTestRuns.id, f.testId)))[0].status).toBe("succeeded");
      throw new Error("rollback Studio fixture");
    })).rejects.toThrow("rollback Studio fixture");
    expect(await f.read()).toMatchObject({ status: "queued", outputSnapshot: "" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
    expect(await f.audit()).toHaveLength(0);
    await f.commit("done");
    expect((await f.read()).status).toBe("succeeded");
  });

  it("keeps blocked tests pending and does not revive superseded tests", async () => {
    const blocked = await seed();
    await blocked.commit("blocked");
    expect((await blocked.read()).status).toBe("queued");
    expect(await blocked.audit()).toHaveLength(0);
    const superseded = await seed();
    await db.update(companySkillTestRuns).set({ supersededAt: new Date() }).where(eq(companySkillTestRuns.id, superseded.testId));
    await superseded.commit("done");
    expect((await superseded.read()).status).toBe("queued");
    expect(await superseded.audit()).toHaveLength(0);
  });
});
