import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, executionWorkspaces, nativeRunFinalizations, runUsageReceipts, workspaceOperations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { createRunPreparationTiming, measureRunPhase, measureWorkspaceSyncPhase, withRunExecutionTiming } from "../execution-preparation-timing.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import * as pluginWorkspaces from "../plugin-workspaces.js";
import * as legacyRecovery from "../legacy-execution-recovery.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { createAdapterExecutionControl } from "../adapter-execution-control.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { workspaceOperationService } from "../workspace-operations.js";
import { instanceSettingsService } from "../instance-settings.js";
import { executePaperclipNativeSession, NativeCancellationPendingRecoveryError, NativeControllerDetachedForRestartError } from "../native-runtime/native-session-executor.js";
import { NativeRunnerOwnershipUnverifiedError } from "../native-runtime/native-runner-ownership.js";
import { NativeWorkspaceFinalizationBusyError, NativeWorkspaceFinalizationOwnershipLostError } from "../native-runtime/native-workspace-finalization-ownership.js";
import { resolveHeartbeatNativeRuntimeMode } from "../native-runtime/runtime-mode.js";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { createHeartbeatRunState } from "./run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "./workspaces.js";
import { revokeHeartbeatRunGatewayTokens } from "./run-preparation.js";
import { executeHeartbeatRuntime, type HeartbeatRuntimeExecutionInput } from "./runtime-execution.js";

// Keep real accounting, workspace barriers, and task-session persistence. Providers
// and gateway delivery are external boundaries; browser acceptance covers their wiring.
vi.mock("../native-runtime/native-session-executor.js", async original => ({
  ...await original<typeof import("../native-runtime/native-session-executor.js")>(),
  executePaperclipNativeSession: vi.fn(),
}));
vi.mock("./run-preparation.js", async original => ({
  ...await original<typeof import("./run-preparation.js")>(),
  buildPaperclipRuntimeMcpServers: vi.fn(async () => []),
  createAdapterRuntimeToolAccess: vi.fn(() => null),
  createManagedMcpRunConfig: vi.fn(async () => null),
  revokeHeartbeatRunGatewayTokens: vi.fn(async () => {}),
}));

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat runtime execution boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-runtime-execution-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-execution");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
    vi.clearAllMocks();
    vi.mocked(executePaperclipNativeSession).mockResolvedValue({ exitCode: 0, signal: null, timedOut: false });
  });

  async function fixture(native = false, provider: "codex" | "grok_bot" | "openai_dot" = "codex") {
    const [company] = await db.insert(companies).values({ name: "Runtime execution", issuePrefix: "EXE" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Executing agent", status: "running", adapterType: native ? "paperclip_runner" : "process", adapterConfig: provider === "codex" ? { provider } : { provider, lifecycleMode: "per_turn", allowUnmeteredProvider: true, [provider === "grok_bot" ? "externalBindingId" : "dotBindingId"]: randomUUID() } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Complete this task", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: native ? "native" : "legacy" }).returning();
    const state = createHeartbeatRunState(db);
    const executionControl = createAdapterExecutionControl();
    const adapter = { type: "process", label: "Test process", testEnvironment: vi.fn(), execute: vi.fn<HeartbeatRuntimeExecutionInput["runtime"]["adapter"]["execute"]>(async () => ({ exitCode: 0, signal: null, timedOut: false })) };
    let instructionSave: Record<string, unknown> | null = null;
    const nativeExecution = native ? buildNativeExecutionInput({
      companyId: company.id, agentId: agent.id, runId: run.id, issue,
      taskPrompt: issue.title, workspace: { id: run.id, cwd: home, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: null, provider, runtimeContext: nativeRuntimeContextFixture(),
      dotBinding: { bindingId: randomUUID(), bindingGeneration: 1, companyId: company.id, agentId: agent.id, acceptByUnixMs: Date.now() + 60_000, expiresAtUnixMs: Date.now() + 120_000 },
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: issue.title, criteria: [{ id: "output", requirement: issue.title }] } },
    }) : null;
    const input: HeartbeatRuntimeExecutionInput = {
      run, agent, options: {},
      task: { issueRef: issue, issueContext: null, context: {}, issueId: issue.id, taskKey: issue.id, executionContinuation: null },
      runtime: { nativeExecution, nativeRunnerInstanceId: native ? randomUUID() : null, getNativeFreshSessionHandoff: undefined,
        nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: native, grokEnabled: true, dotEnabled: true, runtimeConfig: {}, adapterConfig: agent.adapterConfig, agent, issue, target: null, workspaceId: null }),
        adapter, runtimeForAdapter: { taskKey: issue.id, sessionId: null, sessionParams: null, sessionDisplayId: null }, getFreshSessionHandoff: undefined, runOptions: {},
      },
      workspace: { persistedExecutionWorkspace: null, executionWorkspace: { baseCwd: home, cwd: home, source: "agent_home", projectId: null, workspaceId: null, repoUrl: null, repoRef: null, strategy: "project_primary", branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false },
        executionTarget: null, nativeWorkspaceSync: null, workspaceRestoreSource: undefined, remoteExecution: null,
        workspaceOperationRecorder: workspaceOperationService(db).createRecorder({ companyId: company.id, heartbeatRunId: run.id, issueId: issue.id }),
      },
      config: { runtimeConfig: {}, resolvedConfig: {}, managedAiRuntime: undefined,
        resolvedInstanceSettings: { experimental: { enableWorkspaceBranchReconcileForward: false, enableWorkspaceDirtyQuarantineRepair: false } },
        configuredTaskEnvironment: {}, adapterEnv: {}, agentIdentity: undefined, runtimeEnv: {}, useHostGitHub: false, githubSelection: { configured: false },
      },
      session: { runtimeSessionParamsForAdapter: null, configuredModel: null,
        sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }), goalCheckpointSession: { current: null },
      },
      instructions: { instructionCopy: null, getInstructionSave: () => instructionSave, nativeInstructionWorkingCopy: () => undefined,
        collectStoppedInstructions: async () => { instructionSave = { state: "saved", revisionId: "during-execution" }; },
        nativeInstructionReservation: null, releaseInstructionCopy: vi.fn(async () => {}),
      },
      trace: { providerTraceCapture: null, nativeRunnerPreparationSpans: [], attestedQuestionResponseAtMs: null, attemptStartedAtMs: Date.now(), environmentAcquireStartedAtMs: Date.now(), environmentRealizeEndedAtMs: Date.now() },
      control: { executionControl, executionPhaseContext: { onExecutionPhase: executionControl.phases.enter },
        dispatchResolvedInteractionContinuationWithAtomicGate: async dispatch => ({ dispatched: true, resultPromise: dispatch(vi.fn()) }),
      },
      output: { identityRedactor: createAgentIdentityRedactor(), appendIdentityRedactedLog: vi.fn(async () => {}), onLog: vi.fn(async () => {}), onAdapterEvent: vi.fn(async () => {}), onAdapterMeta: vi.fn(async () => {}) },
      services: { ...state, executionWorkspacesSvc: executionWorkspaceService(db), instanceSettings: instanceSettingsService(db),
        envOrchestrator: { releaseForRun: vi.fn() }, cancelRunInternal: vi.fn(), enqueueWakeup: vi.fn(),
        persistRunProcessMetadata: vi.fn(), recordCurrentHeartbeatRunRuntimeProgress: vi.fn(), dispatchPendingNativeStatusWakeups: vi.fn(),
      },
      effects: { onUsageCaptureReady: vi.fn(), onNativeDispatchStarted: vi.fn(), onLegacyAdapterEntered: vi.fn(), onWorkspaceRestoreFailure: vi.fn(), onProviderResourceDisposition: vi.fn(), onNativeWorkspaceFinalizeScheduled: vi.fn(), onNativeSessionResumeScheduled: vi.fn(), onNativeOwnershipHeld: vi.fn() },
    };
    return { input, adapter, run };
  }
  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const finalizations = () => db.select().from(workspaceOperations).where(eq(workspaceOperations.phase, "workspace_finalize"));
  function expectCleanup(input: HeartbeatRuntimeExecutionInput) {
    expect(revokeHeartbeatRunGatewayTokens).toHaveBeenCalledWith({ db, companyId: input.agent.companyId, runId: input.run.id });
    expect(input.instructions.releaseInstructionCopy).toHaveBeenCalledOnce();
  }

  it("passes preparation renewal ownership to native dispatch", async () => {
    const { input } = await fixture(true);
    const acquired = vi.fn(async () => undefined);
    input.runtime.runOptions.onNativeExecutionLeaseAcquired = acquired;
    await executeHeartbeatRuntime(db, input);
    expect(executePaperclipNativeSession).toHaveBeenCalledWith(expect.objectContaining({ onExecutionLeaseAcquired: acquired }));
    // Preparation is still protected until the native executor claims its lease.
    expect(acquired).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves the dispatch gate's early return and cleanup (native: %s)", async native => {
    const { input, adapter } = await fixture(native);
    input.control.dispatchResolvedInteractionContinuationWithAtomicGate = async () => ({ dispatched: false });
    expect(await executeHeartbeatRuntime(db, input)).toEqual({ dispatched: false });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(executePaperclipNativeSession).not.toHaveBeenCalled();
    expect(input.effects.onNativeDispatchStarted).not.toHaveBeenCalled();
    expect(input.effects.onLegacyAdapterEntered).not.toHaveBeenCalled();
    expect(await finalizations()).toHaveLength(0);
    expectCleanup(input);
  });

  it("captures usage and live instruction saves before finalizing a legacy workspace", async () => {
    const { input, adapter, run } = await fixture();
    adapter.execute.mockImplementationOnce(async ctx => {
      expect(input.effects.onLegacyAdapterEntered).toHaveBeenCalledOnce();
      expect(input.effects.onUsageCaptureReady).toHaveBeenCalledOnce();
      await ctx.onProviderStopped?.();
      return { exitCode: 0, signal: null, timedOut: false, usage: { inputTokens: 10, outputTokens: 4 }, costUsd: 0.01, provider: "test" };
    });
    expect(await executeHeartbeatRuntime(db, input)).toMatchObject({ dispatched: true, adapterResult: { usageComplete: true, resultJson: { instructionSave: { state: "saved", revisionId: "during-execution" } } } });
    expect(await read(run.id)).toMatchObject({ status: "running", costAccountingPending: true, usageJson: { inputTokens: 10, outputTokens: 4, accountingReceiptReady: true } });
    expect(await db.select().from(runUsageReceipts)).toHaveLength(1);
    expect(await finalizations()).toMatchObject([{ status: "succeeded" }]);
    expectCleanup(input);
  });

  it("preserves Stop metadata and marks no-work accounting without manufacturing a receipt", async () => {
    const { input, adapter, run } = await fixture();
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { stoppedByUser: true } }).where(eq(heartbeatRuns.id, run.id));
    adapter.execute.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    await executeHeartbeatRuntime(db, input);
    expect(await read(run.id)).toMatchObject({ status: "cancelled", resultJson: { stoppedByUser: true }, usageJson: { accountingProviderWorkStarted: false } });
    expect(await db.select().from(runUsageReceipts)).toHaveLength(0);
    expectCleanup(input);
  });

  it("records the failed workspace and keeps the original provider error", async () => {
    const { input, adapter } = await fixture();
    const error = new Error("provider failed");
    adapter.execute.mockRejectedValueOnce(error);
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
    expect(await finalizations()).toMatchObject([{ status: "failed", metadata: { errorMessage: "provider failed" } }]);
    expect(input.effects.onLegacyAdapterEntered).toHaveBeenCalledOnce();
    expectCleanup(input);
  });

  it.each([
    [new NativeCancellationPendingRecoveryError(), null],
    [new NativeControllerDetachedForRestartError(), "onNativeSessionResumeScheduled"],
    [new NativeRunnerOwnershipUnverifiedError(), "onNativeOwnershipHeld"],
    [new NativeWorkspaceFinalizationBusyError(), "onNativeWorkspaceFinalizeScheduled"],
    [new NativeWorkspaceFinalizationOwnershipLostError(), "onNativeWorkspaceFinalizeScheduled"],
  ] as const)("transfers recovery ownership for %s before cleanup", async (error, effect) => {
    const { input } = await fixture(true);
    vi.mocked(executePaperclipNativeSession).mockRejectedValueOnce(error);
    input.instructions.releaseInstructionCopy = vi.fn(async () => {
      if (effect) expect(input.effects[effect]).toHaveBeenCalledOnce();
    });
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
    expect(input.effects.onNativeDispatchStarted).toHaveBeenCalledOnce();
    expect(input.effects.onLegacyAdapterEntered).not.toHaveBeenCalled();
    expect(await finalizations()).toHaveLength(0);
    if (error instanceof NativeControllerDetachedForRestartError) {
      expect(revokeHeartbeatRunGatewayTokens).not.toHaveBeenCalled();
      expect(input.instructions.releaseInstructionCopy).toHaveBeenCalledOnce();
    } else expectCleanup(input);
  });

  it("dispatches native execution with the selected session and persists its usage", async () => {
    const { input, adapter, run } = await fixture(true);
    vi.mocked(executePaperclipNativeSession).mockImplementationOnce(async native => {
      expect(native.execution).toBe(input.runtime.nativeExecution);
      expect(native.runnerInstanceId).toBe(input.runtime.nativeRunnerInstanceId);
      await native.onUsage?.({ usage: { inputTokens: 7, outputTokens: 3 }, complete: true });
      return { exitCode: 0, signal: null, timedOut: false, usageComplete: false };
    });
    expect(await executeHeartbeatRuntime(db, input)).toMatchObject({ dispatched: true, adapterResult: { usage: { inputTokens: 7, outputTokens: 3 }, usageComplete: true } });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(input.effects.onNativeDispatchStarted).toHaveBeenCalledOnce();
    expect(await read(run.id)).toMatchObject({ status: "running", usageJson: { inputTokens: 7, outputTokens: 3, accountingReceiptReady: true } });
    expect(await finalizations()).toMatchObject([{ status: "succeeded" }]);
    expectCleanup(input);
  });

  it.each(["expected", "wrong"])("finalizes a plugin worktree through its owner (branch: %s)", async branch => {
    const { input } = await fixture(true);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: input.agent.companyId,
      name: "Plugin worktree", providerType: "plugin", providerRef: "provider:opaque-worktree", cwd: "/workspaces/plugin-only",
      mode: "isolated_workspace", strategyType: "git_worktree", branchName: "task-branch" }).returning();
    input.workspace.persistedExecutionWorkspace = workspace;
    const inspect = vi.spyOn(pluginWorkspaces, "finalizePluginWorkspace").mockResolvedValue({ kind: "inspection",
      branchName: branch === "expected" ? "task-branch" : "other-branch", headSha: "a".repeat(40),
      hasDirtyTrackedFiles: true, hasUntrackedFiles: false, hasLocalOnlyData: true, isMergedIntoBase: false, remotelyRecoverable: false });
    try {
      const result = executeHeartbeatRuntime(db, input);
      if (branch === "expected") {
        await expect(result).resolves.toMatchObject({ dispatched: true });
        expect(await finalizations()).toMatchObject([{ status: "succeeded" }]);
      } else {
        await expect(result).rejects.toThrow("plugin_workspace_branch_mismatch");
        expect((await finalizations()).some(row => row.status === "succeeded")).toBe(false);
      }
      expect(inspect).toHaveBeenCalledWith(db, undefined, expect.objectContaining({ id: workspace.id, providerRef: workspace.providerRef }), { agentId: input.agent.id, runId: input.run.id });
    } finally { inspect.mockRestore(); }
  });

  it("retains the same-run retry signal without recording a failed workspace", async () => {
    const { input, run } = await fixture(true);
    await db.update(heartbeatRuns).set({ nativeIssueId: input.task.issueId }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, issueId: input.task.issueId!, runId: run.id, phase: "retryable_failure" });
    const error = new Error("session connection lost");
    vi.mocked(executePaperclipNativeSession).mockRejectedValueOnce(error);
    await expect(executeHeartbeatRuntime(db, input)).rejects.toMatchObject({
      name: "NativeSessionResumeScheduledError", original: error,
    });
    expect(input.effects.onNativeSessionResumeScheduled).toHaveBeenCalledOnce();
    expect(await finalizations()).toHaveLength(0);
    expectCleanup(input);
  });

  it("records native restoration inside the workspace finalization operation", async () => {
    const { input, run } = await fixture(true);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    const restore = vi.fn(async () => {
      expect(await finalizations()).toMatchObject([{
        status: "running", metadata: { owningService: "native_workspace_finalizer" },
      }]);
      await measureWorkspaceSyncPhase("workspace.restore", async () => {});
      await measureRunPhase("execution.workspace_commit", async () => {});
    });
    input.workspace.nativeWorkspaceSync = {
      mode: "host_current",
      reference: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: run.id, leaseId: randomUUID(), providerLeaseId: "sandbox", remoteCwd: "/workspace", resourceDisposition: null },
      restoreWorkspace: restore,
      cleanup: vi.fn(async () => {}),
    };
    try {
      expect(await withRunExecutionTiming(run.id, () => executeHeartbeatRuntime(db, input))).toMatchObject({ dispatched: true });
      expect(restore).toHaveBeenCalledOnce();
      expect(await finalizations()).toMatchObject([{
        status: "succeeded", metadata: { owningService: "native_workspace_finalizer" },
      }]);
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      const attempt = spans.find(span => span.name === "task.execution_attempt")!;
      expect(attempt).toBeDefined();
      for (const name of ["execution.usage_startup", "execution.mcp_handoff", "execution.dispatch_admission"]) {
        const startup = spans.filter(span => span.name === name);
        expect(startup).toHaveLength(1);
        expect(startup[0].parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
      }
      const copyback = spans.filter(span => span.name === "execution.workspace_restore");
      const commit = spans.filter(span => span.name === "execution.workspace_commit");
      expect(copyback).toHaveLength(1);
      expect(commit).toHaveLength(1);
      const finalization = spans.find(span => span.name === "execution.workspace_finalize")!;
      expect(finalization).toBeDefined();
      for (const child of [...copyback, ...commit]) expect(child.parentSpanContext?.spanId).toBe(finalization.spanContext().spanId);
    } finally {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      trace.disable();
      await provider.shutdown();
    }
  });

  it.each([false, true])("ends admission timing without losing later provider spans (native: %s)", async native => {
    const { input, adapter, run } = await fixture(native);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    let release!: (result: Awaited<ReturnType<typeof executePaperclipNativeSession>>) => void;
    const providerResult = new Promise<Awaited<ReturnType<typeof executePaperclipNativeSession>>>(resolve => { release = resolve; });
    const providerWork = async () => {
      const result = await providerResult;
      await createRunPreparationTiming(run.id, "native.controller")("coordinator_release", async () => {});
      return result;
    };
    if (native) vi.mocked(executePaperclipNativeSession).mockImplementationOnce(providerWork);
    else adapter.execute.mockImplementationOnce(providerWork);
    const running = withRunExecutionTiming(run.id, () => executeHeartbeatRuntime(db, input));
    try {
      await vi.waitFor(() => {
        expect(exporter.getFinishedSpans().filter(span => span.name === "execution.dispatch_admission")).toHaveLength(1);
      }, { timeout: 5_000 });
      expect(native ? executePaperclipNativeSession : adapter.execute).toHaveBeenCalledOnce();
      expect(exporter.getFinishedSpans().find(span => span.name === "task.execution_attempt")).toBeUndefined();
      expect(await finalizations()).toHaveLength(0);
      release({ exitCode: 0, signal: null, timedOut: false });
      await running;
      const spans = exporter.getFinishedSpans();
      const attempt = spans.find(span => span.name === "task.execution_attempt")!;
      const later = spans.filter(span => span.name === "native.controller.coordinator_release");
      expect(later).toHaveLength(1);
      expect(later[0].spanContext().traceId).toBe(attempt.spanContext().traceId);
      expect(later[0].parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    } finally {
      release({ exitCode: 0, signal: null, timedOut: false });
      await running;
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      trace.disable();
      await provider.shutdown();
    }
  });

  it.each(["codex", "grok_bot", "openai_dot"] as const)("retains user files only when %s can access the workspace after a dispatch failure", async provider => {
    const { input, run } = await fixture(true, provider);
    input.workspace.nativeWorkspaceSync = {
      mode: "host_current",
      reference: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: run.id, leaseId: randomUUID(), providerLeaseId: "sandbox", remoteCwd: "/workspace", resourceDisposition: "destroy" },
      restoreWorkspace: vi.fn(), cleanup: vi.fn(),
    };
    const error = new Error("runner_remote_process_identity_unavailable");
    vi.mocked(executePaperclipNativeSession).mockRejectedValueOnce(error);
    input.instructions.releaseInstructionCopy = vi.fn(async () => {
      if (provider === "codex") expect(input.effects.onProviderResourceDisposition).toHaveBeenCalledWith("stop_and_retain");
      else expect(input.effects.onProviderResourceDisposition).not.toHaveBeenCalledWith("stop_and_retain");
    });
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
    expect(input.workspace.nativeWorkspaceSync.restoreWorkspace).not.toHaveBeenCalled();
    expectCleanup(input);
  });

  it("records a failed barrier if the successful finalization write fails", async () => {
    const { input } = await fixture();
    const error = new Error("finalization write failed");
    vi.spyOn(input.workspace.workspaceOperationRecorder, "recordOperation").mockRejectedValueOnce(error);
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
    expect(await finalizations()).toMatchObject([{ status: "failed" }]);
    expectCleanup(input);
  });

  it("retains a failed sandbox restore even when persisting its receipt throws", async () => {
    const { input, adapter, run } = await fixture();
    input.workspace.executionTarget = { kind: "remote", transport: "sandbox", remoteCwd: home };
    const evidence = { workspaceRestoreFailure: "restore_failed", workspaceRestoreDiagnostic: { message: "copy-back failed" } };
    adapter.execute.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, resultJson: evidence });
    const order: string[] = [];
    input.effects.onWorkspaceRestoreFailure = vi.fn(() => { order.push("restore evidence"); });
    input.effects.onProviderResourceDisposition = vi.fn(() => { order.push("retain sandbox"); });
    input.instructions.releaseInstructionCopy = vi.fn(async () => { order.push("cleanup"); });
    const error = new Error("restore receipt write failed");
    const record = vi.spyOn(legacyRecovery, "recordLegacyWorkspaceRestoreFailure").mockImplementationOnce(async () => {
      order.push("receipt write");
      throw error;
    });
    try {
      await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
      expect(record).toHaveBeenCalledWith(db, run, evidence, input.workspace.workspaceRestoreSource);
      expect(input.effects.onWorkspaceRestoreFailure).toHaveBeenCalledWith(evidence);
      expect(input.effects.onProviderResourceDisposition).toHaveBeenCalledWith("stop_and_retain");
      expect(order).toEqual(["restore evidence", "retain sandbox", "receipt write", "cleanup"]);
      expect(await finalizations()).toMatchObject([{ status: "failed" }]);
      expectCleanup(input);
    } finally { record.mockRestore(); }
  });

  it("runs instruction cleanup even when gateway revocation fails", async () => {
    const { input } = await fixture();
    vi.mocked(revokeHeartbeatRunGatewayTokens).mockRejectedValueOnce(new Error("gateway unavailable"));
    expect(await executeHeartbeatRuntime(db, input)).toMatchObject({ dispatched: true });
    expectCleanup(input);
  });
});
