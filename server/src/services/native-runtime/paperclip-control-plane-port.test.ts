import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import {
  executeNativeSession,
  parseNativeExecutionInput,
  type NativeSessionBackend,
  type PrpEvent,
  type PrpStructuredRunResult,
  type PrpTerminalState,
} from "../../vendor/paperclip-runner/index.js";
import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
  CONTROL_PLANE_CONFORMANCE_OPEN,
  runControlPlanePortConformance,
} from "../../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";

describe("PaperclipControlPlanePort conformance", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const contractId = "00000000-0000-4000-8000-000000000004";
  const contractSha = "phase6-conformance-contract";
  const taskIssueId = "00000000-0000-4000-8000-000000000008";
  const taskContractId = "00000000-0000-4000-8000-000000000009";
  const taskRunId = "00000000-0000-4000-8000-000000000010";
  const taskSessionId = "00000000-0000-4000-8000-000000000018";
  const taskWorkProductId = "00000000-0000-4000-8000-000000000017";
  const workspaceFailureIssueId = "00000000-0000-4000-8000-000000000011";
  const workspaceFailureContractId = "00000000-0000-4000-8000-000000000012";
  const workspaceFailureRunId = "00000000-0000-4000-8000-000000000013";
  const governanceIssueId = "00000000-0000-4000-8000-000000000014";
  const governanceContractId = "00000000-0000-4000-8000-000000000015";
  const governanceRunId = "00000000-0000-4000-8000-000000000016";
  const conformanceRunnerId = "00000000-0000-4000-8000-000000000005";
  const taskRunnerId = "00000000-0000-4000-8000-000000000019";
  const workspaceFailureRunnerId = "00000000-0000-4000-8000-000000000020";
  const governanceRunnerId = "00000000-0000-4000-8000-000000000021";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-port-");
    db = createDb(temporary.connectionString);
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    await db.insert(companies).values({ id: identity.companyId, name: "Phase 6", issuePrefix: "P6C" });
    await db.insert(agents).values({
      id: identity.agentId,
      companyId: identity.companyId,
      name: "Native conformance",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: identity.issueId,
      companyId: identity.companyId,
      title: "Native conformance",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId: identity.companyId,
      issueId: identity.issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Conformance",
        criteria: [{ id: "objective", requirement: "Complete conformance" }],
      },
      canonicalSha256: contractSha,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: identity.runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId: conformanceRunnerId,
      completionContractId: contractId,
      completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    await db.insert(issues).values({
      id: taskIssueId,
      companyId: identity.companyId,
      title: "Complete one native task",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: taskContractId,
      companyId: identity.companyId,
      issueId: taskIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Complete one native task",
        criteria: [{ id: "objective", requirement: "Complete the task" }],
      },
      canonicalSha256: "phase6-task-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: taskRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolverVersion: "phase6-v1",
      runtimeModeReason: "eligible_opt_in",
      nativeIssueId: taskIssueId,
      nativeSessionId: taskSessionId,
      runnerInstanceId: taskRunnerId,
      completionContractId: taskContractId,
      completionContractSha256: "phase6-task-contract",
      contextSnapshot: { issueId: taskIssueId },
    });
    await db.insert(issueWorkProducts).values({
      id: taskWorkProductId,
      companyId: identity.companyId,
      issueId: taskIssueId,
      type: "artifact",
      provider: "paperclip",
      title: "Verified native task result",
      status: "ready_for_review",
      reviewState: "approved",
      createdByRunId: taskRunId,
    });
    await db.insert(issues).values({
      id: workspaceFailureIssueId,
      companyId: identity.companyId,
      title: "Preserve status after workspace failure",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: workspaceFailureContractId,
      companyId: identity.companyId,
      issueId: workspaceFailureIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Preserve status after workspace failure",
        criteria: [{ id: "objective", requirement: "Preserve the result" }],
      },
      canonicalSha256: "phase6-workspace-failure-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: workspaceFailureRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: workspaceFailureIssueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId: workspaceFailureRunnerId,
      completionContractId: workspaceFailureContractId,
      completionContractSha256: "phase6-workspace-failure-contract",
      contextSnapshot: { issueId: workspaceFailureIssueId },
    });
    await db.insert(issues).values({
      id: governanceIssueId,
      companyId: identity.companyId,
      title: "Respect pending governance",
      status: "in_review",
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: governanceContractId,
      companyId: identity.companyId,
      issueId: governanceIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Respect pending governance",
        criteria: [{ id: "objective", requirement: "Respect pending governance" }],
      },
      canonicalSha256: "phase6-governance-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: governanceRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: governanceIssueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId: governanceRunnerId,
      completionContractId: governanceContractId,
      completionContractSha256: "phase6-governance-contract",
      contextSnapshot: { issueId: governanceIssueId },
    });
    await db.insert(issueThreadInteractions).values({
      companyId: identity.companyId,
      issueId: governanceIssueId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Approve completion?" },
    });
  }, 30_000);

  afterAll(async () => {
    if (temporary) {
      await db.delete(activityLog);
      await db.delete(agentWakeupRequests);
      await db.delete(statusDecisionEffects);
      await db.delete(nativeRunFinalizations);
      await db.delete(statusDecisions);
      await db.delete(workAssessments);
      await db.delete(nativeRunResults);
      await db.delete(issueThreadInteractions);
      await db.delete(issueWorkProducts);
      await db.delete(issueRelations);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(completionContracts);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(companies);
      await temporary.cleanup();
    }
  });

  it("runs the unchanged package conformance suite against Paperclip persistence", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: identity.issueId,
      runId: identity.runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: contractId,
      completionContractSha256: contractSha,
      sourceInstanceId: conformanceRunnerId,
      controlPlaneSourceInstanceId: "control-conformance",
    });
    await expect(runControlPlanePortConformance({ port })).resolves.toEqual({
      eventCount: 3,
      highestContiguousSourceSeq: 3,
      duplicateDisposition: "duplicate",
      terminalReplayIdempotent: true,
      openBindingRejected: true,
      eventIdMutationRejected: true,
      eventSequenceMutationRejected: true,
      replayBindingRejected: true,
      resultMutationRejected: true,
    });
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).resolves.toHaveLength(1);
    await finalizeNativeRun({
      db,
      runId: identity.runId,
      workspaceFinalizeStatus: "succeeded",
    });
    await expect(db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, identity.runId))).resolves.toEqual([
      expect.objectContaining({ phase: "committed" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, identity.issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review", statusVersion: 1 }),
    ]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, identity.runId))).resolves.toEqual([
      expect.objectContaining({ phase: "committed" }),
    ]);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, identity.issueId))).resolves.toEqual([
      expect.objectContaining({ toStatus: "in_review", reasonCode: "external_verification_required", applicationState: "applied" }),
    ]);
    await expect(db.select().from(activityLog).where(eq(activityLog.entityId, identity.issueId))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "issue.updated" })]),
    );
  });

  it("completes one selected Paperclip task through the public package session contract", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const sessionId = taskSessionId;
    const evidenceRef = `work_product:${taskWorkProductId}`;
    const taskResult = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
    taskResult.completionClaim.contractRevision = "phase6-v1";
    taskResult.completionClaim.criteria[0]!.evidenceRefs = [evidenceRef];
    taskResult.evidence = [{ kind: "work_product", ref: evidenceRef }];
    taskResult.verification[0]!.artifactRef = evidenceRef;
    const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `phase6-task:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: taskRunnerId,
      sourceKind: "runner",
      runId: taskRunId,
      normalizedSessionId: sessionId,
      turnId: "turn-phase6-paperclip-task",
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: `2026-08-09T02:59:0${sourceSeq}.000Z`,
      payload,
    });
    const events = [
      event(1, "run.result.proposed", taskResult),
      event(2, "turn.completed", {}),
    ];
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "phase6-scripted",
          version: "1",
          capabilities: { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
        };
      },
      async openSession(input) {
        return {
          identity: () => input.identity,
          async capabilities() { return { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() { yield* events; },
          async startTurn() { return { turnId: "turn-phase6-paperclip-task" }; },
          cancel() { return { cleanup: Promise.resolve() }; },
          async result() { return { result: taskResult, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: "turn-phase6-paperclip-task" }; },
          async snapshot() { return { backendKind: "mock", sessionId, identity: input.identity, providerSessionId: "provider-phase6-paperclip-task" }; },
          async close() {},
        };
      },
    };
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v4",
      executionMode: "default",
      planningContext: null,
      binding: {
        companyId: identity.companyId,
        runId: taskRunId,
        issueId: taskIssueId,
        agentId: identity.agentId,
        executionWorkspaceId: "workspace-phase6",
      },
      task: {
        identifier: "P6C-2",
        title: "Complete one native task",
        description: null,
        prompt: "# P6C-2: Complete one native task",
        workMode: "standard",
      },
      workspace: {
        cwd: process.cwd(),
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: sessionId,
        driverKind: "codex_app_server",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      provider: { kind: "codex", model: null, approvalPolicy: "never" },
      completionContract: {
        id: taskContractId,
        sha256: "phase6-task-contract",
        schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "phase6-v1", objective: "Complete one native task", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      },
      interactionResponses: [],
      credentialBindings: [],
      runtimeContext: nativeRuntimeContextFixture(),
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: taskIssueId,
      runId: taskRunId,
      agentId: identity.agentId,
      sessionId: taskSessionId,
      completionContractId: taskContractId,
      completionContractSha256: "phase6-task-contract",
      sourceInstanceId: taskRunnerId,
      controlPlaneSourceInstanceId: "phase6-control-plane",
    });
    const completed = await executeNativeSession({
      input: execution,
      backend,
      controlPlane: port,
      runnerInstanceId: taskRunnerId,
      controlPlaneInstanceId: "phase6-control-plane",
    });
    expect(completed.terminal.runTerminalState).toBe("succeeded");
    await finalizeNativeRun({ db, runId: taskRunId, workspaceFinalizeStatus: "succeeded" });
    await expect(port.completeRun({
      result: taskResult,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      turnId: "turn-phase6-paperclip-task",
      callerResultId: `phase6-scripted-runner:${taskRunId}:result`,
      callerDedupeKey: `${taskRunId}:phase6-task-contract`,
    })).resolves.toBeUndefined();
    await expect(port.completeRun({
      result: { ...structuredClone(taskResult), summary: "Conflicting changed result bytes" },
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      turnId: "turn-phase6-paperclip-task",
      callerResultId: `phase6-scripted-runner:${taskRunId}:result`,
      callerDedupeKey: `${taskRunId}:phase6-task-contract`,
    })).rejects.toThrow("structured_result_replay_conflict");
    await Promise.all([
      finalizeNativeRun({ db, runId: taskRunId, workspaceFinalizeStatus: "succeeded" }),
      finalizeNativeRun({ db, runId: taskRunId, workspaceFinalizeStatus: "succeeded" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, taskIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "done", statusVersion: 1 }),
    ]);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, taskRunId))).resolves.toHaveLength(1);
    await expect(db.select().from(workAssessments).where(eq(workAssessments.runId, taskRunId))).resolves.toHaveLength(1);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, taskIssueId))).resolves.toHaveLength(1);
  });

  it("fails closed when the bound company does not own the run", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: "00000000-0000-4000-8000-000000000099",
      issueId: identity.issueId,
      runId: identity.runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: contractId,
      completionContractSha256: contractSha,
      sourceInstanceId: conformanceRunnerId,
      controlPlaneSourceInstanceId: "control-conformance",
    });
    await expect(port.openRun(CONTROL_PLANE_CONFORMANCE_OPEN)).rejects.toThrow("binding_mismatch");
  });

  it("revalidates every persisted native binding before open and completion", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "00000000-0000-4000-8000-000000000091";
    const localContractId = "00000000-0000-4000-8000-000000000092";
    const runId = "00000000-0000-4000-8000-000000000093";
    const sessionId = "00000000-0000-4000-8000-000000000094";
    const runnerInstanceId = "00000000-0000-4000-8000-000000000095";
    const contractSha256 = "strict-native-binding-contract";
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Strict native binding",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "strict-binding-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "strict-binding-v1",
        objective: "Enforce the persisted binding",
        criteria: [{ id: "objective", requirement: "Reject every mismatch" }],
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: contractSha256,
      contextSnapshot: { issueId },
    });
    const createPort = () => new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId,
      completionContractId: localContractId,
      completionContractSha256: contractSha256,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "strict-binding-control",
    });
    const open = {
      identity: { ...identity, issueId, runId, sessionId },
      backendKind: "mock" as const,
      sourceInstanceId: runnerInstanceId,
    };
    const mutations = [
      { invalid: { nativeIssueId: taskIssueId }, restore: { nativeIssueId: issueId } },
      { invalid: { nativeSessionId: taskSessionId }, restore: { nativeSessionId: sessionId } },
      { invalid: { runnerInstanceId: taskRunnerId }, restore: { runnerInstanceId } },
      { invalid: { completionContractId: taskContractId }, restore: { completionContractId: localContractId } },
      { invalid: { completionContractSha256: "wrong-contract" }, restore: { completionContractSha256: contractSha256 } },
    ] satisfies Array<{
      invalid: Partial<typeof heartbeatRuns.$inferInsert>;
      restore: Partial<typeof heartbeatRuns.$inferInsert>;
    }>;
    for (const mutation of mutations) {
      await db.update(heartbeatRuns).set(mutation.invalid).where(eq(heartbeatRuns.id, runId));
      await expect(createPort().openRun(open)).rejects.toThrow("native_open_run_not_authorized");
      await db.update(heartbeatRuns).set(mutation.restore).where(eq(heartbeatRuns.id, runId));
    }

    const openedPort = createPort();
    await openedPort.openRun(open);
    await db.update(heartbeatRuns).set({ runnerInstanceId: taskRunnerId }).where(eq(heartbeatRuns.id, runId));
    await expect(openedPort.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "strict-native-binding-result",
    })).rejects.toThrow("native_result_binding_mismatch");
    await db.update(heartbeatRuns).set({ runnerInstanceId }).where(eq(heartbeatRuns.id, runId));
  });

  it("does not let native completion bypass a pending issue interaction", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: governanceIssueId,
      runId: governanceRunId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: governanceContractId,
      completionContractSha256: "phase6-governance-contract",
      sourceInstanceId: governanceRunnerId,
      controlPlaneSourceInstanceId: "control-phase6-governance",
    });
    await port.openRun({
      identity: { ...identity, runId: governanceRunId, issueId: governanceIssueId },
      backendKind: "mock",
      sourceInstanceId: governanceRunnerId,
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "phase6-governance-result",
    });
    await finalizeNativeRun({ db, runId: governanceRunId, workspaceFinalizeStatus: "succeeded" });
    await expect(db.select().from(issues).where(eq(issues.id, governanceIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review" }),
    ]);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, governanceIssueId))).resolves.toEqual([
      expect.objectContaining({ toStatus: "in_review", reasonCode: "governed_gate_pending" }),
    ]);
  });

  it("P6-23 materializes native review through the authorized interaction service", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "30000000-0000-4000-8000-000000000024";
    const localContractId = "31000000-0000-4000-8000-000000000024";
    const runId = "32000000-0000-4000-8000-000000000024";
    const runnerInstanceId = "33000000-0000-4000-8000-000000000024";
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Native review interaction",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      responsibleUserId: "reviewer-24",
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "phase6-v1", objective: "Review", criteria: [{ id: "objective", requirement: "Review" }] },
      canonicalSha256: "native-review-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: "native-review-contract",
      contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: localContractId,
      completionContractSha256: "native-review-contract",
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "native-review-control",
    });
    await port.openRun({
      identity: { ...identity, issueId, runId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result = { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), reportedWorkDisposition: "needs_review" as const };
    await port.completeRun({
      result,
      terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, reportedWorkDisposition: "needs_review" },
      callerResultId: "native-review-result",
    });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });

    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review", statusVersion: 1 }),
    ]);
    const [reviewInteraction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(reviewInteraction).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      sourceRunId: runId,
      addresseeUserId: "reviewer-24",
      effectiveResolverPolicy: "human_only",
    });
    await expect(db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, issueId))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ effectKind: "bind_reviewer", targetType: "issue_thread_interaction" })]),
    );

    await issueThreadInteractionService(db).acceptInteraction(
      { id: issueId, companyId: identity.companyId, projectId: null, goalId: null, status: "in_review" },
      reviewInteraction!.id,
      {},
      { userId: "reviewer-24" },
    );
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "done" }),
    ]);
  });

  it("completes DOT-29-style low-risk work with an environment caveat and no corrective run", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "30000000-0000-4000-8000-000000000029";
    const localContractId = "31000000-0000-4000-8000-000000000029";
    const runId = "32000000-0000-4000-8000-000000000029";
    const runnerInstanceId = "33000000-0000-4000-8000-000000000029";
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "DOT-29 completion caveat",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "low",
      completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v3",
        objective: "Complete the low-risk task",
        criteria: [{ id: "objective", requirement: "Complete the requested work" }],
      },
      canonicalSha256: "dot-29-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: "dot-29-contract",
      contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: localContractId,
      completionContractSha256: "dot-29-contract",
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "dot-29-control",
    });
    await port.openRun({
      identity: { ...identity, issueId, runId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result: PrpStructuredRunResult = {
      ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      summary: "The requested work is complete; local Node verification could not run.",
      completionClaim: {
        contractRevision: "phase6-v3",
        objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
        remainingWork: [],
      },
      evidence: [],
      verification: [{ commandOrCheck: "Run npm test", status: "not_run" }],
      attentionRequests: [{
        kind: "environment_constraint",
        summary: "Node and npm are unavailable in this sandbox.",
      }],
    };
    await port.completeRun({
      result,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "dot-29-result",
    });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });

    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "done", statusVersion: 1 }),
    ]);
    await expect(db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).resolves.toEqual([]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, identity.companyId)))
      .resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ issueId, sourceRunId: runId }) }),
      ]));
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))).resolves.toEqual([
      expect.objectContaining({ toStatus: "done", reasonCode: "completion_claim_policy_accepted" }),
    ]);
    const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(persistedRun).toMatchObject({ status: "succeeded", nativePhase: "committed" });
    expect(persistedRun?.resultJson).toMatchObject({
      finalizationReasonCode: "completion_claim_policy_accepted",
      verificationCaveats: [{
        commandOrCheck: "Run npm test",
        reasonCode: "tool_unavailable",
        detail: "Node and npm are unavailable in this sandbox.",
      }],
      ignoredAttentionRequests: [expect.objectContaining({
        sourceKind: "environment_constraint",
        disposition: "verification_caveat",
      })],
    });
  });

  it("coalesces a completed child dependency into one rich parent wake", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const parentIssueId = "30000000-0000-4000-8000-000000000145";
    const childIssueId = "30000000-0000-4000-8000-000000000146";
    const localContractId = "31000000-0000-4000-8000-000000000146";
    const runId = "32000000-0000-4000-8000-000000000146";
    const runnerInstanceId = "33000000-0000-4000-8000-000000000146";
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId: identity.companyId,
        title: "Accepted plan parent",
        status: "in_progress",
        assigneeAgentId: identity.agentId,
        workMode: "planning",
      },
      {
        id: childIssueId,
        companyId: identity.companyId,
        parentId: parentIssueId,
        title: "Implement the accepted plan",
        status: "in_progress",
        assigneeAgentId: identity.agentId,
        workMode: "standard",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId: identity.companyId,
      issueId: childIssueId,
      relatedIssueId: parentIssueId,
      type: "blocks",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId: childIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "low",
      completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "child-wake-v1",
        objective: "Implement the accepted plan",
        criteria: [{ id: "objective", requirement: "Implement and test" }],
      },
      canonicalSha256: "child-wake-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: childIssueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: "child-wake-contract",
      contextSnapshot: { issueId: childIssueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: childIssueId,
      runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: localContractId,
      completionContractSha256: "child-wake-contract",
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "child-wake-control",
    });
    await port.openRun({
      identity: { ...identity, issueId: childIssueId, runId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result: PrpStructuredRunResult = {
      ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      summary: "Implemented the accepted plan and passed 44/44 tests.",
      completionClaim: {
        contractRevision: "child-wake-v1",
        objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
        remainingWork: [],
      },
      verification: [{ commandOrCheck: "node --test", status: "passed" }],
      attentionRequests: [],
    };
    await port.completeRun({
      result,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "child-wake-result",
    });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });

    const parentWakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, identity.companyId))
      .then((rows) => rows.filter((row) => row.payload?.issueId === parentIssueId));
    expect(parentWakes).toHaveLength(1);
    expect(parentWakes[0]).toMatchObject({
      reason: "issue_children_completed",
      payload: {
        issueId: parentIssueId,
        completedChildIssueId: childIssueId,
        childIssueIds: [childIssueId],
        childIssueSummaries: [{
          id: childIssueId,
          title: "Implement the accepted plan",
          status: "done",
          summary: "Implemented the accepted plan and passed 44/44 tests.",
        }],
        childIssueSummaryTruncated: false,
        _paperclipWakeContext: {
          wakeReason: "issue_children_completed",
          childIssueSummaries: [{
            id: childIssueId,
            summary: "Implemented the accepted plan and passed 44/44 tests.",
          }],
        },
      },
    });
  });

  it("returns a rejected native completion review to the original agent with the reviewer reason", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "30000000-0000-4000-8000-000000000027";
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Rejected native completion review",
      status: "in_review",
      assigneeAgentId: identity.agentId,
      responsibleUserId: "reviewer-25",
      workMode: "standard",
    });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId: identity.companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      sourceRunId: taskRunId,
      addresseeUserId: "reviewer-25",
      payload: {
        version: 1,
        prompt: "Approve completion?",
        rejectRequiresReason: true,
        target: { type: "custom", key: "native_completion_review", revisionId: "decision-25" },
      },
    }).returning();

    const rejected = await issueThreadInteractionService(db).rejectInteraction(
      { id: issueId, companyId: identity.companyId, status: "in_review" },
      interaction!.id,
      { reason: "Add the missing external verification." },
      { userId: "reviewer-25" },
    );

    expect(rejected).toMatchObject({
      status: "rejected",
      result: { outcome: "rejected", reason: "Add the missing external verification." },
    });
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "todo", assigneeAgentId: identity.agentId }),
    ]);
  });

  it("preserves the result and issue status when workspace finalization fails", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: workspaceFailureIssueId,
      runId: workspaceFailureRunId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: workspaceFailureContractId,
      completionContractSha256: "phase6-workspace-failure-contract",
      sourceInstanceId: workspaceFailureRunnerId,
      controlPlaneSourceInstanceId: "control-phase6-workspace-failure",
    });
    await port.openRun({
      identity: { ...identity, runId: workspaceFailureRunId, issueId: workspaceFailureIssueId },
      backendKind: "mock",
      sourceInstanceId: workspaceFailureRunnerId,
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "phase6-workspace-failure-result",
    });
    await finalizeNativeRun({
      db,
      runId: workspaceFailureRunId,
      workspaceFinalizeStatus: "failed",
      projectRunStatus: true,
    });
    await expect(db.select().from(issues).where(eq(issues.id, workspaceFailureIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_progress", statusVersion: 0, lastStatusDecisionId: null }),
    ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, workspaceFailureRunId))).resolves.toEqual([
      expect.objectContaining({ status: "succeeded", nativePhase: "retryable_failure" }),
    ]);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, workspaceFailureRunId))).resolves.toHaveLength(1);
  });

  it("LIVE-01..06 rolls back status, decision, and liveness rows at every materialization failpoint", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const cases: Array<{
      suffix: number;
      failpoint: "governance_materialization" | "interaction_materialization" | "continuation_materialization" | "blocker_materialization" | "recovery_materialization" | "status_projection";
      result: PrpStructuredRunResult;
      terminalState?: "succeeded" | "failed" | "cancelled";
      executionState?: Record<string, unknown>;
    }> = [
      {
        suffix: 20,
        failpoint: "interaction_materialization",
        result: { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), reportedWorkDisposition: "needs_review" },
      },
      {
        suffix: 21,
        failpoint: "continuation_materialization",
        result: {
          ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
          reportedWorkDisposition: "yielded",
          continuation: { kind: "same_agent", summary: "Continue after recovery", idempotencyKey: "live-continue" },
        },
      },
      {
        suffix: 22,
        failpoint: "blocker_materialization",
        result: {
          ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
          reportedWorkDisposition: "blocked",
          blocker: {
            reasonCode: "access",
            owner: { kind: "user", name: "Board operator" },
            unblockAction: "Approve access",
            scope: "task_wide",
          },
        },
      },
      {
        suffix: 23,
        failpoint: "status_projection",
        result: { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), reportedWorkDisposition: "needs_review" },
      },
      {
        suffix: 25,
        failpoint: "recovery_materialization",
        terminalState: "cancelled",
        result: structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      },
      {
        suffix: 26,
        failpoint: "governance_materialization",
        executionState: { status: "pending", stage: "approval" },
        result: structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      },
    ];
    for (const entry of cases) {
      const value = String(entry.suffix).padStart(12, "0");
      const issueId = `30000000-0000-4000-8000-${value}`;
      const contractId = `31000000-0000-4000-8000-${value}`;
      const runId = `32000000-0000-4000-8000-${value}`;
      const runnerInstanceId = `33000000-0000-4000-8000-${value}`;
      await db.insert(issues).values({
        id: issueId,
        companyId: identity.companyId,
        title: `Atomic liveness ${entry.failpoint}`,
        status: "in_progress",
        assigneeAgentId: identity.agentId,
        workMode: "standard",
        executionState: entry.executionState,
      });
      await db.insert(completionContracts).values({
        id: contractId,
        companyId: identity.companyId,
        issueId,
        revision: 1,
        schemaVersion: "paperclip.completion-contract.v1",
        policyVersion: "phase6-v1",
        risk: "standard",
        completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { revision: "phase6-v1", objective: "Atomic liveness", criteria: [{ id: "objective", requirement: "Stay atomic" }] },
        canonicalSha256: `contract-${entry.suffix}`,
        createdByActorType: "system",
        createdByActorId: "test",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: identity.companyId,
        agentId: identity.agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        nativeSessionId: identity.sessionId,
        runnerInstanceId,
        completionContractId: contractId,
        completionContractSha256: `contract-${entry.suffix}`,
        contextSnapshot: { issueId },
      });
      const terminal: PrpTerminalState = {
        ...CONTROL_PLANE_CONFORMANCE_TERMINAL,
        runTerminalState: entry.terminalState ?? "succeeded",
        reportedWorkDisposition: entry.result.reportedWorkDisposition,
      };
      const port = new PaperclipControlPlanePort(db, {
        companyId: identity.companyId,
        issueId,
        runId,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        completionContractId: contractId,
        completionContractSha256: `contract-${entry.suffix}`,
        sourceInstanceId: runnerInstanceId,
        controlPlaneSourceInstanceId: `atomic-control-${entry.suffix}`,
      });
      await port.openRun({
        identity: { ...identity, issueId, runId },
        backendKind: "mock",
        sourceInstanceId: runnerInstanceId,
      });
      await port.completeRun({ result: entry.result, terminal, callerResultId: `atomic-result-${entry.suffix}` });
      await expect(finalizeNativeRun({
        db,
        runId,
        workspaceFinalizeStatus: "succeeded",
        failpoint: entry.failpoint,
      })).resolves.toEqual(expect.objectContaining({ phase: "retryable_failure" }));
      await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
        expect.objectContaining({ status: "in_progress", statusVersion: 0, lastStatusDecisionId: null }),
      ]);
      await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))).resolves.toHaveLength(0);
      await expect(db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, issueId))).resolves.toHaveLength(0);
      await expect(db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).resolves.toHaveLength(0);
      await expect(db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, identity.companyId))).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ issueId }) })]),
      );
      await expect(db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId))).resolves.toEqual([
        expect.objectContaining({ status: "active", cause: "side_effect_planning_failed" }),
      ]);
    }
  });
});
