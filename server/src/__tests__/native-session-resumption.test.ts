import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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
} from "../vendor/paperclip-runner/testing.js";
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
  const bootstrapRetryRunId = "79000000-0000-4000-8000-000000000009";
  const observedExpiredRunId = "79000000-0000-4000-8000-000000000010";
  const observedLivePidRunId = "79000000-0000-4000-8000-000000000011";
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
        nativeIssueId: issueId,
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
        nativeIssueId: issueId,
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
        nativeIssueId: issueId,
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
        nativeIssueId: issueId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: missingCheckpointRunId },
          },
        },
        contextSnapshot: { issueId },
      },
      {
        id: initialRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: initialRunId },
          },
        },
        contextSnapshot: { issueId },
      },
      {
        id: bootstrapRetryRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "failed",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: bootstrapRetryRunId },
          },
        },
        errorCode: "provider_initialize_timeout",
        contextSnapshot: { issueId },
      },
      ...[observedExpiredRunId, observedLivePidRunId].map((observedRunId) => ({
        id: observedRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "running" as const,
        runtimeMode: "native" as const,
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          ...persistedProfile,
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: observedRunId },
          },
          sessionCheckpoint: {
            ...persistedProfile.sessionCheckpoint,
            identity: { runId: observedRunId },
          },
        },
        contextSnapshot: { issueId },
      })),
    ]);
    await db.insert(nativeRunFinalizations).values([
      { runId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) },
      { runId: cancelledRunId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) },
      { runId: exhaustedRunId, companyId, issueId, phase: "terminal_failure", attempt: 3 },
      { runId: missingCheckpointRunId, companyId, issueId, phase: "retryable_failure", attempt: 1 },
      { runId: initialRunId, companyId, issueId, phase: "observed", attempt: 0 },
      {
        runId: bootstrapRetryRunId,
        companyId,
        issueId,
        phase: "retryable_failure",
        attempt: 1,
        nextAttemptAt: new Date(0),
        failureCode: "native_session_interrupted",
        failureDetail: {
          message: "provider_initialize_timeout: provider=opencode stage=health",
          originalFailureCode: "provider_initialize_timeout",
          recoveryMode: "bootstrap_retry",
          providerSessionEstablished: false,
          providerEventsExist: false,
          checkpointExists: false,
        },
      },
      ...[observedExpiredRunId, observedLivePidRunId].map((observedRunId) => ({
        runId: observedRunId,
        companyId,
        issueId,
        phase: "observed" as const,
        attempt: 2,
        leaseOwner: "prior-native-owner",
        leaseExpiresAt: new Date(0),
      })),
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
    await expect(db.select().from(heartbeatRuns)).resolves.toHaveLength(8);
    await expect(db.select().from(nativeRunFinalizations)).resolves.toHaveLength(8);
  });

  it("uses provider-neutral checkpoint-free bootstrap retry only when durable evidence proves no session existed", async () => {
    await expect(claimNativeSessionResumptions({
      db,
      runnerInstanceId: "reaper",
      runIds: [bootstrapRetryRunId],
    })).resolves.toEqual([
      { runId: bootstrapRetryRunId, leaseOwner: expect.stringContaining("reaper:resume:") },
    ]);
  });

  it("never claims an expired observed coordinator without explicit retryable failure", async () => {
    const dispatched: Array<{ runId: string; leaseOwner: string }> = [];
    await expect(dispatchNativeSessionResumptions({
      db,
      runnerInstanceId: "replacement-reaper",
      runIds: [observedExpiredRunId],
      dispatch: (claim) => dispatched.push(claim),
    })).resolves.toEqual([]);
    expect(dispatched).toEqual([]);
    await expect(db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, observedExpiredRunId))).resolves.toEqual([
      expect.objectContaining({
        phase: "observed",
        attempt: 2,
        leaseOwner: "prior-native-owner",
        leaseExpiresAt: new Date(0),
      }),
    ]);
  });

  it("blocks ambiguous observed ownership and a live unrelated persisted PID without replacement effects", async () => {
    const unrelatedProcess = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { stdio: "ignore" },
    );
    await once(unrelatedProcess, "spawn");
    try {
      await db.update(heartbeatRuns).set({
        processPid: unrelatedProcess.pid!,
        processStartedAt: new Date("2026-08-09T04:00:00.000Z"),
      }).where(eq(heartbeatRuns.id, observedLivePidRunId));
      const backendFactory = vi.fn((): NativeSessionBackend => ({
        async descriptor() {
          return {
            kind: "mock",
            name: "unexpected-observed-recovery",
            version: "1",
            capabilities: {
              resume: true,
              typedEvents: true,
              steering: false,
              interruption: true,
              structuredResult: true,
            },
          };
        },
        async openSession() {
          throw new Error("observed ownership must not open a provider session");
        },
        async recoverSession() {
          throw new Error("observed ownership must not recover a provider session");
        },
      }));
      const heartbeat = heartbeatService(db, {
        runtimeEnv: { PAPERCLIP_INSTANCE_ID: "observed-owner-test" },
        nativeSessionBackendFactory: backendFactory,
      });

      const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
      expect(reaped.runIds).not.toContain(observedExpiredRunId);
      expect(reaped.runIds).not.toContain(observedLivePidRunId);
      await heartbeat.drainActiveRunExecutions();

      expect(backendFactory).not.toHaveBeenCalled();
      expect(() => process.kill(unrelatedProcess.pid!, 0)).not.toThrow();
      await expect(db.select().from(heartbeatRuns).where(eq(
        heartbeatRuns.id,
        observedExpiredRunId,
      ))).resolves.toEqual([
        expect.objectContaining({
          status: "running",
          errorCode: "native_execution_ownership_unverified",
        }),
      ]);
      await expect(db.select().from(heartbeatRuns).where(eq(
        heartbeatRuns.id,
        observedLivePidRunId,
      ))).resolves.toEqual([
        expect.objectContaining({
          status: "running",
          processPid: unrelatedProcess.pid,
          errorCode: "native_execution_ownership_unverified",
        }),
      ]);
      for (const observedRunId of [observedExpiredRunId, observedLivePidRunId]) {
        await expect(db.select().from(nativeRunFinalizations).where(eq(
          nativeRunFinalizations.runId,
          observedRunId,
        ))).resolves.toEqual([
          expect.objectContaining({
            phase: "observed",
            attempt: 2,
            leaseOwner: "prior-native-owner",
            leaseExpiresAt: new Date(0),
          }),
        ]);
        await expect(db.select().from(nativeRunResults).where(eq(
          nativeRunResults.runId,
          observedRunId,
        ))).resolves.toHaveLength(0);
        await expect(db.select().from(workAssessments).where(eq(
          workAssessments.runId,
          observedRunId,
        ))).resolves.toHaveLength(0);
      }
    } finally {
      if (
        unrelatedProcess.exitCode === null &&
        unrelatedProcess.signalCode === null
      ) {
        const exited = once(unrelatedProcess, "exit");
        unrelatedProcess.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("does not resume cancelled or exhausted runs and fails closed without a checkpoint", async () => {
    await expect(claimNativeSessionResumptions({
      db,
      runnerInstanceId: "reaper",
      runIds: [cancelledRunId, exhaustedRunId, missingCheckpointRunId],
    })).resolves.toEqual([]);
    await expect(db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, missingCheckpointRunId))).resolves.toEqual([
      expect.objectContaining({ phase: "terminal_failure", failureCode: "native_session_interrupted" }),
    ]);
    await expect(db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))).resolves.toEqual([
      expect.objectContaining({ cause: "native_session_interrupted", wakePolicy: null }),
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
  let staleProviderProcess: ReturnType<typeof spawn> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const executionWorkspaceId = randomUUID();
  const newerExecutionWorkspaceId = randomUUID();
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
    provider: { kind: "codex", model: null },
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
    expect(staleProviderProcess).not.toBeNull();
    expect(
      staleProviderProcess!.exitCode !== null ||
      staleProviderProcess!.signalCode !== null,
    ).toBe(true);
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
      adapterType: "paperclip_runner",
      status: "active",
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
    await db.insert(executionWorkspaces).values({
      id: newerExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Newer issue workspace",
      status: "active",
      cwd: repoRoot,
      providerType: "local_fs",
    });
    await db.update(issues).set({
      // Simulate a newer run moving the issue-level pointer before the older native run is
      // recovered. The older run must still restore its own immutable workspace binding.
      executionWorkspaceId: newerExecutionWorkspaceId,
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
      nativeIssueId: issueId,
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
    if (
      staleProviderProcess &&
      staleProviderProcess.exitCode === null &&
      staleProviderProcess.signalCode === null
    ) {
      staleProviderProcess.kill("SIGKILL");
    }
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db, {
        runtimeEnv: { PAPERCLIP_INSTANCE_ID: "phase6-recovery-test" },
        nativeSessionBackendFactory: () => backend,
      }));
      await temporary.cleanup();
    }
  });

  it("does not kill an unowned persisted PID, then recovers after it exits while flag-off", async () => {
    legacyAdapterExecute.mockClear();
    staleProviderProcess = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { stdio: "ignore" },
    );
    await once(staleProviderProcess, "spawn");
    expect(staleProviderProcess.pid).toEqual(expect.any(Number));
    await db.update(heartbeatRuns).set({
      processPid: staleProviderProcess.pid!,
      processStartedAt: new Date("2026-08-09T04:00:00.000Z"),
    }).where(eq(heartbeatRuns.id, runId));
    const backendFactory = vi.fn(() => backend);
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_INSTANCE_ID: "phase6-recovery-test" },
      nativeSessionBackendFactory: backendFactory,
    });

    await expect(heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })).resolves.not.toContain(runId);
    await heartbeat.drainActiveRunExecutions();

    expect(backendFactory).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
    expect(() => process.kill(staleProviderProcess!.pid!, 0)).not.toThrow();
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toEqual([
      expect.objectContaining({
        id: runId,
        status: "running",
        processPid: staleProviderProcess.pid,
        errorCode: "native_execution_ownership_unverified",
      }),
    ]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(
      nativeRunFinalizations.runId,
      runId,
    ))).resolves.toEqual([
      expect.objectContaining({
        phase: "retryable_failure",
        attempt: 1,
        leaseOwner: null,
      }),
    ]);

    const unrelatedProcessExit = once(staleProviderProcess, "exit");
    staleProviderProcess.kill("SIGKILL");
    await unrelatedProcessExit;
    await db.update(nativeRunFinalizations).set({
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(eq(nativeRunFinalizations.runId, runId));

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
        processPid: null,
        processGroupId: null,
        processStartedAt: null,
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
      expect.objectContaining({
        status: "done",
        statusVersion: 1,
        lastStatusDecisionId: decisions[0]!.id,
        executionWorkspaceId: newerExecutionWorkspaceId,
      }),
    ]);
    await expect(db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, companyId)))
      .resolves.toHaveLength(2);
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

    // The persisted Paperclip Runner run above remains recoverable while the
    // flag is off. Switching the agent back to a direct adapter now proves a
    // fresh run ignores the stale native profile and stays on the legacy path.
    await db
      .update(agents)
      .set({ adapterType: "codex_local" })
      .where(eq(agents.id, agentId));
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
        runtimeModeReason: "direct_adapter",
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
