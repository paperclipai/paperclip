import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, statusDecisions,
  statusDecisionEffects,
} from "@paperclipai/db";
import type { PrpStructuredRunResult, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";

// This is a real PostgreSQL finalization test. Run on normal server CI; it is not
// part of the separately configured local, provider-free resolver regression.
describe("textless OpenCode durable finalization", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-textless-completion-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Textless completion", issuePrefix: "TXT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed(status: "in_progress" | "in_review", kind: "textless" | "incomplete" | "review" = "textless") {
    const issueId = randomUUID(), runId = randomUUID(), contractId = randomUUID(), instanceId = randomUUID();
    const contractHash = `contract-${contractId}`;
    const revision = "textless-v1";
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve the saved task", description: "Saved work stays intact.",
      status, assigneeAgentId: agentId, workMode: "standard" });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: revision, risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision, objective: "Finish the task", criteria: [{ id: "objective", requirement: "Finish" }] },
      canonicalSha256: contractHash, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: instanceId, completionContractId: contractId,
      completionContractSha256: contractHash, contextSnapshot: { issueId }, runnerProfileJson: { nativeExecutionInput: {
        schema: "paperclip.native-execution-input.v1", binding: { companyId, issueId, runId, agentId, executionWorkspaceId: runId },
        task: { identifier: issueId, title: "Task", description: null, prompt: "Finish", workMode: "standard" },
        workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null }, interactionResponses: [], credentialBindings: [],
        provider: { kind: "opencode", model: "openrouter/test-model" },
        session: { driverKind: "opencode_server", normalizedSessionId: runId, protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        completionContract: { id: contractId, sha256: contractHash, schemaVersion: "paperclip.completion-contract.v1", contract: { revision, objective: "Finish", criteria: [{ id: "objective", requirement: "Finish" }] } },
      } } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId: runId,
      completionContractId: contractId, completionContractSha256: contractHash,
      sourceInstanceId: instanceId, controlPlaneSourceInstanceId: "textless-test" });
    await port.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: runId }, backendKind: "mock", sourceInstanceId: instanceId });
    const result: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1", reportedWorkDisposition: "needs_review",
      summary: "The OpenCode turn completed without a final response or an accepted work result. Task completion is unverified.",
      completionClaim: { contractRevision: revision, objectiveSatisfied: false,
        criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: [] }],
        remainingWork: [{ description: "Determine the work outcome.", blocksCompletion: true }] },
      evidence: [], verification: [], attentionRequests: kind === "review"
        ? [{ kind: "review", summary: "Review the delivered change.", ownerClass: "human" }] : [], artifacts: [],
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", provider: "opencode",
      turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "needs_review",
      ...(kind === "textless" ? { workOutcomeReason: "missing_semantic_result_and_assistant_text" } : {}) };
    await port.completeRun({ result, terminal, callerResultId: `${runId}:result` });
    return { issueId, runId, result, terminal };
  }

  it.each(["in_progress", "in_review"] as const)("preserves %s and saved work, records one terminal recovery, and replays without another executor", async status => {
    const fixture = await seed(status);
    const before = (await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    const accepted = (await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, fixture.runId)))[0]!;
    expect(accepted.resultJson).toMatchObject({ terminal: { provider: "opencode",
      workOutcomeReason: "missing_semantic_result_and_assistant_text" } });
    const wakesBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true }))
      .toMatchObject({ phase: "terminal_failure" });
    const issue = (await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!;
    expect(issue).toMatchObject({ status, assigneeAgentId: agentId, description: before.description,
      statusVersion: before.statusVersion, executionRunId: before.executionRunId, checkoutRunId: before.checkoutRunId });
    const run = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))[0]!;
    expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: "native_textless_completion_unresolved" });
    expect(run.finishedAt).not.toBeNull();
    expect(run.resultJson).toMatchObject({ finalizationPhase: "terminal_failure", failureCode: "native_textless_completion_unresolved", nextAttemptAt: null });
    const coordinator = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId)))[0]!;
    expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_textless_completion_unresolved", nextAttemptAt: null });
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, accepted.id)))[0]!.resultJson).toEqual(accepted.resultJson);
    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, coordinator.decisionId!));
    expect(effects).toEqual([expect.objectContaining({ effectKind: "record_finalization_error", deliveryState: "delivered" })]);
    const recovery = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
    expect(recovery).toEqual([expect.objectContaining({ cause: "native_textless_completion_unresolved", wakePolicy: null, status: "active" })]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual(wakesBefore);
    await expect(finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true }))
      .rejects.toThrow("native_finalization_terminal_failure");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual(wakesBefore);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId))).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toEqual(recovery);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, fixture.issueId))).toHaveLength(1);
  });

  it("commits the terminal run and recovery atomically before later projection, even if that caller stops", async () => {
    const fixture = await seed("in_progress");
    const transaction = db.transaction.bind(db);
    let stopped = false;
    let committedRun: typeof heartbeatRuns.$inferSelect | undefined;
    let committedCoordinator: typeof nativeRunFinalizations.$inferSelect | undefined;
    const intercept = (async (...args: Parameters<typeof db.transaction>) => {
      const value = await transaction(...args);
      if (!stopped && value && typeof value === "object" && "decision" in value &&
          (value as { decision: { runId: string } }).decision.runId === fixture.runId) {
        stopped = true;
        [committedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
        [committedCoordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
        throw new Error("caller_stopped_after_atomic_decision");
      }
      return value;
    }) as typeof db.transaction;
    const spy = vi.spyOn(db, "transaction").mockImplementation(intercept);
    try {
      expect(await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded" }))
        .toMatchObject({ phase: "terminal_failure" });
    } finally { spy.mockRestore(); }
    expect(stopped).toBe(true);
    expect(committedRun).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: "native_textless_completion_unresolved" });
    expect(committedRun!.finishedAt).not.toBeNull();
    expect(committedCoordinator).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    await expect(finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded" }))
      .rejects.toThrow("native_finalization_terminal_failure");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual(wakes);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, fixture.runId))).toHaveLength(1);
  });

  it("still materializes ordinary incomplete-result recovery", async () => {
    const fixture = await seed("in_progress", "incomplete");
    const finalized = await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, finalized.decisionId!));
    expect(effects).toEqual(expect.arrayContaining([expect.objectContaining({ effectKind: "enqueue_continuation" })]));
  });

  it("still materializes a genuine explicit human review", async () => {
    const fixture = await seed("in_progress", "review");
    const finalized = await finalizeNativeRun({ db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(finalized.phase).toBe("committed");
    expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!.status).toBe("in_review");
    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, finalized.decisionId!));
    expect(effects).toEqual(expect.arrayContaining([expect.objectContaining({ effectKind: "bind_reviewer" })]));
  });
});
