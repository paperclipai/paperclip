import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  completionContracts,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  projectWorkspaces,
  projects,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import {
  type NativeExecutionInputV1,
  type NativeSession,
  type NativeSessionBackend,
  type PersistedNativeSession,
  type PrpEvent,
} from "@paperclipai/paperclip-runner";
import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "@paperclipai/paperclip-runner/testing";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  claimNativeSessionResumptions,
  dispatchNativeSessionResumptions,
} from "../services/native-runtime/native-finalization-reconciler.js";

const legacyAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "Fresh flag-off run completed through legacy.",
  resultJson: { summary: "fresh legacy after persisted native recovery" },
  provider: "test",
  model: "legacy-test",
})));

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "codex_local",
      execute: legacyAdapterExecute,
      supportsLocalAgentJwt: false,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

describe("P6-25 pre-result native session recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = "79000000-0000-4000-8000-000000000001";
  const agentId = "79000000-0000-4000-8000-000000000002";
  const issueId = "79000000-0000-4000-8000-000000000003";
  const runId = "79000000-0000-4000-8000-000000000004";
  const cancelledRunId = "79000000-0000-4000-8000-000000000005";
  const exhaustedRunId = "79000000-0000-4000-8000-000000000006";
  const missingCheckpointRunId = "79000000-0000-4000-8000-000000000007";
  const initialRunId = "79000000-0000-4000-8000-000000000008";
  const persistedProfile = {
    mode: "native",
    nativeExecutionInput: { schema: "paperclip.native-execution-input.v1", binding: { runId } },
    sessionCheckpoint: {
      backendKind: "codex_app_server",
      sessionId: "persisted-session",
      identity: { runId },
      providerSessionId: "provider-session",
      activeTurnId: "active-turn",
    },
  };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-resume-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native resume", issuePrefix: "NRR" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native resume agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resume the same native run",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: cancelledRunId,
        companyId,
        agentId,
        status: "cancelled",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: exhaustedRunId,
        companyId,
        agentId,
        status: "failed",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: missingCheckpointRunId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: { nativeExecutionInput: persistedProfile.nativeExecutionInput },
        contextSnapshot: { issueId },
      },
      {
        id: initialRunId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: { nativeExecutionInput: persistedProfile.nativeExecutionInput },
        contextSnapshot: { issueId },
      },
    ]);
    await db.insert(nativeRunFinalizations).values([
      { runId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) },
      { runId: cancelledRunId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) },
      { runId: exhaustedRunId, companyId, issueId, phase: "terminal_failure", attempt: 3 },
      { runId: missingCheckpointRunId, companyId, issueId, phase: "observed", attempt: 1 },
      { runId: initialRunId, companyId, issueId, phase: "observed", attempt: 0 },
    ]);
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  it("wins one database lease for the original result-less run without consulting the flag", async () => {
    const results = await Promise.all([
      claimNativeSessionResumptions({ db, runnerInstanceId: "reaper-a", runIds: [runId] }),
      claimNativeSessionResumptions({ db, runnerInstanceId: "reaper-b", runIds: [runId] }),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(results.flat()[0]).toMatchObject({ runId });
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toEqual([
      expect.objectContaining({ id: runId, status: "running", runtimeMode: "native" }),
    ]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toEqual([
      expect.objectContaining({ runId, phase: "observed", resultId: null, attempt: 1 }),
    ]);
  });

  it("dispatches the persisted run id and lease to the live same-run resume consumer", async () => {
    await db.update(nativeRunFinalizations).set({
      phase: "retryable_failure",
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(0),
    }).where(eq(nativeRunFinalizations.runId, runId));
    const dispatched: Array<{ runId: string; leaseOwner: string }> = [];
    await expect(dispatchNativeSessionResumptions({
      db,
      runnerInstanceId: "heartbeat-reaper",
      runIds: [runId],
      dispatch: (claim) => dispatched.push(claim),
    })).resolves.toHaveLength(1);
    expect(dispatched).toEqual([{ runId, leaseOwner: expect.stringContaining("heartbeat-reaper:resume:") }]);
    await expect(db.select().from(heartbeatRuns)).resolves.toHaveLength(5);
    await expect(db.select().from(nativeRunFinalizations)).resolves.toHaveLength(5);
  });

  it("does not resume cancelled or exhausted runs and fails closed without a checkpoint", async () => {
    await expect(claimNativeSessionResumptions({
      db,
      runnerInstanceId: "reaper",
      runIds: [cancelledRunId, exhaustedRunId, missingCheckpointRunId],
    })).resolves.toEqual([]);
    await expect(db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, missingCheckpointRunId))).resolves.toEqual([
      expect.objectContaining({ phase: "terminal_failure", failureCode: "native_session_checkpoint_missing" }),
    ]);
    await expect(db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))).resolves.toEqual([
      expect.objectContaining({ cause: "native_session_checkpoint_missing", wakePolicy: null }),
    ]);
  });

  it("does not mistake the pre-first-attempt observed coordinator for an orphan", async () => {
    await expect(claimNativeSessionResumptions({
      db,
      runnerInstanceId: "reaper",
      runIds: [initialRunId],
    })).resolves.toEqual([]);
    await expect(db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, initialRunId))).resolves.toEqual([
      expect.objectContaining({ phase: "observed", attempt: 0, failureCode: null }),
    ]);
  });
});

describe("P6-25 persisted reaper-to-finalization recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const executionWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const freshIssueId = randomUUID();
  const runId = randomUUID();
  const contractId = randomUUID();
  const workProductId = randomUUID();
  const sessionId = randomUUID();
  const runnerInstanceId = randomUUID();
  const turnId = "provider-active-turn";
  const providerSessionId = "provider-existing-session";
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const contract = {
    revision: "phase6-recovery-v1",
    objective: "Recover the persisted provider turn",
    criteria: [{ id: "objective", requirement: "Complete through same-run recovery" }],
  };
  const contractSha = "phase6-recovery-contract";
  const evidenceRef = `work_product:${workProductId}`;
  const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
  result.completionClaim.contractRevision = contract.revision;
  result.completionClaim.criteria[0]!.evidenceRefs = [evidenceRef];
  result.evidence = [{ kind: "work_product", ref: evidenceRef }];
  result.verification[0]!.artifactRef = evidenceRef;
  result.summary = "Recovered the already-active provider turn.";
  const terminal = {
    ...CONTROL_PLANE_CONFORMANCE_TERMINAL,
    reportedWorkDisposition: result.reportedWorkDisposition,
  };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { companyId, runId, issueId, agentId, executionWorkspaceId },
    task: {
      identifier: "NRR-1",
      title: "Recover one native heartbeat",
      description: null,
      workMode: "standard",
    },
    workspace: { cwd: repoRoot, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: sessionId, driverKind: "codex_app_server", protocolVersion: 1 },
    completionContract: {
      id: contractId,
      sha256: contractSha,
      schemaVersion: "paperclip.completion-contract.v1",
      contract,
    },
    interactionResponses: [],
    credentialBindings: [],
  };
  const checkpoint: PersistedNativeSession = {
    backendKind: "mock",
    sessionId: "driver-existing-session",
    identity: { companyId, runId, issueId, agentId, sessionId },
    providerSessionId,
    cursor: "1",
    activeTurnId: turnId,
    pendingRuntimeRequests: [],
    lineage: [],
  };
  const providerTerminalEvent: PrpEvent = {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `${runnerInstanceId}:provider-terminal`,
    sourceSeq: 1,
    sourceInstanceId: runnerInstanceId,
    sourceKind: "runner",
    runId,
    normalizedSessionId: sessionId,
    turnId,
    eventType: "turn.completed",
    schemaVersion: 1,
    priority: 0,
    emittedAt: "2026-08-09T04:30:00.000Z",
    payload: {},
  };
  const openSession = vi.fn(async () => {
    throw new Error("same-run recovery must not open a second provider session");
  });
  const startTurn = vi.fn(async () => ({ turnId: "duplicate-turn" }));
  const close = vi.fn(async () => undefined);
  const recoverSession = vi.fn(async (persisted: PersistedNativeSession) => {
    expect(persisted).toMatchObject({ providerSessionId, activeTurnId: turnId });
    const recoveredSnapshot: PersistedNativeSession = { ...structuredClone(checkpoint), cursor: "2" };
    const session: NativeSession = {
      identity: () => structuredClone(checkpoint.identity),
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield providerTerminalEvent; },
      startTurn,
      async result() { return { result, terminal, turnId }; },
      async snapshot() { return structuredClone(recoveredSnapshot); },
      close,
    };
    return { recovered: true, session };
  });
  const backend: NativeSessionBackend = {
    async descriptor() {
      return {
        kind: "mock",
        name: "persisted-recovery-backend",
        version: "1",
        capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
      };
    },
    openSession,
    recoverSession,
  };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-reaper-e2e-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "Native same-run recovery",
      issuePrefix: "NRR",
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Recovery project", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Recovery workspace",
      cwd: repoRoot,
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native recovery agent",
      adapterType: "codex_local",
      status: "idle",
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 },
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      issueNumber: 1,
      identifier: "NRR-1",
      title: "Recover one native heartbeat",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Persisted recovery workspace",
      status: "active",
      cwd: repoRoot,
      providerType: "local_fs",
    });
    await db.update(issues).set({
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "shared_workspace" },
    }).where(eq(issues.id, issueId));
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
      contractJson: contract,
      canonicalSha256: contractSha,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Recovered result evidence",
      status: "ready_for_review",
      reviewState: "approved",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolverVersion: "phase6-v1",
      runtimeModeReason: "eligible_opt_in",
      runtimeModeResolvedAt: new Date("2026-08-09T04:00:00.000Z"),
      runnerProfileJson: {
        mode: "native",
        backend: "codex_app_server",
        protocolVersion: 1,
        nativeExecutionInput: execution,
        sessionCheckpoint: checkpoint,
      },
      runnerInstanceId,
      nativeSessionId: sessionId,
      driverKind: "codex_app_server",
      driverVersion: "phase6-v1",
      completionContractId: contractId,
      completionContractSha256: contractSha,
      nativePhase: "retryable_failure",
      nativePhaseUpdatedAt: new Date("2026-08-09T04:00:00.000Z"),
      contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true },
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "retryable_failure",
      attempt: 1,
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date(0),
    });
  }, 30_000);

  afterAll(async () => {
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db, {
        runtimeEnv: { PAPERCLIP_INSTANCE_ID: "phase6-recovery-test" },
        nativeSessionBackendFactory: () => backend,
      }));
      await temporary.cleanup();
    }
  });

  it("finishes the persisted native run after flag-off and selects legacy only for a fresh run", async () => {
    legacyAdapterExecute.mockClear();
    const backendFactory = vi.fn(() => backend);
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_INSTANCE_ID: "phase6-recovery-test" },
      nativeSessionBackendFactory: backendFactory,
    });

    await expect(heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })).resolves.not.toContain(runId);
    await heartbeat.drainActiveRunExecutions();

    const recoveryState = {
      run: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)),
      coordinator: await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)),
    };
    expect(
      backendFactory.mock.calls.length,
      JSON.stringify(recoveryState),
    ).toBe(1);
    expect(recoverSession).toHaveBeenCalledOnce();
    expect(openSession).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(legacyAdapterExecute).not.toHaveBeenCalled();

    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).resolves.toEqual([
      expect.objectContaining({
        id: runId,
        runtimeMode: "native",
        status: "succeeded",
        nativePhase: "committed",
      }),
    ]);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).resolves.toHaveLength(1);
    await expect(db.select().from(workAssessments).where(eq(workAssessments.runId, runId))).resolves.toHaveLength(1);
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId));
    expect(decisions).toEqual([
      expect.objectContaining({ reasonCode: "completion_contract_satisfied", toStatus: "done", applicationState: "applied" }),
    ]);
    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, issueId));
    expect(new Set(effects.map((effect) => effect.decisionId))).toEqual(new Set([decisions[0]!.id]));
    expect(effects.map((effect) => effect.effectKind).sort()).toEqual(["issue_status_projection", "release_checkout"]);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "done", statusVersion: 1, lastStatusDecisionId: decisions[0]!.id }),
    ]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toEqual([
      expect.objectContaining({ phase: "committed", resultId: expect.any(String), assessmentId: expect.any(String), decisionId: decisions[0]!.id }),
    ]);
    await expect(db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "turn.completed" }),
        expect.objectContaining({ eventType: "run.result.accepted" }),
        expect.objectContaining({ eventType: "run.terminal" }),
      ]),
    );
    await expect(db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "issue.updated" })]),
    );

    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    await heartbeat.drainActiveRunExecutions();
    expect(backendFactory).toHaveBeenCalledOnce();
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).resolves.toHaveLength(1);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).resolves.toHaveLength(1);
    await expect(db.select().from(workAssessments).where(eq(workAssessments.runId, runId))).resolves.toHaveLength(1);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))).resolves.toHaveLength(1);

    await db.insert(issues).values({
      id: freshIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      issueNumber: 2,
      identifier: "NRR-2",
      title: "Start only after the native kill switch is off",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    const fresh = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: freshIssueId },
      contextSnapshot: { issueId: freshIssueId, taskId: freshIssueId, skipIssueComment: true },
    });
    expect(fresh).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(legacyAdapterExecute).toHaveBeenCalledOnce();
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fresh!.id))).resolves.toEqual([
      expect.objectContaining({
        agentId,
        runtimeMode: "legacy",
        runtimeModeReason: "instance_flag_disabled",
        status: "succeeded",
      }),
    ]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fresh!.id))).resolves.toHaveLength(0);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, fresh!.id))).resolves.toHaveLength(0);
    await expect(db.select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(eq(agents.id, agentId))).resolves.toEqual([
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 },
        }),
      }),
    ]);
  }, 30_000);
});
