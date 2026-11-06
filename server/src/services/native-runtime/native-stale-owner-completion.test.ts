import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issueWorkProducts, issues, nativeRunFinalizations,
  nativeRunResults, statusDecisions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, supersedeStaleOwnerCompletion, type NativeStatusDecision } from "./status-arbiter.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_STALE_OWNER_TEST_DATABASE_URL");
describe("stale owner completion policy", () => {
  const done: NativeStatusDecision = { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done",
    reasonCode: "completion_claim_policy_accepted", unblockDescriptor: null, effects: [{ kind: "release_checkout" }] };
  const owner = { status: "in_progress", assigneeAgentId: "agent-a", assigneeUserId: null };

  it("keeps the current owner's done decision", () => {
    expect(supersedeStaleOwnerCompletion(done, owner, "agent-a")).toBe(done);
  });
  it.each([
    ["another agent", { ...owner, assigneeAgentId: "agent-b" }],
    ["a board user", { ...owner, assigneeAgentId: null, assigneeUserId: "user-1" }],
    ["nobody", { ...owner, assigneeAgentId: null }],
  ])("preserves status when the task now belongs to %s", (_label, issue) => {
    expect(supersedeStaleOwnerCompletion(done, issue, "agent-a")).toEqual({ ...done, statusAction: "preserve",
      toStatus: "in_progress", reasonCode: "completion_owner_superseded", effects: [] });
  });
  it("leaves non-terminal decisions to their existing owner checks", () => {
    const blocked: NativeStatusDecision = { ...done, statusAction: "blocked", toStatus: "blocked", reasonCode: "x" };
    expect(supersedeStaleOwnerCompletion(blocked, { ...owner, assigneeAgentId: "agent-b" }, "agent-a")).toBe(blocked);
  });
});

const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("native completion after reassignment", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("native-stale-owner-");
    db = createDb(external ?? database!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  /**
   * A task whose original owner reported done in an accepted result. With
   * pendingEvidence, the server arbiter waits for review of a work product.
   */
  async function acceptedDoneResult(options: { pendingEvidence?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), successorId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stale owner fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Original owner", adapterType: "paperclip_runner" },
      { id: successorId, companyId, name: "New owner", adapterType: "paperclip_runner" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "FizzBuzz variants", status: "in_progress",
      assigneeAgentId: agentId, description: "Write fizzbuzz with tests and mark done." });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: options.pendingEvidence ? "standard" : "low",
      completionAuthority: options.pendingEvidence ? "server_arbiter" : "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Write fizzbuzz", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: `stale-owner-${issueId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId, source: "issue.assigned" } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const workProductId = randomUUID();
    if (options.pendingEvidence) await db.insert(issueWorkProducts).values({ id: workProductId, companyId, issueId,
      type: "artifact", provider: "paperclip", title: "fizzbuzz.py", status: "ready_for_review", reviewState: "none" });
    const evidenceRef = options.pendingEvidence ? `work_product:${workProductId}` : `task:${issueId}`;
    const port = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: ["objective"] });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
      summary: "Implemented fizzbuzz; 6 passed.", completionClaim: { contractRevision: "test", objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [evidenceRef] }], remainingWork: [] },
      evidence: [{ ref: evidenceRef }],
      verification: [{ commandOrCheck: "pytest -q", status: "passed", detail: "6 passed", artifactRef: evidenceRef }], attentionRequests: [], artifacts: [] },
    terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed",
      reportedWorkDisposition: "done" }, turnId: "fizzbuzz-turn" });
    return { companyId, agentId, successorId, issueId, runId, workProductId };
  }

  /** The board's reassignment: new owner, and the old run loses execution. */
  async function reassign(f: Awaited<ReturnType<typeof acceptedDoneResult>>) {
    await db.update(issues).set({ assigneeAgentId: f.successorId, executionRunId: null, checkoutRunId: null })
      .where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.runId));
  }

  const issue = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
  const decision = async (runId: string) => {
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    const [row] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, coordinator.decisionId!));
    return { coordinator, row };
  };

  it("closes the task when the reporting run still owns it", async () => {
    const f = await acceptedDoneResult();
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    expect(await issue(f.issueId)).toMatchObject({ status: "done", assigneeAgentId: f.agentId });
    expect((await decision(f.runId)).row.reasonCode).toBe("completion_claim_policy_accepted");
  });

  it("does not let a reassigned-away run's done result close the new owner's task", async () => {
    const f = await acceptedDoneResult();
    const [acceptedBefore] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    await reassign(f);

    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });

    const current = await issue(f.issueId);
    expect(current).toMatchObject({ status: "in_progress", assigneeAgentId: f.successorId });
    const { coordinator, row } = await decision(f.runId);
    expect(coordinator.phase).toBe("committed");
    expect(row).toMatchObject({ toStatus: "in_progress", reasonCode: "completion_owner_superseded" });
    // The original owner's accepted result is kept as history, unchanged.
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId)))[0]).toEqual(acceptedBefore);
  });

  it("does not close the task when reassignment lands after arbitration but before the status commit", async () => {
    const f = await acceptedDoneResult();
    let reassigned = false;
    // Reassign at the last finalizer write before the status transaction.
    const racing = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "update") return typeof value === "function" ? value.bind(target) : value;
        return (table: unknown) => {
          const builder = target.update(table as typeof nativeRunFinalizations);
          if (table !== nativeRunFinalizations || reassigned) return builder;
          const set = builder.set.bind(builder);
          return Object.assign(builder, { set: (values: Record<string, unknown>) => {
            const next = set(values as never);
            if (values.phase !== "arbitrating" || !("assessmentId" in values)) return next;
            const where = next.where.bind(next);
            return Object.assign(next, { where: (...args: Parameters<typeof where>) => {
              const query = where(...args);
              return { then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
                query.then(async (result) => { reassigned = true; await reassign(f); return result; }).then(resolve, reject) };
            } });
          } });
        };
      },
    }) as Db;

    await finalizeNativeRun({ db: racing, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });

    expect(reassigned).toBe(true);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_progress", assigneeAgentId: f.successorId });
    expect((await decision(f.runId)).row).toMatchObject({ reasonCode: "completion_owner_superseded" });
  });
  async function approveEvidenceLater(f: Awaited<ReturnType<typeof acceptedDoneResult>>) {
    await db.update(issueWorkProducts).set({ reviewState: "approved", updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(issueWorkProducts.id, f.workProductId));
  }

  it("closes the owner's task when later evidence satisfies the contract", async () => {
    const f = await acceptedDoneResult({ pendingEvidence: true });
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    expect((await issue(f.issueId)).status).not.toBe("done");
    await approveEvidenceLater(f);
    await reconcileNativeFinalizations(db, [f.runId]);
    expect(await issue(f.issueId)).toMatchObject({ status: "done", assigneeAgentId: f.agentId });
    expect((await decision(f.runId)).row.reasonCode).toBe("decision_superseded_by_new_evidence");
  });

  it("does not let later evidence from a reassigned-away run close the new owner's task", async () => {
    const f = await acceptedDoneResult({ pendingEvidence: true });
    await reassign(f);
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    const [acceptedBefore] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    await approveEvidenceLater(f);
    await reconcileNativeFinalizations(db, [f.runId]);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_progress", assigneeAgentId: f.successorId });
    expect((await decision(f.runId)).row).toMatchObject({ toStatus: "in_progress", reasonCode: "completion_owner_superseded" });
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId)))[0]).toEqual(acceptedBefore);
  });
});
