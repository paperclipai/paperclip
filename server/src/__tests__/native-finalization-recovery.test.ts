import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workAssessments,
  workspaceOperations,
} from "@paperclipai/db";
import {
  CONTROL_PLANE_CONFORMANCE_OPEN,
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";

describe("P6-16/P6-25/P6-28 native finalization recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = "72000000-0000-4000-8000-000000000001";
  const agentId = "72000000-0000-4000-8000-000000000002";
  const issueId = "72000000-0000-4000-8000-000000000003";
  const contractId = "72000000-0000-4000-8000-000000000004";
  const runId = "72000000-0000-4000-8000-000000000005";
  const staleIssueId = "72000000-0000-4000-8000-000000000013";
  const staleContractId = "72000000-0000-4000-8000-000000000014";
  const staleRunId = "72000000-0000-4000-8000-000000000015";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-recovery-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native recovery", issuePrefix: "NRC" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Recovery agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recover invalid native finalization",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Recover invalid native finalization",
        criteria: [{ id: "objective", requirement: "Recovery remains live" }],
      },
      canonicalSha256: "native-recovery-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeReason: "persisted_before_kill_switch",
      nativeIssueId: issueId,
      nativeSessionId: runId,
      runnerInstanceId: contractId,
      completionContractId: contractId,
      completionContractSha256: "native-recovery-contract",
      contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId,
      issueId,
      runId,
      agentId,
      sessionId: runId,
      completionContractId: contractId,
      completionContractSha256: "native-recovery-contract",
      sourceInstanceId: contractId,
      controlPlaneSourceInstanceId: "recovery-control",
    });
    await port.openRun({
      ...CONTROL_PLANE_CONFORMANCE_OPEN,
      identity: { companyId, issueId, runId, agentId, sessionId: runId },
      sourceInstanceId: contractId,
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "recovery-result",
    });
    const stored = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))
      .limit(1).then((rows) => rows[0]!);
    await db.update(nativeRunResults).set({
      resultJson: {
        ...(stored.resultJson as Record<string, unknown>),
        terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, runTerminalState: "unknown" },
      },
    }).where(eq(nativeRunResults.id, stored.id));
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: runId,
      issueId,
      phase: "workspace_finalize",
      status: "succeeded",
    });

    await db.insert(issues).values({
      id: staleIssueId,
      companyId,
      title: "Retire a stale invalid finalizer",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: staleContractId,
      companyId,
      issueId: staleIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Retire a stale invalid finalizer",
        criteria: [{ id: "objective", requirement: "Keep the newer decision" }],
      },
      canonicalSha256: "stale-finalizer-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeReason: "persisted_before_kill_switch",
      nativeIssueId: staleIssueId,
      nativeSessionId: staleRunId,
      runnerInstanceId: staleContractId,
      completionContractId: staleContractId,
      completionContractSha256: "stale-finalizer-contract",
      contextSnapshot: { issueId: staleIssueId },
    });
    const stalePort = new PaperclipControlPlanePort(db, {
      companyId,
      issueId: staleIssueId,
      runId: staleRunId,
      agentId,
      sessionId: staleRunId,
      completionContractId: staleContractId,
      completionContractSha256: "stale-finalizer-contract",
      sourceInstanceId: staleContractId,
      controlPlaneSourceInstanceId: "stale-control",
    });
    await stalePort.openRun({
      ...CONTROL_PLANE_CONFORMANCE_OPEN,
      identity: { companyId, issueId: staleIssueId, runId: staleRunId, agentId, sessionId: staleRunId },
      sourceInstanceId: staleContractId,
    });
    await stalePort.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "stale-result",
    });
    const staleStored = await db.select().from(nativeRunResults)
      .where(eq(nativeRunResults.runId, staleRunId))
      .limit(1).then((rows) => rows[0]!);
    await db.update(nativeRunResults).set({
      resultJson: {
        ...(staleStored.resultJson as Record<string, unknown>),
        terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, runTerminalState: "unknown" },
      },
    }).where(eq(nativeRunResults.id, staleStored.id));
    await db.insert(workspaceOperations).values({
      companyId,
      heartbeatRunId: staleRunId,
      issueId: staleIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
    });
  }, 30_000);

  afterAll(async () => {
    await temporary.cleanup();
  });

  it("fails closed into bounded named recovery without consulting the live flag or falling back", async () => {
    await expect(reconcileNativeFinalizations(db, [runId])).resolves.toEqual([
      expect.objectContaining({ phase: "retryable_failure", failureCode: "native_finalization_invalid" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_progress", statusVersion: 0, lastStatusDecisionId: null }),
    ]);
    await expect(db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "active", ownerAgentId: agentId, cause: "native_finalization_invalid" }),
    ]);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))).resolves.toHaveLength(0);

    for (let retry = 0; retry < 2; retry += 1) {
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, runId));
      await reconcileNativeFinalizations(db, [runId]);
    }
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toEqual([
      expect.objectContaining({
        phase: "terminal_failure",
        attempt: 3,
        failureCode: "native_finalization_retry_exhausted",
        nextAttemptAt: null,
      }),
    ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toEqual([
      expect.objectContaining({
        runtimeMode: "native",
        status: "succeeded",
        nativePhase: "terminal_failure",
        resultJson: expect.objectContaining({ prpRunTerminalState: "succeeded" }),
      }),
    ]);
    await expect(reconcileNativeFinalizations(db, [runId])).resolves.toEqual([]);
  });

  it("retires an older failed finalizer when a newer run already committed the issue", async () => {
    await expect(reconcileNativeFinalizations(db, [staleRunId])).resolves.toEqual([
      expect.objectContaining({ phase: "retryable_failure", failureCode: "native_finalization_invalid" }),
    ]);

    const newerRunId = "72000000-0000-4000-8000-000000000016";
    await db.insert(heartbeatRuns).values({
      id: newerRunId,
      companyId,
      agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: staleIssueId,
      completionContractId: staleContractId,
      completionContractSha256: "stale-finalizer-contract",
      contextSnapshot: { issueId: staleIssueId },
    });
    const [newerResult] = await db.insert(nativeRunResults).values({
      companyId,
      issueId: staleIssueId,
      runId: newerRunId,
      completionContractId: staleContractId,
      callerResultId: "newer-result",
      serverFingerprint: "newer-result-fingerprint",
      schemaStatus: "accepted",
      resultJson: {},
      canonicalSha256: "newer-result-sha",
    }).returning();
    const [newerAssessment] = await db.insert(workAssessments).values({
      companyId,
      issueId: staleIssueId,
      runId: newerRunId,
      contractId: staleContractId,
      resultId: newerResult!.id,
      triggerKind: "native_result",
      triggerRef: newerResult!.id,
      triggerCapability: "server_native_finalizer",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress",
      priorStatusVersion: 0,
      policyVersion: "phase6-v3",
      assessmentJson: {},
      inputDigest: "newer-assessment-digest",
    }).returning();
    const [newerDecision] = await db.insert(statusDecisions).values({
      companyId,
      issueId: staleIssueId,
      runId: newerRunId,
      assessmentId: newerAssessment!.id,
      decisionVersion: 1,
      policyVersion: "phase6-v3",
      fromStatus: "in_progress",
      toStatus: "done",
      reasonCode: "completion_claim_policy_accepted",
      decisionJson: {},
      decisionDigest: "newer-decision-digest",
      applicationState: "applied",
      appliedAt: new Date(),
    }).returning();
    await db.update(issues).set({
      status: "done",
      statusVersion: 1,
      lastStatusDecisionId: newerDecision!.id,
    }).where(eq(issues.id, staleIssueId));
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, staleRunId));

    await expect(reconcileNativeFinalizations(db, [staleRunId])).resolves.toEqual([
      expect.objectContaining({ phase: "terminal_failure", failureCode: "native_finalization_superseded" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, staleIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "done", lastStatusDecisionId: newerDecision!.id }),
    ]);
    await expect(db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, staleIssueId))).resolves.toEqual([
        expect.objectContaining({ status: "resolved", outcome: "false_positive" }),
      ]);
  });
});
