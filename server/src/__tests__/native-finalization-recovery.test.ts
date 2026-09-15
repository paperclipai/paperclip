import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import {
  reconcileNativeFinalizations,
  reconcileRetainedNativeSessionCleanups,
} from "../services/native-runtime/native-finalization-reconciler.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { assertRetainedNativeSourceArchiveSettled } from "../services/native-runtime/native-session-executor.js";

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

describe("retained native cleanup discovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const closeError =
    "provider_transport_failed: runner did not durably suspend before checkpoint";
  const legacyMaintenanceHistory = () => [
    {
      kind: "native_cleanup_maintenance",
      version: 1,
      phase: "started",
      requestId: "native-cleanup:legacy-request",
      sourceFingerprint: "a".repeat(64),
      startedAt: "2026-09-08T12:00:00.000Z",
    },
    {
      kind: "native_cleanup_maintenance",
      version: 1,
      phase: "operator_required",
      requestId: "native-cleanup:legacy-request",
      code: "native_cleanup_maintenance_unproven",
    },
  ];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "paperclip-native-cleanup-sweep-",
    );
    db = createDb(temporary.connectionString);
    await db
      .insert(companies)
      .values({ id: companyId, name: "Cleanup sweep", issuePrefix: "NCS" });
    await db
      .insert(agents)
      .values({
        id: agentId,
        companyId,
        name: "Cleanup",
        adapterType: "codex_local",
      });
  });
  afterEach(async () => {
    // Remove only this suite's discovery rows; the throwaway database retains
    // its accepted-result fixtures until teardown. No physical cleanup runs.
    await db
      .delete(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.companyId, companyId));
    await reconcileRetainedNativeSessionCleanups(db, {
      cleanup: async ({ runId }) => ({ runId, status: "not_eligible" }),
    });
  });
  afterAll(async () => {
    await temporary.cleanup();
  });

  async function candidate(
    options: {
      run?: Partial<typeof heartbeatRuns.$inferInsert>;
      coordinator?: Partial<typeof nativeRunFinalizations.$inferInsert>;
      schemaStatus?: string;
      issueId?: string;
      revision?: number;
    } = {},
  ) {
    const runId = randomUUID();
    const issueId = options.issueId ?? randomUUID();
    const contractId = randomUUID();
    if (!options.issueId) await db
      .insert(issues)
      .values({
        id: issueId,
        companyId,
        title: "Retained session",
        assigneeAgentId: agentId,
      });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: options.revision ?? 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {},
      canonicalSha256: runId,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      runtimeMode: "native",
      status: "succeeded",
      nativeIssueId: issueId,
      nativeSessionId: runId,
      nativePhase: "terminal_failure",
      completionContractId: contractId,
      completionContractSha256: runId,
      finishedAt: new Date(),
      errorCode: "adapter_failed",
      error: closeError,
      ...options.run,
    });
    const [result] = await db
      .insert(nativeRunResults)
      .values({
        companyId,
        issueId,
        runId,
        completionContractId: contractId,
        serverFingerprint: runId,
        canonicalSha256: runId,
        schemaStatus: options.schemaStatus ?? "accepted",
        resultJson: {},
      })
      .returning();
    const [assessment] = await db
      .insert(workAssessments)
      .values({
        companyId,
        issueId,
        runId,
        contractId,
        resultId: result!.id,
        triggerKind: "native_result",
        triggerActorCompanyId: companyId,
        priorIssueStatus: "in_progress",
        priorStatusVersion: 0,
        policyVersion: "phase6-v3",
        assessmentJson: {},
        inputDigest: runId,
      })
      .returning();
    const [decision] = await db
      .insert(statusDecisions)
      .values({
        companyId,
        issueId,
        runId,
        assessmentId: assessment!.id,
        decisionVersion: options.revision ?? 1,
        policyVersion: "phase6-v3",
        fromStatus: "in_progress",
        toStatus: "in_review",
        reasonCode: "prior_status_terminal_preserved",
        decisionJson: {},
        decisionDigest: runId,
      })
      .returning();
    await db.insert(nativeRunFinalizations).values({
      companyId,
      issueId,
      runId,
      phase: "committed",
      resultId: result!.id,
      assessmentId: assessment!.id,
      decisionId: decision!.id,
      ...options.coordinator,
    });
    return runId;
  }

  it("discovers exact committed results even with stale nativePhase or privately recovered errors", async () => {
    const stale = await candidate();
    const recovered = await candidate({
      run: {
        error: null,
        errorCode: null,
        resultJson: {
          recoveredExecutionFailure: {
            error: closeError,
            errorCode: "adapter_failed",
          },
        },
      },
    });
    const before = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    const cleanup = vi.fn(
      async ({ runId }: { runId: string; companyId: string }) => ({
        runId,
        status: "not_eligible" as const,
      }),
    );
    await reconcileRetainedNativeSessionCleanups(db, { cleanup, limit: 5 });
    expect(cleanup.mock.calls.map(([input]) => input.runId).sort()).toEqual(
      [stale, recovered].sort(),
    );
    expect(
      cleanup.mock.calls.every(([input]) => input.companyId === companyId),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId)),
    ).toEqual(before);
  });

  it.each([
    { run: { runtimeMode: "legacy" } },
    { run: { status: "running" } },
    { run: { finishedAt: null } },
    { run: { error: "another failure" } },
    { run: { errorCode: "setup_failed" } },
    {
      run: {
        error: "newer failure",
        errorCode: "adapter_failed",
        resultJson: {
          recoveredExecutionFailure: {
            error: closeError,
            errorCode: "adapter_failed",
          },
        },
      },
    },
    { schemaStatus: "rejected" },
    { coordinator: { phase: "retryable_failure" } },
    { coordinator: { nextAttemptAt: new Date(0) } },
    {
      coordinator: {
        leaseOwner: "another-controller",
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    },
    ...["started", "settled", "operator_required"].map((phase) => ({
      coordinator: {
        recoveryHistory: [{ kind: "native_cleanup_maintenance", phase }],
      },
    })),
    { coordinator: { recoveryHistory: [{ kind: "native_cleanup_source_archive", phase: "operator_required" }] } },
    { coordinator: { recoveryHistory: [
      { kind: "native_cleanup_source_archive", phase: "prepared" },
      { kind: "native_cleanup_runner_epoch", phase: "spawned", epoch: 1, pid: 88736 },
    ] } },
  ])(
    "excludes ineligible or previously attempted cleanup: %j",
    async (options) => {
      await candidate(options);
      const cleanup = vi.fn();
      expect(
        await reconcileRetainedNativeSessionCleanups(db, { cleanup, limit: 5 }),
      ).toEqual([]);
      expect(cleanup).not.toHaveBeenCalled();
    },
  );

  it("discovers a single legacy failed attempt only for independent physical proof", async () => {
    const runId = await candidate({
      coordinator: { recoveryHistory: legacyMaintenanceHistory() },
    });
    const before = await db
      .select()
      .from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, runId));
    const cleanup = vi.fn(async (input: { runId: string }) => ({
      runId: input.runId,
      status: "not_eligible" as const,
    }));
    await reconcileRetainedNativeSessionCleanups(db, { cleanup });
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId });
    expect(
      await db
        .select()
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, runId)),
    ).toEqual(before);
  });

  it.each(["prepared", "archived"])("discovers prelaunch source archival at %s without changing authority", async (phase) => {
    const runId = await candidate();
    const prepared = {
      kind: "native_cleanup_source_archive", version: 1, phase: "prepared",
      requestId: "native-cleanup:source-archive", companyId, agentId, runId,
      nativeSessionId: runId, runnerInstanceId: randomUUID(), stateKey: "a".repeat(64),
      archiveName: `${"a".repeat(64)}.identity_indeterminate.cleanup.fixture`,
      rootIdentity: { device: 1, inode: 2, mode: 0o40700 },
      sourceFingerprint: "b".repeat(64), providerHomeFingerprint: "c".repeat(64),
    };
    const history = [prepared, ...(phase === "archived" ? [{ ...prepared, phase }] : [])];
    await db.update(nativeRunFinalizations).set({ recoveryHistory: history })
      .where(eq(nativeRunFinalizations.runId, runId));
    const cleanup = vi.fn(async () => ({ runId, status: "not_eligible" as const }));
    await reconcileRetainedNativeSessionCleanups(db, { cleanup });
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({ companyId, runId });
    const [after] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(after?.recoveryHistory).toEqual(history);
    expect(after?.phase).toBe("committed");
  });

  it("fences actual scoped admission until every archived owner has its matching latest settlement", async () => {
    const first = await candidate();
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, first));
    const issueId = owner!.issueId;
    const scope = { companyId, issueId, stateKey: "d".repeat(64) };
    const prepared = { kind: "native_cleanup_source_archive", version: 1, phase: "prepared",
      stateKey: scope.stateKey, requestId: "native-cleanup:archive", sourceFingerprint: "a".repeat(64) };
    const settled = { kind: "native_cleanup_maintenance", phase: "settled",
      sourceArchiveRequestId: prepared.requestId, sourceFingerprint: prepared.sourceFingerprint };
    const setHistory = async (runId: string, history: Record<string, unknown>[]) =>
      db.update(nativeRunFinalizations).set({ recoveryHistory: history }).where(eq(nativeRunFinalizations.runId, runId));
    await assertRetainedNativeSourceArchiveSettled(db, scope);
    await setHistory(first, [prepared]);
    await expect(assertRetainedNativeSourceArchiveSettled(db, scope)).rejects.toMatchObject({ code: "native_session_cleanup_quarantined" });
    await assertRetainedNativeSourceArchiveSettled(db, { ...scope, stateKey: "e".repeat(64) });
    await assertRetainedNativeSourceArchiveSettled(db, { ...scope, companyId: randomUUID() });
    await assertRetainedNativeSourceArchiveSettled(db, { ...scope, issueId: randomUUID() });
    await setHistory(first, [prepared, { ...settled, sourceFingerprint: "b".repeat(64) }]);
    await expect(assertRetainedNativeSourceArchiveSettled(db, scope)).rejects.toMatchObject({ code: "native_session_cleanup_quarantined" });
    await setHistory(first, [prepared, settled]);
    await assertRetainedNativeSourceArchiveSettled(db, scope);
    await setHistory(first, [prepared, { ...prepared }, settled]);
    await expect(assertRetainedNativeSourceArchiveSettled(db, scope)).rejects.toMatchObject({ code: "native_session_cleanup_quarantined" });
    await setHistory(first, [{ ...prepared, version: null }, settled]);
    await expect(assertRetainedNativeSourceArchiveSettled(db, scope)).rejects.toMatchObject({ code: "native_session_cleanup_quarantined" });
    await setHistory(first, [{ ...prepared, requestId: null }, { kind: "native_cleanup_maintenance", phase: "settled", sourceFingerprint: prepared.sourceFingerprint }]);
    await expect(assertRetainedNativeSourceArchiveSettled(db, scope)).rejects.toMatchObject({ code: "native_session_cleanup_quarantined" });
    await setHistory(first, [prepared, settled]);
    const second = await candidate({ issueId, revision: 2 });
    await setHistory(second, [prepared, settled]);
    await assertRetainedNativeSourceArchiveSettled(db, scope);
    const third = await candidate({ issueId, revision: 3 });
    await setHistory(third, [prepared]);
    await expect(assertRetainedNativeSourceArchiveSettled(db, scope)).rejects.toMatchObject({ code: "native_session_cleanup_quarantined" });
    await setHistory(third, [prepared, settled]);
    await assertRetainedNativeSourceArchiveSettled(db, scope);
    await setHistory(first, [prepared, settled, { ...settled, phase: "operator_required" }]);
    await expect(assertRetainedNativeSourceArchiveSettled(db, scope)).rejects.toMatchObject({ code: "native_session_cleanup_quarantined" });
  });

  it.each([
    [
      "new epoch",
      (entries: Record<string, unknown>[]) =>
        entries.push({ kind: "native_cleanup_runner_epoch", phase: "intent" }),
    ],
    [
      "third attempt",
      (entries: Record<string, unknown>[]) => entries.push({ ...entries[0] }),
    ],
    [
      "reordered phases",
      (entries: Record<string, unknown>[]) => entries.reverse(),
    ],
    [
      "different request",
      (entries: Record<string, unknown>[]) => {
        entries[1]!.requestId = "native-cleanup:other";
      },
    ],
    [
      "unversioned entry",
      (entries: Record<string, unknown>[]) => {
        delete entries[0]!.version;
      },
    ],
    [
      "settled attempt",
      (entries: Record<string, unknown>[]) => {
        entries[1]!.phase = "settled";
      },
    ],
    [
      "unknown failure",
      (entries: Record<string, unknown>[]) => {
        entries[1]!.code = "other_failure";
      },
    ],
    [
      "missing source",
      (entries: Record<string, unknown>[]) => {
        delete entries[0]!.sourceFingerprint;
      },
    ],
  ] as const)("excludes legacy discovery with %s", async (_name, mutate) => {
    const history: Record<string, unknown>[] = legacyMaintenanceHistory();
    mutate(history);
    await candidate({ coordinator: { recoveryHistory: history } });
    const cleanup = vi.fn();
    expect(
      await reconcileRetainedNativeSessionCleanups(db, { cleanup }),
    ).toEqual([]);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("joins overlap and advances beyond a permanently ineligible first candidate", async () => {
    const ids = [await candidate(), await candidate()].sort();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cleanup = vi.fn(
      async ({ runId }: { runId: string; companyId: string }) => {
        started();
        await held;
        return { runId, status: "not_eligible" as const };
      },
    );
    const first = reconcileRetainedNativeSessionCleanups(db, { cleanup });
    await entered;
    const overlapping = reconcileRetainedNativeSessionCleanups(db, { cleanup });
    expect(overlapping).toBe(first);
    expect(cleanup).toHaveBeenCalledTimes(1);
    release();
    await first;
    await reconcileRetainedNativeSessionCleanups(db, { cleanup });
    expect(cleanup.mock.calls.map(([input]) => input.runId)).toEqual(ids);
    await reconcileRetainedNativeSessionCleanups(db, { cleanup });
    expect(cleanup.mock.calls.map(([input]) => input.runId)).toEqual([
      ...ids,
      ids[0],
    ]);
  });

  it("isolates one failure and resets its joined owner for the next bounded sweep", async () => {
    const ids = [await candidate(), await candidate()].sort();
    const onError = vi.fn();
    const cleanup = vi.fn(
      async ({ runId }: { runId: string; companyId: string }) => {
        if (runId === ids[0]) throw new Error("fixture cleanup refused");
        return { runId, status: "operator_required" as const };
      },
    );
    expect(
      await reconcileRetainedNativeSessionCleanups(db, {
        cleanup,
        onError,
        limit: 2,
      }),
    ).toEqual([{ runId: ids[1], status: "operator_required" }]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), ids[0]);
    await reconcileRetainedNativeSessionCleanups(db, {
      cleanup,
      onError,
      limit: 2,
    });
    expect(cleanup).toHaveBeenCalledTimes(4);
  });
});
