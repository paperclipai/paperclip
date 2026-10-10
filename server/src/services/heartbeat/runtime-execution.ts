import { parseNativeSessionGoalControl } from "./scheduling.js";
import { isHeartbeatRunTerminalStatus } from "./run-lifecycle.js";
import {
  PAPERCLIP_WAKE_PAYLOAD_KEY,
  configuredPaperclipApiBaseUrl,
  buildPaperclipRuntimeMcpServers,
  createAdapterRuntimeToolAccess,
  paperclipApiBaseUrl,
  createAdapterRuntimeMcpAccess,
  createManagedMcpRunConfig,
  revokeHeartbeatRunGatewayTokens,
} from "./run-preparation.js";
import {
  WorkspaceValidationFailure,
  isWorkspaceValidationFailure,
  fingerprintFinalizeWorkspaceBranchValidation,
  attachPaperclipSessionMetadataToSessionParams,
} from "./workspaces.js";
import { recordLegacyWorkspaceRestoreFailure } from "../legacy-execution-recovery.js";
import { configuredEnvironmentProjection } from "../../vendor/paperclip-runner/index.js";
import { buildAgentIdentityEnv } from "@paperclipai/adapter-utils/server-utils";
import { externalObjectService } from "../external-objects.js";
import { isAgentDirectoryCopy } from "../agent-directory-working-copies.js";
import { restoreNativeWorkspaceBestEffort } from "../native-runtime/native-workspace-best-effort.js";
import {
  withNativeWorkspaceFinalizationOwnership,
  NativeWorkspaceFinalizationBusyError,
  NativeWorkspaceFinalizationOwnershipLostError,
  type NativeWorkspaceFinalizationOwnership,
} from "../native-runtime/native-workspace-finalization-ownership.js";
import { createRunUsageRecorder } from "../usage-receipts.js";
import { applyWorkspaceRestoreFailure } from "@paperclipai/adapter-utils/workspace-restore-result";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { isConversation } from "../agent-conversations.js";
import { withAdapterExecutionPhase } from "@paperclipai/adapter-utils/execution-phase";
import { remoteExecutionHasStopped } from "../remote-execution-termination.js";
import { registerAdapterExecutionControl } from "../adapter-execution-control.js";
import { resolveManagedOpenAiBilling } from "@paperclipai/adapter-utils";
import { and, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, workspaceOperations } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { getStartupTraceContext } from "../../instrumentation.js";
import { logger } from "../../middleware/logger.js";
import {
  buildNativeProviderEnvironment,
  executePaperclipNativeSession,
  finalizeNativeRun,
  isRunnerIngressAuthorized,
  materializeLegacyQuestionResponseWakeProjection,
  NativeCancellationPendingRecoveryError,
  NativeControllerDetachedForRestartError,
  recordNativeFinalizationFailure,
} from "../native-runtime/index.js";
import {
  buildNativeHeartbeatPreparationSpans,
  buildNativeWakeIngressSpan,
} from "../native-runtime/native-run-trace.js";
import { PROVIDER_TRACE_MAX_BYTES } from "../provider-trace-store.js";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { parseObject, asNumber } from "../../adapters/utils.js";
import { NativeRunnerOwnershipUnverifiedError } from "../native-runtime/native-runner-ownership.js";
import {
  ensureGitWorktreeBranchCoherent,
  formatManagedGitWorktreeBranchInspection,
  inspectManagedGitWorktreeBranch,
} from "../workspace-runtime.js";
import {
  blockRunnerGoalRecovery,
  failRunnerGoalAction,
  isRunnerGoalActionCompleted,
  settleLiveRunnerGoalBeforeInterrupt,
} from "../runner-goals.js";
import type { Db, agents, executionWorkspaces } from "@paperclipai/db";
import type { AdapterExecutionContext, ServerAdapterModule } from "../../adapters/index.js";
import type { HeartbeatRuntimeSelectionInput, HeartbeatRuntimeSelectionResult } from "./runtime-selection.js";
import type { createHeartbeatRunState } from "./run-state.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import type { createHeartbeatRunControl } from "./run-control.js";
import type { createHeartbeatQueue } from "./queue.js";
import type { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import type { createAdapterExecutionControl } from "../adapter-execution-control.js";
import type { executionWorkspaceService } from "../execution-workspaces.js";
import type { workspaceOperationService } from "../workspace-operations.js";
import type { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import type { instanceSettingsService } from "../instance-settings.js";
import type { EffectiveRunSessionConfigMetadata } from "./workspaces.js";
import type { ProviderResourceDisposition } from "../environment-runtime.js";
import type { NativeExecutionInput, NativeSessionBackend } from "../../vendor/paperclip-runner/index.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import type { RealizedExecutionWorkspace } from "../workspace-runtime.js";
import type { reserveWarmNativeInstructionDirectory } from "../native-runtime/index.js";

type Selection = HeartbeatRuntimeSelectionInput;
type Selected = Extract<HeartbeatRuntimeSelectionResult, { selected: true }>;
type NativeSessionInput = Parameters<typeof executePaperclipNativeSession>[0];
type RunState = ReturnType<typeof createHeartbeatRunState>;
type Lifecycle = ReturnType<typeof createHeartbeatLifecycle>;

/** Dispatches a prepared run; admission and terminal run status remain owned by the executor. */
export interface HeartbeatRuntimeExecutionInput {
  run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect;
  options: {
    nativeSessionBackendFactory?: (execution: NativeExecutionInput) => NativeSessionBackend;
    pluginWorkerManager?: PluginWorkerManager;
  };
  task: Pick<Selection["task"], "issueContext" | "context" | "executionContinuation"> & {
    issueRef: (NonNullable<Selection["task"]["issueRef"]> & { projectId: string | null }) | null;
    issueId: string | null;
    taskKey: string | null;
  };
  runtime: Pick<Selected, "nativeExecution" | "nativeRunnerInstanceId" | "getNativeFreshSessionHandoff"> & {
    nativeRuntimeResolution: Selection["nativeRuntimeResolution"];
    adapter: ServerAdapterModule;
    runtimeForAdapter: AdapterExecutionContext["runtime"];
    getFreshSessionHandoff: AdapterExecutionContext["getFreshSessionHandoff"];
    runOptions: Selection["recovery"];
  };
  workspace: {
    persistedExecutionWorkspace: typeof executionWorkspaces.$inferSelect | null;
    executionWorkspace: RealizedExecutionWorkspace;
    executionTarget: Selection["workspace"]["executionTarget"];
    workspaceOperationRecorder: ReturnType<ReturnType<typeof workspaceOperationService>["createRecorder"]>;
    nativeWorkspaceSync: Selected["nativeWorkspaceSync"];
    workspaceRestoreSource: Parameters<typeof recordLegacyWorkspaceRestoreFailure>[3];
    remoteExecution: unknown;
  };
  config: Pick<Selection["config"], "runtimeConfig" | "resolvedConfig" | "managedAiRuntime"> & {
    resolvedInstanceSettings: { experimental: Pick<Awaited<ReturnType<ReturnType<typeof instanceSettingsService>["getExperimental"]>>, "enableWorkspaceBranchReconcileForward" | "enableWorkspaceDirtyQuarantineRepair"> };
    configuredTaskEnvironment: Parameters<typeof configuredEnvironmentProjection>[0];
    adapterEnv: Parameters<typeof buildNativeProviderEnvironment>[0];
    agentIdentity: AdapterExecutionContext["agentIdentity"];
    runtimeEnv: Selection["runtimeEnv"];
    useHostGitHub: boolean;
    githubSelection: { configured: boolean };
  };
  session: {
    runtimeSessionParamsForAdapter: Record<string, unknown> | null;
    configuredModel: string | null;
    sessionConfigMetadata: EffectiveRunSessionConfigMetadata;
    goalCheckpointSession: { current: { params: Record<string, unknown>; displayId: string } | null };
  };
  instructions: {
    // Instruction callbacks can replace the copy and receipt while a provider is running.
    readonly instructionCopy: Selection["config"]["instructionCopy"];
    getInstructionSave: () => Record<string, unknown> | null;
    nativeInstructionWorkingCopy: () => NativeSessionInput["instructionWorkingCopy"];
    collectStoppedInstructions: AdapterExecutionContext["onProviderStopped"];
    nativeInstructionReservation: Awaited<ReturnType<typeof reserveWarmNativeInstructionDirectory>>;
    releaseInstructionCopy: () => Promise<void>;
  };
  trace: {
    providerTraceCapture: { path: string } | null;
    nativeRunnerPreparationSpans: NonNullable<NativeSessionInput["preparationSpans"]>;
    attestedQuestionResponseAtMs: Parameters<typeof buildNativeWakeIngressSpan>[0]["attestedQuestionResponseAtMs"];
    attemptStartedAtMs: number;
    environmentAcquireStartedAtMs: number;
    environmentRealizeEndedAtMs: number;
  };
  control: {
    executionControl: ReturnType<typeof createAdapterExecutionControl>;
    executionPhaseContext: Parameters<typeof withAdapterExecutionPhase>[0];
    dispatchResolvedInteractionContinuationWithAtomicGate: <T>(dispatch: (markDispatchStarted: () => void) => Promise<T>) => Promise<
      { dispatched: true; resultPromise: Promise<T> } | { dispatched: false }
    >;
  };
  output: Pick<AdapterExecutionContext, "onLog"> & {
    onAdapterEvent: NonNullable<AdapterExecutionContext["onEvent"]>;
    onAdapterMeta: AdapterExecutionContext["onMeta"];
    identityRedactor: ReturnType<typeof createAgentIdentityRedactor>;
    appendIdentityRedactedLog: AdapterExecutionContext["onLog"];
  };
  services: Pick<RunState, "upsertTaskSession" | "getRun"> &
    Pick<Lifecycle, "persistRunProcessMetadata" | "recordCurrentHeartbeatRunRuntimeProgress"> &
    Pick<ReturnType<typeof createHeartbeatRunControl>, "cancelRunInternal"> &
    Pick<ReturnType<typeof createHeartbeatQueue>, "enqueueWakeup" | "dispatchPendingNativeStatusWakeups"> & {
    executionWorkspacesSvc: Pick<ReturnType<typeof executionWorkspaceService>, "getById">;
    instanceSettings: Pick<ReturnType<typeof instanceSettingsService>, "getExperimental">;
    envOrchestrator: Pick<ReturnType<typeof environmentRunOrchestrator>, "releaseForRun">;
  };
  // Teardown must observe these updates immediately, including when execution later throws.
  effects: {
    onUsageCaptureReady: (persistFailure: () => Promise<void>) => void;
    onNativeDispatchStarted: () => void;
    onLegacyAdapterEntered: () => void;
    onWorkspaceRestoreFailure: (evidence: Record<string, unknown>) => void;
    onProviderResourceDisposition: (disposition: ProviderResourceDisposition) => void;
    onNativeWorkspaceFinalizeScheduled: () => void;
    onNativeSessionResumeScheduled: () => void;
    onNativeOwnershipHeld: () => void;
  };
}

export type HeartbeatRuntimeExecutionResult = { dispatched: false } | {
  dispatched: true;
  adapterResult: AdapterExecutionResult;
};

export class NativeSessionResumeScheduledError extends Error {
  constructor(readonly original: unknown) {
    super("Native session recovery has been scheduled for the same run.");
    this.name = "NativeSessionResumeScheduledError";
  }
}

export class NativeWorkspaceFinalizeScheduledError extends Error {
  constructor(
    readonly original: unknown,
    readonly terminalFailure: boolean,
    readonly reasonCode:
      "workspace_sync_out_failed" | "workspace_sync_out_unrecoverable",
  ) {
    super("Native workspace finalization recovery has been scheduled.");
    this.name = "NativeWorkspaceFinalizeScheduledError";
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function executeHeartbeatRuntime(db: Db, input: HeartbeatRuntimeExecutionInput): Promise<HeartbeatRuntimeExecutionResult> {
  const { run, agent, options } = input;
  const { issueRef, issueContext, context, issueId, taskKey, executionContinuation } = input.task;
  const { nativeRuntimeResolution, nativeExecution, nativeRunnerInstanceId, adapter, runtimeForAdapter, getNativeFreshSessionHandoff, getFreshSessionHandoff, runOptions } = input.runtime;
  const { persistedExecutionWorkspace, executionWorkspace, executionTarget, workspaceOperationRecorder, nativeWorkspaceSync, workspaceRestoreSource, remoteExecution } = input.workspace;
  const { runtimeConfig, resolvedConfig, resolvedInstanceSettings, configuredTaskEnvironment, adapterEnv, agentIdentity, managedAiRuntime, runtimeEnv, useHostGitHub, githubSelection } = input.config;
  const { runtimeSessionParamsForAdapter, configuredModel, sessionConfigMetadata, goalCheckpointSession } = input.session;
  const { nativeInstructionWorkingCopy, collectStoppedInstructions, nativeInstructionReservation, releaseInstructionCopy } = input.instructions;
  const { providerTraceCapture, nativeRunnerPreparationSpans, attestedQuestionResponseAtMs, attemptStartedAtMs, environmentAcquireStartedAtMs, environmentRealizeEndedAtMs } = input.trace;
  const { executionControl, executionPhaseContext, dispatchResolvedInteractionContinuationWithAtomicGate } = input.control;
  const { identityRedactor, appendIdentityRedactedLog, onLog, onAdapterEvent, onAdapterMeta } = input.output;
  const { executionWorkspacesSvc, instanceSettings, envOrchestrator, upsertTaskSession, getRun, cancelRunInternal, enqueueWakeup, persistRunProcessMetadata, recordCurrentHeartbeatRunRuntimeProgress, dispatchPendingNativeStatusWakeups } = input.services;
  const localAgentJwtScope =
    issueRef?.workMode === "skill_test"
      ? { kind: "skill_test" as const, issueId: issueRef.id }
      : { kind: "standard" as const };
  const authToken =
    nativeRuntimeResolution.kind === "legacy" &&
    adapter.supportsLocalAgentJwt
      ? createLocalAgentJwt(
          agent.id,
          agent.companyId,
          agent.adapterType,
          run.id,
          run.responsibleUserId,
          localAgentJwtScope,
        )
      : null;
  if (
    nativeRuntimeResolution.kind === "legacy" &&
    adapter.supportsLocalAgentJwt &&
    !authToken
  ) {
    logger.warn(
      {
        companyId: agent.companyId,
        agentId: agent.id,
        runId: run.id,
        adapterType: agent.adapterType,
      },
      "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
    );
  }
  let adapterFinalizeOutcome: "succeeded" | "failed" | null = null;
  const inspectFinalizeWorkspaceBranch = async () => {
    const workspaceRecord = persistedExecutionWorkspace?.id
      ? await executionWorkspacesSvc.getById(
          persistedExecutionWorkspace.id,
        )
      : persistedExecutionWorkspace;
    if (workspaceRecord?.strategyType !== "git_worktree") return null;

    const worktreePath =
      readNonEmptyString(workspaceRecord.providerRef) ??
      readNonEmptyString(workspaceRecord.cwd) ??
      readNonEmptyString(executionWorkspace.worktreePath) ??
      readNonEmptyString(executionWorkspace.cwd);
    const expectedBranchName =
      readNonEmptyString(workspaceRecord.branchName) ??
      readNonEmptyString(executionWorkspace.branchName);
    if (!worktreePath || !expectedBranchName) return null;

    const inspection = await inspectManagedGitWorktreeBranch({
      worktreePath,
      expectedBranchName,
    });
    return { workspaceRecord, inspection };
  };
  const recordWorkspaceFinalize = async (
    status: "succeeded" | "failed",
    metadata?: Record<string, unknown>,
    restore?: () => Promise<void>,
  ) => {
    if (adapterFinalizeOutcome) return;
    await workspaceOperationRecorder.recordOperation({
      phase: "workspace_finalize", cwd: executionWorkspace.cwd,
      metadata: { adapterType: agent.adapterType, executionTargetKind: executionTarget?.kind ?? "local",
        ...(restore ? { owningService: "native_workspace_finalizer" } : {}), ...metadata },
      run: async () => {
        await restore?.();
        let finalizeBranchMetadata: Record<string, unknown> | null = null;
        let finalizeBranchRepairMetadata: Record<string, unknown> | null =
          null;
        if (status === "succeeded") {
          const branchInspection = await inspectFinalizeWorkspaceBranch();
          if (branchInspection) {
            let inspection = branchInspection.inspection;
            const initialManagedGitWorktreeBranch =
              formatManagedGitWorktreeBranchInspection(inspection);
            if (
              !inspection.valid &&
              inspection.reasonCode === "branch_mismatch" &&
              inspection.repoRoot
            ) {
              let repairedExpectedBranchName = inspection.expectedBranchName;
              try {
                const coherence = await ensureGitWorktreeBranchCoherent({
                  db,
                  repoRoot: inspection.repoRoot,
                  worktreePath: inspection.worktreePath,
                  expectedBranchName: inspection.expectedBranchName,
                  actualBranchName: inspection.actualBranchName,
                  sourceIssue: issueRef
                    ? {
                        id: issueRef.id,
                        identifier: issueRef.identifier,
                        title: issueRef.title,
                        workMode: issueRef.workMode,
                      }
                    : null,
                  executionWorkspaceId: branchInspection.workspaceRecord.id,
                  heartbeatRunId: run.id,
                  enableWorkspaceBranchReconcileForward:
                    resolvedInstanceSettings.experimental
                      .enableWorkspaceBranchReconcileForward,
                  enableWorkspaceDirtyQuarantineRepair:
                    resolvedInstanceSettings.experimental
                      .enableWorkspaceDirtyQuarantineRepair,
                  persistForwardReconcile: false,
                  reconcileOperationPhase: "workspace_finalize",
                  recorder: workspaceOperationRecorder,
                });
                if (
                  coherence.branchName &&
                  coherence.branchName !==
                    branchInspection.workspaceRecord.branchName
                ) {
                  repairedExpectedBranchName = coherence.branchName;
                  executionWorkspace.branchName = coherence.branchName;
                  executionWorkspace.warnings.push(...coherence.warnings);
                }
              } catch (repairErr) {
                const workspaceValidationFailure =
                  isWorkspaceValidationFailure(repairErr) ? repairErr : null;
                finalizeBranchMetadata = {
                  executionWorkspaceId: branchInspection.workspaceRecord.id,
                  ...initialManagedGitWorktreeBranch,
                };
                finalizeBranchRepairMetadata = {
                  attempted: true,
                  succeeded: false,
                  initial: initialManagedGitWorktreeBranch,
                  reason:
                    repairErr instanceof Error
                      ? repairErr.message
                      : String(repairErr),
                };
                await workspaceOperationRecorder.recordOperation({
                  phase: "workspace_finalize",
                  cwd: executionWorkspace.cwd,
                  metadata: {
                    adapterType: agent.adapterType,
                    executionTargetKind: executionTarget?.kind ?? "local",
                    ...metadata,
                    managedGitWorktreeBranch: finalizeBranchMetadata,
                    managedGitWorktreeBranchRepair:
                      finalizeBranchRepairMetadata,
                    ...(workspaceValidationFailure?.resultJson
                      ? {
                          workspaceValidation:
                            workspaceValidationFailure.resultJson
                              .workspaceValidation ??
                            workspaceValidationFailure.resultJson,
                        }
                      : {}),
                  },
                  run: async () => ({
                    status: "failed",
                    stderr: `Managed git worktree branch check failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}\n`,
                  }),
                });
                adapterFinalizeOutcome = "failed";
                throw repairErr;
              }

              const repairedInspection =
                await inspectManagedGitWorktreeBranch({
                  worktreePath: inspection.worktreePath,
                  expectedBranchName: repairedExpectedBranchName,
                  repoRoot: inspection.repoRoot,
                });
              finalizeBranchRepairMetadata = {
                attempted: true,
                succeeded: repairedInspection.valid,
                initial: initialManagedGitWorktreeBranch,
                repaired:
                  formatManagedGitWorktreeBranchInspection(
                    repairedInspection,
                  ),
              };
              inspection = repairedInspection;
            }

            const managedGitWorktreeBranch =
              formatManagedGitWorktreeBranchInspection(inspection);
            finalizeBranchMetadata = {
              executionWorkspaceId: branchInspection.workspaceRecord.id,
              ...managedGitWorktreeBranch,
            };
            if (!inspection.valid) {
              const workspaceValidationFingerprint =
                fingerprintFinalizeWorkspaceBranchValidation({
                  issueId: issueRef?.id ?? null,
                  executionWorkspaceId: branchInspection.workspaceRecord.id,
                  inspection: managedGitWorktreeBranch,
                });
              await workspaceOperationRecorder.recordOperation({
                phase: "workspace_finalize",
                cwd: executionWorkspace.cwd,
                metadata: {
                  adapterType: agent.adapterType,
                  executionTargetKind: executionTarget?.kind ?? "local",
                  ...metadata,
                  managedGitWorktreeBranch: finalizeBranchMetadata,
                  ...(finalizeBranchRepairMetadata
                    ? {
                        managedGitWorktreeBranchRepair:
                          finalizeBranchRepairMetadata,
                      }
                    : {}),
                },
                run: async () => ({
                  status: "failed",
                  stderr: `Managed git worktree branch check failed: ${inspection.reason ?? "unknown branch mismatch"}\n`,
                }),
              });
              adapterFinalizeOutcome = "failed";
              throw new WorkspaceValidationFailure(
                `Execution workspace ${branchInspection.workspaceRecord.id} expected git worktree branch "${inspection.expectedBranchName}" at "${inspection.worktreePath}", but ${inspection.reason ?? "the checked-out branch could not be verified"}. Record a sanctioned execution-workspace branch transition or restore the workspace branch before completing the run.`,
                {
                  workspaceValidation: {
                    reason: "git_worktree_branch_incoherence",
                    fingerprint: workspaceValidationFingerprint,
                    adapterType: agent.adapterType,
                    issueId: issueRef?.id ?? null,
                    issueIdentifier: issueRef?.identifier ?? null,
                    persistedExecutionWorkspaceId:
                      branchInspection.workspaceRecord.id,
                    executionWorkspaceCwd: executionWorkspace.cwd,
                    managedGitWorktreeBranch: finalizeBranchMetadata,
                  },
                },
              );
            }
          }
        }
        return { status, metadata: {
          ...(finalizeBranchMetadata ? { managedGitWorktreeBranch: finalizeBranchMetadata } : {}),
          ...(finalizeBranchRepairMetadata ? { managedGitWorktreeBranchRepair: finalizeBranchRepairMetadata } : {}),
        } };
      },
    });
    // Only mark the outcome after the row landed, so a transient write
    // failure on the succeeded path can still be recovered by recording
    // finalize=failed from the catch path below.
    adapterFinalizeOutcome = status;
  };

  const usageRecorder = await createRunUsageRecorder(db, { companyId: run.companyId, runId: run.id, adapterType: agent.adapterType });
  input.effects.onUsageCaptureReady(usageRecorder.persistFailure);
  let adapterResult: AdapterExecutionResult;
  const runGoalControlRequestId = readNonEmptyString(
    context.goalControlRequestId,
  );
  try {
    if (nativeRuntimeResolution.kind === "native") {
      if (!nativeExecution || !nativeRunnerInstanceId)
        throw new Error("native_runtime_selection_not_persisted");
      const expectedNativeMcpDigest =
        "runtimeContext" in nativeExecution &&
        nativeExecution.runtimeContext.mcp.bindingId
          ? nativeExecution.runtimeContext.mcp.digest
          : null;
      const nativeMcpServers = await buildPaperclipRuntimeMcpServers({
        db,
        agent,
        runId: run.id,
        expectedAssignmentDigest: expectedNativeMcpDigest,
      });
      if ("runtimeContext" in nativeExecution) {
        if (nativeMcpServers.length > 1)
          throw new Error(
            "native MCP realization must produce one aggregate gateway",
          );
        const server = nativeMcpServers[0] ?? null;
        const digest = server?.connectionId.startsWith("assignment:")
          ? server.connectionId.slice("assignment:".length)
          : null;
        if (digest && digest !== expectedNativeMcpDigest) {
          throw new Error("native MCP assignment digest mismatch");
        }
      }
      const nativeMcpServer = nativeMcpServers[0] ?? null;
      let sessionGoalControl = parseNativeSessionGoalControl(
        context.runnerGoalControl,
      );
      if (runGoalControlRequestId && !sessionGoalControl) {
        throw new Error("session_goal_control_payload_invalid");
      }
      // A hard restart replays the heartbeat context, not a new user
      // action. Do not repeat a completed create/replace/edit (which
      // could reactivate or clear a goal that finished while detached).
      const completedGoalControl =
        sessionGoalControl !== null &&
        taskKey !== null &&
        (await isRunnerGoalActionCompleted(
          db,
          {
            companyId: agent.companyId,
            agentId: agent.id,
            issueId: taskKey,
          },
          sessionGoalControl.requestId,
        ));
      if (completedGoalControl) sessionGoalControl = null;
      const nativeDispatchAtMs = Date.now();
      const runCreatedAtMs = run.createdAt.getTime();
      const runStartedAtMs = (run.startedAt ?? run.createdAt).getTime();
      const wakeComments = Array.isArray(
        parseObject(context.paperclipWake).comments,
      )
        ? (parseObject(context.paperclipWake).comments as unknown[])
        : [];
      const wakeIngressSpan = buildNativeWakeIngressSpan({
        runCreatedAtMs,
        wakeComments,
        attestedQuestionResponseAtMs,
      });
      if (wakeIngressSpan)
        nativeRunnerPreparationSpans.unshift(wakeIngressSpan);
      nativeRunnerPreparationSpans.push(
        ...buildNativeHeartbeatPreparationSpans({
          runCreatedAtMs,
          runStartedAtMs,
          attemptStartedAtMs,
          environmentAcquireStartedAtMs,
          environmentRealizeEndedAtMs,
          nativeDispatchAtMs,
        }),
      );
      const guardedDispatch =
        await dispatchResolvedInteractionContinuationWithAtomicGate(
          (markDispatchStarted) => {
            return executePaperclipNativeSession({
              db,
              execution: nativeExecution,
              getFreshSessionHandoff: getNativeFreshSessionHandoff,
              refreshTools: context.refreshTools === true,
              conversationMode: isConversation(issueContext),
              turnTimeoutMs: Math.max(0, asNumber(runtimeConfig.timeoutSec, 0)) * 1_000,
              runnerInstanceId: nativeRunnerInstanceId,
              leaseOwner: runOptions.nativeLeaseOwner,
              restartRecovery: runOptions.nativeRestartRecovery,
              backend:
                options.nativeSessionBackendFactory?.(nativeExecution),
              useRunnerd: agent.adapterType === "paperclip_runner",
              adapterType: agent.adapterType,
              sessionGoalControl,
              resumeSessionGoalHeartbeat:
                context.resumeSessionGoalHeartbeat === true ||
                completedGoalControl,
              onGoalCheckpoint: async (snapshot) => {
                if (!taskKey) return;
                const params =
                  attachPaperclipSessionMetadataToSessionParams(
                    {
                      ...runtimeSessionParamsForAdapter,
                      sessionId: snapshot.identity.sessionId,
                      cwd: executionWorkspace.cwd,
                    },
                    configuredModel,
                    sessionConfigMetadata,
                  )!;
                const displayId =
                  snapshot.providerSessionId ?? snapshot.sessionId;
                await upsertTaskSession({
                  companyId: agent.companyId,
                  agentId: agent.id,
                  adapterType: agent.adapterType,
                  taskKey,
                  sessionParamsJson: params,
                  sessionDisplayId: displayId,
                  lastRunId: run.id,
                  lastError: null,
                });
                goalCheckpointSession.current = { params, displayId };
              },
              onLog,
              onEvent: onAdapterEvent,
              instructionWorkingCopy: nativeInstructionWorkingCopy(),

              onUsage: async receipt => { await usageRecorder.capture(receipt); },
              preparationSpans: nativeRunnerPreparationSpans,
              // Bootstrap with executable/home discovery while keeping
              // configured provider values and the server-selected
              // workspace boundary authoritative.
              managedGitHub: !useHostGitHub && githubSelection.configured,
              billingIdentity: managedAiRuntime ? { provider: managedAiRuntime.attribution.provider, biller: managedAiRuntime.attribution.provider === "openai" ? resolveManagedOpenAiBilling(managedAiRuntime.config.managedAiRouting)?.biller ?? managedAiRuntime.attribution.provider : managedAiRuntime.attribution.provider, billingType: managedAiRuntime.attribution.method === "subscription" ? "subscription_included" : "metered_api" } : undefined,
              managedAiCredentialIdentity: managedAiRuntime?.identity,
              managedAiCredentialHome: managedAiRuntime ? String((managedAiRuntime.config.env as Record<string, unknown>).CODEX_HOME) : undefined,
              dotWorkspaceRoot: nativeExecution.provider.kind === "openai_dot" && resolvedConfig.dotWorkspaceAccess === true ? executionWorkspace.cwd : undefined,
              runnerEnvironment: {
                ...configuredEnvironmentProjection(configuredTaskEnvironment),
                ...buildNativeProviderEnvironment(
                  adapterEnv,
                  process.env,
                  executionWorkspace.cwd,
                ),
                ...buildAgentIdentityEnv(agentIdentity),
                ...(input.instructions.instructionCopy && isAgentDirectoryCopy(input.instructions.instructionCopy) ? { AGENT_HOME: input.instructions.instructionCopy.executionRoot } : {}),
                ...(nativeMcpServer
                  ? {
                      PAPERCLIP_NATIVE_MCP_NAME: nativeMcpServer.name,
                      PAPERCLIP_NATIVE_MCP_URL: nativeMcpServer.url,
                      PAPERCLIP_NATIVE_MCP_TOKEN: nativeMcpServer.token,
                    }
                  : {}),
                ...(providerTraceCapture
                  ? {
                      PAPERCLIP_PROVIDER_TRACE_PATH:
                        providerTraceCapture.path,
                      PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(
                        PROVIDER_TRACE_MAX_BYTES,
                      ),
                    }
                  : {}),
              },
              runnerExecutionTarget: executionTarget,
              runnerIngressAuthorized: isRunnerIngressAuthorized(
                nativeRuntimeResolution,
              ),
              runnerPublicUrl:
                runtimeEnv.PAPERCLIP_RUNNER_PUBLIC_URL?.trim() || null,
              runnerCaBundlePath:
                runtimeEnv.PAPERCLIP_RUNNER_CA_BUNDLE_PATH?.trim() ||
                null,
              runnerRemoteBinaryPath:
                runtimeEnv.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH?.trim() ||
                null,
              runnerRemoteCodexPath:
                runtimeEnv.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH?.trim() ||
                null,
              runnerRemoteCodexNpmSpec:
                runtimeEnv.PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC?.trim() ||
                null,
              runnerRemoteProviderPackPath:
                runtimeEnv.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH?.trim() ||
                null,
              stopTaskForReassignment: async (target) => {
                await settleLiveRunnerGoalBeforeInterrupt(db, target);
                if (!target.runId) return;
                const prior = await getRun(target.runId);
                if (!prior || prior.companyId !== target.companyId || prior.agentId !== target.agentId) {
                  throw conflict("Reassignment run binding changed");
                }
                const stopped = await cancelRunInternal(target.runId, "Cancelled for task reassignment", {
                  errorCode: "issue_reassigned", suppressImmediateRecovery: true,
                  resultJson: { reassignmentStopConfirmed: true },
                });
                if (stopped && ["running", "queued", "scheduled_retry"].includes(stopped.status)) {
                  throw conflict("The previous run did not stop; reassignment was not applied");
                }
              },
              enqueueWakeup,
              syncIssueExternalObjects: externalObjectService(db, {
                pluginWorkerManager: options.pluginWorkerManager,
                enabled: async () => (await instanceSettings.getExperimental()).enableExternalObjects === true,
              }).syncIssueSafely,
              onSpawn: async (meta) => {
                markDispatchStarted();
                await persistRunProcessMetadata(run.id, { ...meta, targetKind: executionTarget?.kind ?? "local" });
              },
            });
          },
        );
      if (!guardedDispatch.dispatched) return { dispatched: false };
      input.effects.onNativeDispatchStarted();
      adapterResult = await guardedDispatch.resultPromise;
    } else {
      const interactionId = readNonEmptyString(context.interactionId);
      const legacyQuestionResponse =
        issueRef &&
        interactionId &&
        readNonEmptyString(context.interactionKind) ===
          "ask_user_questions" &&
        readNonEmptyString(context.interactionStatus) === "answered"
          ? await materializeLegacyQuestionResponseWakeProjection({
              db,
              companyId: agent.companyId,
              issueId: issueRef.id,
              runId: run.id,
              agentId: agent.id,
              interactionId,
            })
          : null;
      // Do not write the answer projection back to `context`: legacy
      // adapters need it in their prompt, but the authoritative answers
      // remain on the interaction instead of being duplicated in the
      // heartbeat run snapshot.
      const adapterContext: Record<string, unknown> = {
        ...context,
        ...(legacyQuestionResponse
          ? {
              [PAPERCLIP_WAKE_PAYLOAD_KEY]: {
                ...parseObject(context[PAPERCLIP_WAKE_PAYLOAD_KEY]),
                questionResponse: legacyQuestionResponse,
              },
            }
          : {}),
      };
      const runtimeTools = createAdapterRuntimeToolAccess({
        agentId: agent.id,
        companyId: agent.companyId,
        runId: run.id,
        responsibleUserId: run.responsibleUserId,
      });
      if (!runtimeTools) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
          },
          "runtime connection tools could not be delivered",
        );
      }
      const runtimeMcpServers = await buildPaperclipRuntimeMcpServers({
        db,
        agent,
        runId: run.id,
      });
      const runtimeToolDelivery =
        adapter.runtimeToolDelivery ?? "invocation_context";
      if (runtimeTools && runtimeToolDelivery === "native_mcp") {
        runtimeMcpServers.unshift({
          name: "Paperclip connections",
          url: runtimeTools.mcpEndpoint,
          token: runtimeTools.bearerToken,
          connectionId: "paperclip-runtime-tools",
        });
      }
      if (authToken && configuredPaperclipApiBaseUrl() && issueRef) {
        runtimeMcpServers.unshift({ name: "Paperclip projects", url: `${paperclipApiBaseUrl()}/api/mcp/project-tools`,
          token: authToken, connectionId: "paperclip-project-tools" });
      }
      const runtimeMcp = createAdapterRuntimeMcpAccess(runtimeMcpServers);
      if (runtimeTools && runtimeToolDelivery === "invocation_context") {
        adapterContext.paperclipRuntimeTools = runtimeTools;
      }
      const managedMcpConfig = await createManagedMcpRunConfig({
        db,
        agent,
        runId: run.id,
        config: runtimeConfig,
        projectId: issueRef?.projectId ?? null,
        issueId: issueRef?.id ?? null,
      });
      if (managedMcpConfig) {
        adapterContext.paperclipManagedMcp = managedMcpConfig;
      }
      const guardedDispatch =
        await dispatchResolvedInteractionContinuationWithAtomicGate(
          (markDispatchStarted) => {
            input.effects.onLegacyAdapterEntered();
            return withAdapterExecutionPhase(executionPhaseContext, "adapter_execution", () => adapter.execute({
              getFreshSessionHandoff,
              agentIdentity,
              runId: run.id,
              agent,
              runtime: runtimeForAdapter,
              config: runtimeConfig,
              context: adapterContext,
              executionContinuation: executionContinuation ?? null,
              runtimeCommandSpec:
                adapter.getRuntimeCommandSpec?.(runtimeConfig) ?? null,
              executionTarget,
              executionTransport: remoteExecution
                ? {
                    remoteExecution: remoteExecution as unknown as Record<
                      string,
                      unknown
                    >,
                  }
                : undefined,
              runtimeMcp,
              runtimeTools,
              onLog,
              onMeta: onAdapterMeta,
              onEvent: onAdapterEvent,
              onUsage: async receipt => { await usageRecorder.capture(receipt); },
              onExecutionPhase: executionControl.phases.enter,
              startupTraceContext: getStartupTraceContext(),
              onRuntimeProgress: async (progress) => {
                await recordCurrentHeartbeatRunRuntimeProgress(
                  run,
                  progress,
                  issueId,
                );
              },
              onProviderStopped: collectStoppedInstructions,
              onDispatch: markDispatchStarted,
              signal: executionControl.controller.signal,
              ...(executionTarget?.kind === "remote" && executionTarget.transport === "sandbox" ? {
                stopRemoteStartup: async () => {
                  // Scope comes from the running host invocation, never agent
                  // config. Keep adapter ownership until setup has unwound.
                  if (!executionControl.controller.signal.aborted) {
                    throw new Error("Remote startup stop requires a cancelled run");
                  }
                  const release = await envOrchestrator.releaseForRun({
                    heartbeatRunId: run.id,
                    companyId: agent.companyId,
                    agentId: agent.id,
                    status: "released",
                    providerResourceDisposition: "stop_and_retain",
                    cancelActiveWork: true,
                  });
                  if (release.errors.length || !await remoteExecutionHasStopped(db, agent.companyId, run.id)) {
                    throw new Error("Could not verify remote startup stopped");
                  }
                },
              } : {}),
              onCancellationReady: async () => {
                await registerAdapterExecutionControl(run.id, executionControl);
                const current = await getRun(run.id);
                if (!current || isHeartbeatRunTerminalStatus(current.status)) {
                  executionControl.controller.abort(new Error("Run stopped before provider startup"));
                }
              },
              onSpawn: async (meta) => {
                markDispatchStarted();
                await persistRunProcessMetadata(run.id, {
                  pid: meta.pid,
                  processGroupId:
                    "processGroupId" in meta &&
                    typeof meta.processGroupId === "number"
                      ? meta.processGroupId
                      : null,
                  startedAt: meta.startedAt,
                });
              },
              authToken: authToken ?? undefined,
            }));
          },
        );
      if (!guardedDispatch.dispatched) return { dispatched: false };
      adapterResult = await guardedDispatch.resultPromise;
    }
    adapterResult = identityRedactor.redact(adapterResult);
    if (run.runtimeMode === "legacy" && hasWorkspaceRestoreFailure(adapterResult.resultJson)
        && executionTarget?.kind === "remote" && executionTarget.transport === "sandbox") {
      const requiredWorkspaceRestoreEvidence = {
        workspaceRestoreFailure: adapterResult.resultJson!.workspaceRestoreFailure,
        ...(adapterResult.resultJson?.workspaceRestoreDiagnostic ? { workspaceRestoreDiagnostic: adapterResult.resultJson.workspaceRestoreDiagnostic } : {}),
      };
      input.effects.onWorkspaceRestoreFailure(requiredWorkspaceRestoreEvidence);
      // Retention is the fallback even if recording this receipt fails.
      input.effects.onProviderResourceDisposition("stop_and_retain");
      await recordLegacyWorkspaceRestoreFailure(db, run, requiredWorkspaceRestoreEvidence, workspaceRestoreSource);
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const tail = identityRedactor.finish(stream);
      if (tail) await appendIdentityRedactedLog(stream, tail);
    }
    const instructionSave = input.instructions.getInstructionSave();
    if (instructionSave) adapterResult.resultJson = { ...adapterResult.resultJson, instructionSave };

    if (parseObject(adapterResult.executionRecovery).providerWorkStarted !== false) {
      const captured = await usageRecorder.complete(adapterResult);
      adapterResult = { ...adapterResult, ...captured, usageComplete: captured.complete };
    } else {
      // Stop may already own the terminal result. Preserve its metadata
      // while durably recording the proof needed to release admission.
      await db.update(heartbeatRuns).set({ costAccountingPending: true,
        usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || '{"accountingProviderWorkStarted":false}'::jsonb`,
      }).where(and(eq(heartbeatRuns.id, run.id), isNull(heartbeatRuns.costAccountedAt)));
    }
    adapterResult = applyWorkspaceRestoreFailure(adapterResult);
    // A returned result can include a failed restore. Keep the workspace
    // barrier closed until required files have been restored.
    // If recording the barrier itself fails, propagate as a run failure
    // rather than silently leaving dependents stranded behind a missing
    // finalize row.
    const completeWorkspace = async (ownership?: NativeWorkspaceFinalizationOwnership) => {
      try {
        if (nativeWorkspaceSync) {
          const exported = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
            eq(workspaceOperations.companyId, run.companyId),
            eq(workspaceOperations.heartbeatRunId, run.id),
            eq(workspaceOperations.phase, "workspace_finalize"),
            eq(workspaceOperations.status, "succeeded"),
          )).limit(1);
          if (exported.length) adapterFinalizeOutcome = "succeeded";
          else await recordWorkspaceFinalize(hasWorkspaceRestoreFailure(adapterResult.resultJson) ? "failed" : "succeeded", undefined,
            async () => { await restoreNativeWorkspaceBestEffort({
              db, runId: run.id, assertOwnership: ownership?.assertHeld,
              restore: () => nativeWorkspaceSync!.restoreWorkspace(ownership?.assertHeld),
            }); });
        }
        await ownership?.assertHeld();
        await db
          .update(heartbeatRuns)
          .set({ executionControlDeadlineAt: new Date(Date.now() + 60_000) })
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.status, "running"),
            ),
          );
        const workspaceFinalizeStatus = hasWorkspaceRestoreFailure(adapterResult.resultJson) ? "failed" : "succeeded";
        await recordWorkspaceFinalize(workspaceFinalizeStatus);
        if (adapterResult.nativeFinalization) {
          adapterResult.nativeFinalization.workspaceFinalizeStatus =
            workspaceFinalizeStatus;
          try {
            const finalized = await finalizeNativeRun({
              db,
              runId: run.id,
              workspaceFinalizeStatus,
              preserveProviderAttempt: Boolean(nativeWorkspaceSync),
            });
            await dispatchPendingNativeStatusWakeups({
              companyId: run.companyId,
            });
            if (finalized.phase === "committed") {
              await nativeWorkspaceSync?.cleanup();
            }
          } catch (finalizeErr) {
            logger.warn(
              { err: finalizeErr, runId: run.id },
              "native result persisted but finalization did not apply; the reconciliation loop will retry",
            );
          }
        }
      } catch (error) {
        if (ownership) {
          await ownership.assertHeld();
          await recordWorkspaceFinalize("failed");
        }
        throw error;
      }
    };
    if (nativeWorkspaceSync) {
      const owned = await withNativeWorkspaceFinalizationOwnership({
        db, companyId: run.companyId, runId: run.id,
      }, completeWorkspace);
      if (!owned.acquired) throw new NativeWorkspaceFinalizationBusyError();
    } else {
      await completeWorkspace();
    }
  } catch (adapterErr) {
    if (adapterErr instanceof NativeCancellationPendingRecoveryError) {
      // Durable cancellation is settled by the outer recovery handler;
      // it does not imply a failed workspace or a persisted run result.
      throw adapterErr;
    }
    if (adapterErr instanceof NativeWorkspaceFinalizationBusyError
      || adapterErr instanceof NativeWorkspaceFinalizationOwnershipLostError) {
      input.effects.onNativeWorkspaceFinalizeScheduled();
      throw adapterErr;
    }
    if (adapterErr instanceof NativeControllerDetachedForRestartError) {
      // Preserve the provider and its run for the new controller. This
      // also keeps generic teardown from terminalizing/releasing its lease.
      input.effects.onNativeSessionResumeScheduled();
      throw adapterErr;
    }
    if (adapterErr instanceof NativeRunnerOwnershipUnverifiedError) {
      input.effects.onNativeOwnershipHeld();
      throw adapterErr;
    }
    await db
      .update(heartbeatRuns)
      .set({ executionControlDeadlineAt: new Date(Date.now() + 60_000) })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    if (
      issueRef &&
      context.resumeSessionGoalHeartbeat === true &&
      !runGoalControlRequestId
    ) {
      await blockRunnerGoalRecovery(
        db,
        {
          companyId: run.companyId,
          issueId: issueRef.id,
          agentId: agent.id,
          adapterType: agent.adapterType,
        },
        "provider_session_goal_recovery_failed",
      ).catch(() => undefined);
    }
    if (issueRef && runGoalControlRequestId) {
      await failRunnerGoalAction(
        db,
        {
          companyId: run.companyId,
          issueId: issueRef.id,
          agentId: agent.id,
          adapterType: agent.adapterType,
        },
        runGoalControlRequestId,
        adapterErr instanceof Error
          ? adapterErr.message
          : "session_goal_control_failed",
      ).catch(() => undefined);
    }
    const nativeResumeScheduled =
      nativeRuntimeResolution.kind === "native"
        ? await db
            .select({
              phase: nativeRunFinalizations.phase,
              resultId: nativeRunFinalizations.resultId,
            })
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, run.id))
            .limit(1)
            .then(
              (rows) =>
                rows[0]?.phase === "retryable_failure" &&
                rows[0]?.resultId === null,
            )
        : false;
    if (nativeResumeScheduled) {
      input.effects.onNativeSessionResumeScheduled();
      throw new NativeSessionResumeScheduledError(adapterErr);
    }
    // Adapter (or its restore finally) threw — or the finalize record
    // write itself threw. Either way the workspace may be in a partial
    // state. Best-effort record finalize=failed so the dependent readiness
    // check keeps the gate closed instead of waking on stale local state,
    // and surface the original error to the caller.
    try {
      await recordWorkspaceFinalize("failed", {
        errorMessage:
          adapterErr instanceof Error
            ? adapterErr.message
            : String(adapterErr),
      });
    } catch (recordErr) {
      logger.warn(
        {
          err: recordErr,
          runId: run.id,
          executionWorkspaceId: persistedExecutionWorkspace?.id ?? null,
        },
        "failed to record workspace_finalize=failed operation; dependents may remain gated",
      );
    }
    if (nativeRuntimeResolution.kind === "native") {
      const proposedResult = await db
        .select({ resultId: nativeRunFinalizations.resultId })
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, run.id))
        .limit(1)
        .then((rows) => rows[0]?.resultId ?? null);
      if (proposedResult && nativeWorkspaceSync) {
        const workspaceFailureMessage =
          adapterErr instanceof Error ? adapterErr.message : "";
        const unrecoverable =
          workspaceFailureMessage ===
            "workspace_sync_out_unrecoverable" ||
          workspaceFailureMessage.includes("daytona_sandbox_not_found");
        const failure = await recordNativeFinalizationFailure({
          db,
          runId: run.id,
          error: new Error(
            unrecoverable
              ? "native_workspace_sync_out_unrecoverable"
              : "native_workspace_sync_out_failed",
          ),
          projectRunStatus: true,
          failureScope: "workspace",
          permanent: unrecoverable,
        });
        input.effects.onNativeWorkspaceFinalizeScheduled();
        throw new NativeWorkspaceFinalizeScheduledError(
          adapterErr,
          failure.phase === "terminal_failure",
          unrecoverable
            ? "workspace_sync_out_unrecoverable"
            : "workspace_sync_out_failed",
        );
      }
      try {
        await finalizeNativeRun({
          db,
          runId: run.id,
          workspaceFinalizeStatus: "failed",
        });
        await dispatchPendingNativeStatusWakeups({
          companyId: run.companyId,
        });
      } catch (finalizeErr) {
        logger.warn(
          { err: finalizeErr, runId: run.id },
          "native result could not be marked workspace_failed; the reconciliation loop will retry persisted results",
        );
      }
    }
    throw adapterErr;
  } finally {
    try {
      await revokeHeartbeatRunGatewayTokens({
        db,
        companyId: agent.companyId,
        runId: run.id,
      });
    } catch (revokeErr) {
      logger.warn(
        { err: revokeErr, runId: run.id, companyId: agent.companyId },
        "failed to revoke heartbeat-run MCP gateway tokens",
      );
    }
    await nativeInstructionReservation?.release();
    await withAdapterExecutionPhase(executionPhaseContext, "instruction_cleanup", releaseInstructionCopy);
  }
  return { dispatched: true, adapterResult };
}
