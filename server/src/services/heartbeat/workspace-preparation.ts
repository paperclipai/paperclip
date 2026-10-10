import {
  resolveWorkspaceAfterLowTrustPreflight,
  WorkspaceValidationFailure,
  stripHostWorkspaceProvisionForLowTrustSandbox,
  assertGitWorktreeBaseWorkspaceReady,
  buildEffectiveRunWorkspaceConfigMetadata,
  resolveExecutionWorkspaceConfigFreshness,
  resolveExecutionWorkspaceReuseProvisioningPolicy,
  provisionExecutionWorkspaceForFreshnessDecision,
  mergeExecutionWorkspaceMetadataForPersistence,
  resolveExecutionWorkspaceBranchOwnership,
  reconcileReusedExecutionWorkspaceProjectWorkspaceId,
  recordWorkspaceConfigFreshnessOperation,
  prepareProjectRepositoryWorkspaces,
} from "./workspaces.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { type ExecutionWorkspace } from "@paperclipai/shared";
import { heartbeatRuns, projectWorkspaces } from "@paperclipai/db";
import { getStartupTracer } from "../../instrumentation.js";
import { createHostDuplexObservabilityRecorder } from "../duplex-observability-recorder.js";
import { incrementToolRuntimeMetricCounter } from "../tool-runtime-metrics.js";
import { logger } from "../../middleware/logger.js";
import { createGitRemoteAuthProvider } from "../git-credentials.js";
import { readNativeWorkspaceSyncReference } from "../native-runtime/index.js";
import { parseObject } from "../../adapters/utils.js";
import { materializeNativeChatTaskRoot } from "../native-runtime/native-chat-workspace.js";
import { materializeIsolatedTaskDirectory } from "../isolated-task-directory.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  realizeExecutionWorkspace,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
} from "../workspace-runtime.js";
import {
  readManagedWorktreeInstanceOwnership,
  WORKTREE_INSTANCE_ROOT_METADATA_KEY,
} from "../workspace-instance-cleanup.js";
import { isRuntimeOwnedGitBranch } from "../execution-workspace-branch-ownership.js";
import {
  issueExecutionWorkspaceModeForPersistedWorkspace,
  resolveEffectiveWorkspaceStrategyType,
} from "../execution-workspace-policy.js";
import { evaluateExecutionAllowlist } from "../execution-allowlist.js";
import type { Db, agents } from "@paperclipai/db";
import type {
  Environment,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspacePolicy,
} from "@paperclipai/shared";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import type { NativeRunHistoricalSpan } from "../native-runtime/native-run-trace.js";
import type { NativeRestartRecoveryClaim } from "../native-runtime/index.js";
import type { NativeChatWorkspaceScope } from "../native-runtime/native-chat-workspace.js";
import type { TrustPresetResolution } from "../trust-preset-resolver.js";
import type { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import type { instanceSettingsService } from "../instance-settings.js";
import type { executionWorkspaceService, TaskWorkspaceBindingPatch } from "../execution-workspaces.js";
import type { workspaceOperationService } from "../workspace-operations.js";
import type { watchLegacyControllerLease } from "../legacy-controller-lease.js";
import type {
  createHeartbeatWorkspaceResolver,
  resolveExecutionWorkspaceReuseRequestForIssue,
} from "./workspaces.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import type {
  ParsedExecutionWorkspaceMode,
  ExecutionWorkspaceEnvironmentResolution,
} from "../execution-workspace-policy.js";

type WorkspaceResolver = ReturnType<typeof createHeartbeatWorkspaceResolver>;
type WorkspaceMetadataInput = Parameters<typeof buildEffectiveRunWorkspaceConfigMetadata>[0];

/** Prepares the workspace and environment; dispatch and terminal lease release stay with the caller. */
export interface HeartbeatWorkspacePreparationInput {
  run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect;
  task: {
    issueRef: (NonNullable<Parameters<typeof realizeExecutionWorkspace>[0]["issue"]> & {
      projectId: string | null;
      projectWorkspaceId: string | null;
      executionWorkspaceId: string | null;
      executionWorkspacePreference: string | null;
    }) | null;
    issueId: string | null;
    context: Record<string, unknown>;
    responsibleUserId: string | null;
    previousSessionParams: Record<string, unknown> | null;
  };
  policy: {
    trustPreset: TrustPresetResolution;
    isolatedWorkspacesEnabled: boolean;
    effectiveExecutionWorkspaceMode: ParsedExecutionWorkspaceMode;
    requestedExecutionWorkspaceMode: ParsedExecutionWorkspaceMode;
    useIsolatedTaskDirectory: boolean;
    nativeChatWorkspaceScope: NativeChatWorkspaceScope | null;
    projectExecutionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
    issueExecutionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
    environmentExecutionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
    executionPolicy: Parameters<typeof evaluateExecutionAllowlist>[0];
  };
  environment: {
    selectedEnvironmentId: string;
    localEnvironment: Environment;
    selectedEnvironmentForConfig: Environment | null;
    environmentResolution: ExecutionWorkspaceEnvironmentResolution;
    resolvedInstanceSettings: Awaited<ReturnType<ReturnType<typeof instanceSettingsService>["get"]>>;
  };
  config: {
    mergedConfig: Record<string, unknown>;
    configSnapshot: WorkspaceMetadataInput["configSnapshot"];
    secretManifest: WorkspaceMetadataInput["secretManifest"];
  };
  reuse: {
    requestedShouldReuseExisting: boolean;
    existingExecutionWorkspace: ExecutionWorkspace | null;
    reusableExistingExecutionWorkspace: ExecutionWorkspace | null;
    workspaceReuseRequest: ReturnType<typeof resolveExecutionWorkspaceReuseRequestForIssue>;
    nativeRecoveryExecutionWorkspaceId: string | null;
    persistedNativeExecutionInput: NativeExecutionInput | null;
    isDotRun: boolean;
    runOptions: { nativeRestartRecovery?: NativeRestartRecoveryClaim };
  };
  services: {
    envOrchestrator: Pick<ReturnType<typeof environmentRunOrchestrator>, "resolveEnvironment" | "acquireForRun" | "realizeForRun">;
    executionWorkspacesSvc: Pick<ReturnType<typeof executionWorkspaceService>, "create" | "update" | "bindTaskWorkspace" | "prepareTaskRepositoriesForAdmission">;
    workspaceOperationsSvc: Pick<ReturnType<typeof workspaceOperationService>, "createRecorder">;
    resolveWorkspaceForRun: WorkspaceResolver["resolveWorkspaceForRun"];
    resolveReusedGitWorkspaceAnchor: WorkspaceResolver["resolveReusedGitWorkspaceAnchor"];
    appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
  };
  controllerLease: Pick<ReturnType<typeof watchLegacyControllerLease>, "assertOwned">;
  nativeRunnerPreparationSpans: NativeRunHistoricalSpan[];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function prepareHeartbeatWorkspace(db: Db, input: HeartbeatWorkspacePreparationInput) {
  const { run, agent, controllerLease, nativeRunnerPreparationSpans } = input;
  const {
    issueRef,
    issueId,
    context,
    responsibleUserId,
    previousSessionParams,
  } = input.task;
  const {
    trustPreset,
    isolatedWorkspacesEnabled: runtimeWorkspaceSelectionEnabled,
    effectiveExecutionWorkspaceMode,
    requestedExecutionWorkspaceMode,
    useIsolatedTaskDirectory,
    nativeChatWorkspaceScope,
    projectExecutionWorkspacePolicy,
    issueExecutionWorkspaceSettings,
    environmentExecutionWorkspaceSettings,
    executionPolicy,
  } = input.policy;
  const {
    selectedEnvironmentId,
    localEnvironment,
    selectedEnvironmentForConfig,
    environmentResolution,
    resolvedInstanceSettings,
  } = input.environment;
  const { mergedConfig, configSnapshot, secretManifest } = input.config;
  const {
    requestedShouldReuseExisting,
    existingExecutionWorkspace,
    reusableExistingExecutionWorkspace,
    workspaceReuseRequest,
    nativeRecoveryExecutionWorkspaceId,
    persistedNativeExecutionInput,
    isDotRun,
    runOptions,
  } = input.reuse;
  const {
    envOrchestrator,
    executionWorkspacesSvc,
    workspaceOperationsSvc,
    resolveWorkspaceForRun,
    resolveReusedGitWorkspaceAnchor,
    appendRunEvent,
  } = input.services;
  const {
    selectedEnvironmentDriver: lowTrustPreflightEnvironmentDriver,
    workspace: resolvedWorkspace,
  } = await resolveWorkspaceAfterLowTrustPreflight({
    db,
    trustPreset,
    isolatedWorkspacesEnabled: runtimeWorkspaceSelectionEnabled,
    effectiveExecutionWorkspaceMode,
    issue: issueRef
      ? {
          companyId: agent.companyId,
          id: issueRef.id,
          projectId: issueRef.projectId,
        }
      : null,
    resolveSelectedEnvironmentDriver: async () => {
      const preflightEnvironment = await envOrchestrator.resolveEnvironment(
        {
          companyId: agent.companyId,
          selectedEnvironmentId,
          localEnvironmentId: localEnvironment.id,
        },
      );
      return preflightEnvironment.driver;
    },
    resolveWorkspace: async () => {
      if (isDotRun) {
        // This is private controller storage, never a provider filesystem.
        // v6 projects workspace.access=none and cwd=null to Dot.
        const cwd = path.resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "dot-controllers", agent.companyId, run.id);
        await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
        return { cwd, source: "agent_home" as const, projectId: null, workspaceId: null, repoUrl: null, repoRef: null,
          workspaceHints: [], warnings: [], baseCwdFallback: false, materializationFailures: [], additionalWorkspaces: [], referencedProjectFailures: [] };
      }
      if (useIsolatedTaskDirectory && issueRef) {
        const cwd = await materializeIsolatedTaskDirectory({
          companyId: agent.companyId,
          issueId: issueRef.id,
        });
        if (reusableExistingExecutionWorkspace && (
          reusableExistingExecutionWorkspace.companyId !== agent.companyId ||
          reusableExistingExecutionWorkspace.sourceIssueId !== issueRef.id ||
          reusableExistingExecutionWorkspace.mode !== "isolated_workspace" ||
          reusableExistingExecutionWorkspace.strategyType !== "project_primary" ||
          reusableExistingExecutionWorkspace.cwd !== cwd
        )) {
          throw new WorkspaceValidationFailure("The existing execution workspace is not this task's isolated directory.", {
            workspaceValidation: { reason: "isolated_task_directory_binding_mismatch", issueId: issueRef.id },
          });
        }
        return resolveWorkspaceForRun(agent, context, previousSessionParams, {
          executionEnvironmentDriver: selectedEnvironmentForConfig?.driver ?? null,
          anchorWorkspace: {
            cwd,
            source: "task_session",
            projectId: reusableExistingExecutionWorkspace?.projectId ?? null,
            workspaceId: null,
            repoUrl: null,
            repoRef: null,
            workspaceHints: [],
            warnings: [],
            baseCwdFallback: false,
            materializationFailures: [],
          },
        });
      }
      if (nativeChatWorkspaceScope && !nativeChatWorkspaceScope.projectId) {
        const cwd = await materializeNativeChatTaskRoot(
          nativeChatWorkspaceScope,
        );
        return {
          cwd,
          source: "task_session" as const,
          projectId: null,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
          workspaceHints: [],
          warnings: [],
          baseCwdFallback: false,
          materializationFailures: [],
          additionalWorkspaces: [],
          referencedProjectFailures: [],
        };
      }
      const workspace = await resolveWorkspaceForRun(
        agent,
        context,
        previousSessionParams,
        {
          useProjectWorkspace:
            requestedExecutionWorkspaceMode !== "agent_default",
          configuredCwd: readNonEmptyString(mergedConfig.cwd),
          anchorWorkspace: requestedShouldReuseExisting && reusableExistingExecutionWorkspace?.strategyType === "git_worktree"
            ? await resolveReusedGitWorkspaceAnchor({
                agent,
                workspace: reusableExistingExecutionWorkspace,
                responsibleUserId,
                immutableNativeBinding: Boolean(nativeRecoveryExecutionWorkspaceId),
                projectId: nativeRecoveryExecutionWorkspaceId
                  ? reusableExistingExecutionWorkspace.projectId
                  : issueRef?.projectId ?? readNonEmptyString(context.projectId),
                explicitProjectWorkspaceId: nativeRecoveryExecutionWorkspaceId
                  ? reusableExistingExecutionWorkspace.projectWorkspaceId
                  : readNonEmptyString(context.projectWorkspaceId),
                issueId,
                runId: run.id,
              })
            : requestedShouldReuseExisting && reusableExistingExecutionWorkspace?.cwd ? {
                cwd: reusableExistingExecutionWorkspace.cwd, source: "task_session" as const,
                projectId: reusableExistingExecutionWorkspace.projectId,
                workspaceId: reusableExistingExecutionWorkspace.projectWorkspaceId,
                repoUrl: reusableExistingExecutionWorkspace.repoUrl, repoRef: reusableExistingExecutionWorkspace.baseRef,
                localPathOnlyWorkspace: reusableExistingExecutionWorkspace.strategyType === "project_primary" && !reusableExistingExecutionWorkspace.repoUrl && !reusableExistingExecutionWorkspace.branchName,
                workspaceHints: [], warnings: [], baseCwdFallback: false, materializationFailures: [],
              } : undefined,
          // Thread the selected environment driver so run-workspace resolution can tell a local
          // target from a remote one, and a confined sandbox target from an unconfined remote
          // target. A remote run resolves referenced projects only for the confined sandbox
          // transport with the remote flag on. This never changes the anchor workspace.
          executionEnvironmentDriver:
            selectedEnvironmentForConfig?.driver ?? null,
        },
      );
      // Additional referenced projects are a separate trusted Board
      // capability, not extra readable roots for an external conversation.
      return nativeChatWorkspaceScope
        ? {
            ...workspace,
            additionalWorkspaces: [],
            referencedProjectFailures: [],
          }
        : workspace;
    },
  });
  const hostExecutionWorkspaceConfig = isDotRun ? {} :
    stripHostWorkspaceProvisionForLowTrustSandbox({
      config: mergedConfig,
      trustPreset,
      selectedEnvironmentDriver: lowTrustPreflightEnvironmentDriver,
    });
  const executionWorkspaceBase = {
    baseCwd: resolvedWorkspace.cwd,
    source: resolvedWorkspace.source,
    projectId: resolvedWorkspace.projectId,
    workspaceId: resolvedWorkspace.workspaceId,
    repoUrl: resolvedWorkspace.repoUrl,
    repoRef: resolvedWorkspace.repoRef,
    additionalWorkspaces: resolvedWorkspace.additionalWorkspaces,
  } satisfies ExecutionWorkspaceInput;
  await assertGitWorktreeBaseWorkspaceReady({
    requestedExecutionWorkspaceMode,
    config: hostExecutionWorkspaceConfig,
    issue: issueRef,
    base: executionWorkspaceBase,
    anchor: {
      baseCwdFallback: resolvedWorkspace.baseCwdFallback,
      materializationFailures: resolvedWorkspace.materializationFailures,
      localPathOnlyWorkspace: resolvedWorkspace.localPathOnlyWorkspace,
    },
  });
  const workspaceStrategyForFingerprint = parseObject(
    hostExecutionWorkspaceConfig.workspaceStrategy,
  );
  const workspaceStrategyFingerprintValue =
    Object.keys(workspaceStrategyForFingerprint).length > 0
      ? workspaceStrategyForFingerprint
      : null;
  const latestWorkspaceStrategyType = resolveEffectiveWorkspaceStrategyType(
    requestedExecutionWorkspaceMode,
    hostExecutionWorkspaceConfig,
  );
  const selectedEnvironmentConfigForFingerprint = parseObject(
    selectedEnvironmentForConfig?.config,
  );
  const workspaceEnvironmentFingerprint = selectedEnvironmentForConfig
    ? {
        selectionSource: environmentResolution.source,
        selectedEnvironmentId,
        driver: selectedEnvironmentForConfig.driver,
        provider: readNonEmptyString(
          selectedEnvironmentConfigForFingerprint.provider,
        ),
        config: selectedEnvironmentForConfig.config,
        configRevisionAt:
          selectedEnvironmentForConfig.updatedAt instanceof Date
            ? selectedEnvironmentForConfig.updatedAt.toISOString()
            : (selectedEnvironmentForConfig.updatedAt ?? null),
        executionPolicy,
      }
    : null;
  const workspaceRealizationFingerprint = {
    environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
    environmentProvider: readNonEmptyString(
      selectedEnvironmentConfigForFingerprint.provider,
    ),
    trustPreset: trustPreset.kind,
    lowTrustSandboxDriver: lowTrustPreflightEnvironmentDriver,
  };
  const workspaceFreshnessSource = resolvedWorkspace.freshnessSource ?? executionWorkspaceBase;
  const latestWorkspaceConfigMetadata =
    buildEffectiveRunWorkspaceConfigMetadata({
      mode: requestedExecutionWorkspaceMode,
      projectId: workspaceFreshnessSource.projectId,
      projectWorkspaceId: workspaceFreshnessSource.workspaceId,
      strategyType: latestWorkspaceStrategyType,
      workspaceStrategy: workspaceStrategyFingerprintValue,
      repoUrl: workspaceFreshnessSource.repoUrl,
      repoRef:
        readNonEmptyString(workspaceStrategyForFingerprint.baseRef) ??
        workspaceFreshnessSource.repoRef,
      configSnapshot,
      environment: workspaceEnvironmentFingerprint,
      realization: workspaceRealizationFingerprint,
      secretManifest,
    });
  const inferredExistingWorkspaceConfigMetadata =
    reusableExistingExecutionWorkspace
      ? buildEffectiveRunWorkspaceConfigMetadata({
          mode: issueExecutionWorkspaceModeForPersistedWorkspace(
            reusableExistingExecutionWorkspace.mode,
          ),
          projectId: reusableExistingExecutionWorkspace.projectId,
          projectWorkspaceId:
            reusableExistingExecutionWorkspace.projectWorkspaceId,
          strategyType: reusableExistingExecutionWorkspace.strategyType,
          workspaceStrategy: workspaceStrategyFingerprintValue
            ? {
                ...workspaceStrategyFingerprintValue,
                type: reusableExistingExecutionWorkspace.strategyType,
                ...(reusableExistingExecutionWorkspace.baseRef
                  ? { baseRef: reusableExistingExecutionWorkspace.baseRef }
                  : {}),
              }
            : { type: reusableExistingExecutionWorkspace.strategyType },
          repoUrl: reusableExistingExecutionWorkspace.repoUrl,
          repoRef: reusableExistingExecutionWorkspace.baseRef,
          configSnapshot: reusableExistingExecutionWorkspace.config,
          environment: workspaceEnvironmentFingerprint,
          realization: workspaceRealizationFingerprint,
          secretManifest,
          evaluatedAt: latestWorkspaceConfigMetadata.evaluatedAt,
        })
      : null;
  const workspaceConfigFreshness = resolveExecutionWorkspaceConfigFreshness(
    {
      hasExistingWorkspace:
        requestedShouldReuseExisting &&
        Boolean(reusableExistingExecutionWorkspace),
      existingWorkspaceMetadata:
        reusableExistingExecutionWorkspace?.metadata ?? null,
      inferredMetadata: inferredExistingWorkspaceConfigMetadata,
      nextMetadata: latestWorkspaceConfigMetadata,
    },
  );
  const workspaceReuseProvisioningPolicy =
    resolveExecutionWorkspaceReuseProvisioningPolicy({
      requestedShouldReuseExisting,
      workspaceConfigFreshness,
    });
  const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
    companyId: agent.companyId,
    heartbeatRunId: run.id,
    executionWorkspaceId:
      workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace
        ? workspaceReuseRequest.requestedExecutionWorkspaceId
        : null,
    issueId,
  });
  // The run-scoped provider resolves the active identity at each Git operation,
  // including base-ref refreshes, workspace realization, and restore.
  const workspaceGitAuthProvider = createGitRemoteAuthProvider(
    db,
    agent.companyId,
    {
      issueId,
      heartbeatRunId: run.id,
      responsibleUserId: run.responsibleUserId,
      agentId: agent.id,
    },
  );
  const {
    executionWorkspace,
    reusedExecutionWorkspace,
    policy: resolvedWorkspaceReusePolicy,
  } = isDotRun ? { executionWorkspace: { ...executionWorkspaceBase, strategy: "project_primary" as const, cwd: resolvedWorkspace.cwd, branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false } as RealizedExecutionWorkspace, reusedExecutionWorkspace: false, policy: workspaceReuseProvisioningPolicy } : await provisionExecutionWorkspaceForFreshnessDecision<RealizedExecutionWorkspace>(
    {
      requestedShouldReuseExisting,
      existingExecutionWorkspaceId:
        workspaceReuseRequest.requestedExecutionWorkspaceId,
      issueRef,
      runId: run.id,
      workspaceConfigFreshness,
      restoreExistingWorkspace: reusableExistingExecutionWorkspace
        ? () =>
            ensurePersistedExecutionWorkspaceAvailable({
              db,
              base: executionWorkspaceBase,
              workspace: {
                id: reusableExistingExecutionWorkspace.id,
                mode: reusableExistingExecutionWorkspace.mode,
                strategyType:
                  reusableExistingExecutionWorkspace.strategyType,
                cwd: reusableExistingExecutionWorkspace.cwd,
                providerRef: reusableExistingExecutionWorkspace.providerRef,
                projectId: reusableExistingExecutionWorkspace.projectId,
                projectWorkspaceId:
                  reusableExistingExecutionWorkspace.projectWorkspaceId,
                repoUrl: reusableExistingExecutionWorkspace.repoUrl,
                baseRef: reusableExistingExecutionWorkspace.baseRef,
                branchName: reusableExistingExecutionWorkspace.branchName,
                metadata:
                  reusableExistingExecutionWorkspace.metadata as Record<
                    string,
                    unknown
                  > | null,
                config: {
                  provisionCommand:
                    configSnapshot?.provisionCommand ??
                    reusableExistingExecutionWorkspace.config
                      ?.provisionCommand ??
                    projectExecutionWorkspacePolicy?.workspaceStrategy
                      ?.provisionCommand ??
                    null,
                  runtimeProvisionCommand:
                    configSnapshot?.runtimeProvisionCommand ??
                    reusableExistingExecutionWorkspace.config
                      ?.runtimeProvisionCommand ??
                    projectExecutionWorkspacePolicy?.workspaceStrategy
                      ?.runtimeProvisionCommand ??
                    null,
                },
              },
              issue: issueRef,
              agent: {
                id: agent.id,
                name: agent.name,
                companyId: agent.companyId,
              },
              heartbeatRunId: run.id,
              enableWorkspaceBranchReconcileForward:
                resolvedInstanceSettings.experimental
                  .enableWorkspaceBranchReconcileForward,
              enableWorkspaceDirtyQuarantineRepair:
                resolvedInstanceSettings.experimental
                  .enableWorkspaceDirtyQuarantineRepair,
              recorder: workspaceOperationRecorder,
              resolveGitAuth: workspaceGitAuthProvider,
            })
        : null,
      realizeWorkspace: () =>
        realizeExecutionWorkspace({
          db,
          base: executionWorkspaceBase,
          config: hostExecutionWorkspaceConfig,
          issue: issueRef,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          recordedBranchOwnership:
            existingExecutionWorkspace?.status !== "archived" &&
            existingExecutionWorkspace?.branchName
              ? {
                  branchName: existingExecutionWorkspace.branchName,
                  createdByRuntime: isRuntimeOwnedGitBranch(
                    existingExecutionWorkspace.metadata,
                  ),
                }
              : null,
          heartbeatRunId: run.id,
          enableWorkspaceBranchReconcileForward:
            resolvedInstanceSettings.experimental
              .enableWorkspaceBranchReconcileForward,
          enableWorkspaceDirtyQuarantineRepair:
            resolvedInstanceSettings.experimental
              .enableWorkspaceDirtyQuarantineRepair,
          recorder: workspaceOperationRecorder,
          resolveGitAuth: workspaceGitAuthProvider,
        }),
    },
  );
  const resolvedProjectId =
    reusableExistingExecutionWorkspace
      ? reusableExistingExecutionWorkspace.projectId
      : executionWorkspace.projectId;
  const resolvedProjectWorkspaceId =
    resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace && reusableExistingExecutionWorkspace?.strategyType === "git_worktree"
      ? reusableExistingExecutionWorkspace.projectWorkspaceId
      : issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
  let persistedExecutionWorkspace: ExecutionWorkspace | null = null;
  let issueExecutionWorkspaceIdForRun =
    issueRef?.executionWorkspaceId ?? null;
  let issueProjectWorkspaceIdForRun = issueRef?.projectWorkspaceId ?? null;
  let issueExecutionWorkspacePreferenceForRun =
    issueRef?.executionWorkspacePreference ?? null;
  let issueExecutionWorkspaceModeForRun =
    issueExecutionWorkspaceSettings?.mode ?? null;
  const warmReusableExecutionWorkspace =
    selectedEnvironmentForConfig?.driver === "sandbox" &&
    selectedEnvironmentConfigForFingerprint.reuseLease === true &&
    selectedEnvironmentConfigForFingerprint.runnerLifecycleMode === "warm";
  // Native provider checkpoints bind to the workspace row, including ordinary
  // local shared workspaces. Persist that binding independently of the opt-in
  // isolated-workspace UI, just as warm sandbox continuity already does.
  const nativeSharedWorkspace = agent.adapterType === "paperclip_runner" &&
    requestedExecutionWorkspaceMode === "shared_workspace";
  const bindIssueToPersistedExecutionWorkspace = async (
    workspace: ExecutionWorkspace | null,
  ) => {
    if (!issueId || !workspace || nativeRecoveryExecutionWorkspaceId) {
      return;
    }
    const nextIssueWorkspaceMode =
      issueExecutionWorkspaceModeForPersistedWorkspace(workspace.mode) ??
      "agent_default";
    const shouldSwitchIssueToExistingWorkspace =
      issueRef?.executionWorkspacePreference === "reuse_existing" ||
      requestedExecutionWorkspaceMode === "isolated_workspace" ||
      requestedExecutionWorkspaceMode === "operator_branch" ||
      warmReusableExecutionWorkspace || nativeSharedWorkspace || Boolean(issueId);
    const nextIssuePatch: TaskWorkspaceBindingPatch = {};
    if (issueExecutionWorkspaceIdForRun !== workspace.id) {
      nextIssuePatch.executionWorkspaceId = workspace.id;
    }
    if (
      resolvedProjectWorkspaceId &&
      issueProjectWorkspaceIdForRun !== resolvedProjectWorkspaceId
    ) {
      nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
    }
    if (
      shouldSwitchIssueToExistingWorkspace &&
      (issueExecutionWorkspacePreferenceForRun !== "reuse_existing" ||
        issueExecutionWorkspaceModeForRun !== nextIssueWorkspaceMode)
    ) {
      nextIssuePatch.executionWorkspacePreference = "reuse_existing";
      nextIssuePatch.executionWorkspaceSettings = {
        ...(issueExecutionWorkspaceSettings ?? {}),
        mode: nextIssueWorkspaceMode,
      };
    }
    if (Object.keys(nextIssuePatch).length > 0) {
      await executionWorkspacesSvc.bindTaskWorkspace(agent.companyId, issueId, workspace.id, nextIssuePatch);
      issueExecutionWorkspaceIdForRun = workspace.id;
      issueProjectWorkspaceIdForRun =
        resolvedProjectWorkspaceId ?? issueProjectWorkspaceIdForRun;
      if (shouldSwitchIssueToExistingWorkspace) {
        issueExecutionWorkspacePreferenceForRun = "reuse_existing";
        issueExecutionWorkspaceModeForRun = nextIssueWorkspaceMode;
      }
    }
  };
  const baseExecutionWorkspaceMetadata =
    mergeExecutionWorkspaceMetadataForPersistence({
      existingMetadata:
        resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace
          ? (reusableExistingExecutionWorkspace?.metadata ?? null)
          : null,
      source: executionWorkspace.source,
      // Attaching a new worktree to a pre-existing branch reports a fresh
      // workspace, but must not make cleanup own the operator's branch.
      createdByRuntime:
        resolveExecutionWorkspaceBranchOwnership(executionWorkspace),
      strategyType: executionWorkspace.strategy,
      configSnapshot,
      shouldReuseExisting:
        resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace,
      shouldRefreshConfigSnapshot:
        resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
      workspaceConfigMetadata:
        resolvedWorkspaceReusePolicy.shouldPersistLatestWorkspaceConfigMetadata
          ? latestWorkspaceConfigMetadata
          : null,
      baseRef: executionWorkspace.repoRef,
      baseRefSha: executionWorkspace.baseRefSha ?? null,
    });
  let persistedWorktreeInstanceRoot =
    resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace &&
    typeof reusableExistingExecutionWorkspace?.metadata?.[
      WORKTREE_INSTANCE_ROOT_METADATA_KEY
    ] === "string"
      ? reusableExistingExecutionWorkspace.metadata[
          WORKTREE_INSTANCE_ROOT_METADATA_KEY
        ]
      : null;
  if (
    !persistedWorktreeInstanceRoot &&
    executionWorkspace.strategy === "git_worktree" &&
    executionWorkspace.worktreePath
  ) {
    try {
      persistedWorktreeInstanceRoot =
        (
          await readManagedWorktreeInstanceOwnership(
            executionWorkspace.worktreePath,
          )
        )?.instanceRoot ?? null;
    } catch (error) {
      logger.warn(
        {
          runId: run.id,
          issueId,
          executionWorkspaceCwd: executionWorkspace.cwd,
          error: error instanceof Error ? error.message : String(error),
        },
        "Could not record managed worktree instance ownership",
      );
    }
  }
  const nextExecutionWorkspaceMetadata = {
    ...baseExecutionWorkspaceMetadata,
    ...(persistedWorktreeInstanceRoot
      ? {
          [WORKTREE_INSTANCE_ROOT_METADATA_KEY]:
            persistedWorktreeInstanceRoot,
        }
      : {}),
  };
  const pendingForwardBranchReconcile =
    executionWorkspace.pendingForwardBranchReconcile ?? null;
  const branchNameForInitialPersistence =
    pendingForwardBranchReconcile?.recordedBranchName ??
    executionWorkspace.branchName;
  try {
    persistedExecutionWorkspace =
      resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace &&
      reusableExistingExecutionWorkspace
        ? await executionWorkspacesSvc.update(
            reusableExistingExecutionWorkspace.id,
            {
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: branchNameForInitialPersistence,
              providerType:
                executionWorkspace.strategy === "git_worktree"
                  ? "git_worktree"
                  : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              status: "active",
              lastUsedAt: new Date(),
              metadata: nextExecutionWorkspaceMetadata,
              projectWorkspaceId:
                reconcileReusedExecutionWorkspaceProjectWorkspaceId(
                  reusableExistingExecutionWorkspace.projectWorkspaceId,
                  resolvedProjectWorkspaceId,
                ),
            },
          )
        : !isDotRun && !persistedNativeExecutionInput && (resolvedProjectId || issueRef)
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                requestedExecutionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : requestedExecutionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : requestedExecutionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType:
                executionWorkspace.strategy === "git_worktree"
                  ? "git_worktree"
                  : "project_primary",
              name:
                branchNameForInitialPersistence ??
                issueRef?.identifier ??
                `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: branchNameForInitialPersistence,
              providerType:
                executionWorkspace.strategy === "git_worktree"
                  ? "git_worktree"
                  : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: nextExecutionWorkspaceMetadata,
            })
          : null;
  } catch (error) {
    if (executionWorkspace.created) {
      try {
        await cleanupExecutionWorkspaceArtifacts({
          workspace: {
            id:
              reusableExistingExecutionWorkspace?.id ??
              workspaceReuseRequest.requestedExecutionWorkspaceId ??
              `transient-${run.id}`,
            cwd: executionWorkspace.cwd,
            providerType:
              executionWorkspace.strategy === "git_worktree"
                ? "git_worktree"
                : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            branchName: executionWorkspace.branchName,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            projectId: resolvedProjectId,
            projectWorkspaceId: resolvedProjectWorkspaceId,
            sourceIssueId: issueRef?.id ?? null,
            metadata: nextExecutionWorkspaceMetadata,
          },
          projectWorkspace: {
            cwd: resolvedWorkspace.cwd,
            cleanupCommand: null,
          },
          cleanupCommand: configSnapshot?.cleanupCommand ?? null,
          teardownCommand:
            configSnapshot?.teardownCommand ??
            projectExecutionWorkspacePolicy?.workspaceStrategy
              ?.teardownCommand ??
            null,
          recorder: workspaceOperationRecorder,
        });
      } catch (cleanupError) {
        logger.warn(
          {
            runId: run.id,
            issueId,
            executionWorkspaceCwd: executionWorkspace.cwd,
            cleanupError:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          },
          "Failed to cleanup realized execution workspace after persistence failure",
        );
      }
    }
    throw error;
  }
  await workspaceOperationRecorder.attachExecutionWorkspaceId(
    persistedExecutionWorkspace?.id ?? null,
  );
  await recordWorkspaceConfigFreshnessOperation({
    recorder: workspaceOperationRecorder,
    runId: run.id,
    decision: workspaceConfigFreshness,
    hasExistingWorkspace: Boolean(reusableExistingExecutionWorkspace),
    reuseRequested: requestedShouldReuseExisting,
    workspaceReused: Boolean(reusedExecutionWorkspace),
    configSnapshotRefreshed:
      resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
    previousWorkspaceId:
      workspaceReuseRequest.requestedExecutionWorkspaceId,
    activeWorkspaceId: persistedExecutionWorkspace?.id ?? null,
  });
  if (
    reusableExistingExecutionWorkspace &&
    persistedExecutionWorkspace &&
    reusableExistingExecutionWorkspace.id !==
      persistedExecutionWorkspace.id &&
    reusableExistingExecutionWorkspace.status === "active"
  ) {
    await executionWorkspacesSvc.update(
      reusableExistingExecutionWorkspace.id,
      {
        status: "idle",
        cleanupReason: null,
      },
    );
  }
  await bindIssueToPersistedExecutionWorkspace(persistedExecutionWorkspace);
  const projectRepositoryPaths: string[] = [];
  if (executionWorkspace.projectId
    && (resolvedWorkspace.source === "project_primary" || Boolean(reusableExistingExecutionWorkspace?.projectWorkspaceId))
    && !resolvedWorkspace.baseCwdFallback && !persistedNativeExecutionInput) {
    const repositoryRows = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, agent.companyId),
      eq(projectWorkspaces.projectId, executionWorkspace.projectId),
    )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
    const repositories = await prepareProjectRepositoryWorkspaces({
      cwd: executionWorkspace.cwd,
      anchorRepoUrl: executionWorkspace.repoUrl,
      workspaces: repositoryRows,
      resolveGitAuth: workspaceGitAuthProvider,
    });
    const paths = new Map(repositories.map((repo) => [repo.workspaceId, repo.cwd]));
    projectRepositoryPaths.push(...repositories.map((repo) => path.relative(executionWorkspace.cwd, repo.cwd)));
    if (resolvedWorkspace.workspaceId) paths.set(resolvedWorkspace.workspaceId, executionWorkspace.cwd);
    // Reused roots may have no transient hints. Rebuild from the currently
    // authorized source rows and the paths actually prepared for this admission.
    resolvedWorkspace.workspaceHints = repositoryRows.map((source) => ({
      workspaceId: source.id,
      cwd: paths.get(source.id) ?? readNonEmptyString(source.cwd),
      repoUrl: readNonEmptyString(source.repoUrl),
      repoRef: readNonEmptyString(source.repoRef),
    }));
  }
  if (persistedExecutionWorkspace && issueId && !persistedNativeExecutionInput) {
    const taskRepositories = await executionWorkspacesSvc.prepareTaskRepositoriesForAdmission({ companyId: agent.companyId,
      issueId, workspaceId: persistedExecutionWorkspace.id, cwd: executionWorkspace.cwd,
      agentId: agent.id, runId: run.id, responsibleUserId });
    projectRepositoryPaths.push(...taskRepositories.map(repository => repository.relativePath));
  }
  if (persistedExecutionWorkspace) {
    context.executionWorkspaceId = persistedExecutionWorkspace.id;
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: context,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id));
  }
  const environmentAcquireStartedAtMs = Date.now();
  let acquiredEnvironment: Awaited<
    ReturnType<typeof envOrchestrator.acquireForRun>
  >;
  try {
    await controllerLease.assertOwned();
    const remoteRecovery = runOptions.nativeRestartRecovery?.kind === "reattach_remote_runner"
      ? runOptions.nativeRestartRecovery : null;
    const recoveryWorkspace = remoteRecovery
      ? readNativeWorkspaceSyncReference(parseObject(run.runnerProfileJson).nativeWorkspaceSync) : null;
    if (remoteRecovery && (!recoveryWorkspace || remoteRecovery.runId !== run.id ||
        recoveryWorkspace.providerLeaseId !== remoteRecovery.remote.providerLeaseId ||
        recoveryWorkspace.remoteCwd !== remoteRecovery.remote.remoteCwd)) {
      throw new Error("native_remote_recovery_lease_mismatch");
    }
    acquiredEnvironment = await envOrchestrator.acquireForRun({
      companyId: agent.companyId,
      selectedEnvironmentId,
      localEnvironmentId: localEnvironment.id,
      adapterType: agent.adapterType,
      adapterConfig: parseObject(agent.adapterConfig),
      admittedLifecycleMode: persistedNativeExecutionInput?.session.lifecyclePolicy.mode,
      issueId: issueId ?? null,
      heartbeatRunId: run.id,
      agentId: agent.id,
      persistedExecutionWorkspace,
      executionWorkspaceSettings: environmentExecutionWorkspaceSettings,
      ...(remoteRecovery && recoveryWorkspace ? { reattachRemoteLease: {
        leaseId: recoveryWorkspace.leaseId,
        providerLeaseId: remoteRecovery.remote.providerLeaseId,
        remoteCwd: remoteRecovery.remote.remoteCwd,
      } } : {}),
    });
    await controllerLease.assertOwned();
    nativeRunnerPreparationSpans.push({
      name: "environment.acquire",
      parentName: "task.provider_session",
      startedAtMs: environmentAcquireStartedAtMs,
      endedAtMs: Date.now(),
      attributes: { adapter: agent.adapterType },
    });
  } catch (error) {
    nativeRunnerPreparationSpans.push({
      name: "environment.acquire",
      parentName: "task.provider_session",
      startedAtMs: environmentAcquireStartedAtMs,
      endedAtMs: Date.now(),
      outcome: "failed",
      attributes: { adapter: agent.adapterType },
    });
    throw error;
  }
  const selectedEnvironment = acquiredEnvironment.environment;
  // Defense-in-depth: re-check the actually-acquired environment against the
  // execution allowlist. Even if selection were bypassed, a denied (local/ssh/
  // non-k8s) environment FAILS the run here rather than executing untrusted.
  const allowlistDecision = evaluateExecutionAllowlist(executionPolicy, {
    driver: selectedEnvironment.driver,
    provider:
      typeof selectedEnvironment.config?.provider === "string"
        ? selectedEnvironment.config.provider
        : null,
  });
  if (!allowlistDecision.allowed) {
    logger.error(
      {
        runId: run.id,
        issueId,
        agentId: agent.id,
        environmentId: selectedEnvironment.id,
        deniedDriver: allowlistDecision.deniedDriver,
        deniedProvider: allowlistDecision.deniedProvider,
      },
      "Execution allowlist denied the resolved environment; failing run",
    );
    throw new Error(allowlistDecision.reason);
  }
  let activeEnvironmentLease = {
    environment: acquiredEnvironment.environment,
    lease: acquiredEnvironment.lease,
    leaseContext: acquiredEnvironment.leaseContext,
  };
  const duplexObservabilityRecorder = createHostDuplexObservabilityRecorder(
    {
      tracer: getStartupTracer(),
      incrementCounter: (metric) => {
        void incrementToolRuntimeMetricCounter(db, {
          companyId: run.companyId,
          metric,
        }).catch(() => {});
      },
      emitTransportEvent: (event) => {
        void (async () => {
          await appendRunEvent(run, {
            eventType: event.name,
            stream: "system",
            level: event.dimensions.outcome === "error" ? "warn" : "info",
            payload: { ...event.dimensions },
          });
        })().catch(() => {});
      },
    },
  );
  const environmentRealizeStartedAtMs = Date.now();
  let realizationResult: Awaited<
    ReturnType<typeof envOrchestrator.realizeForRun>
  >;
  try {
    realizationResult = await envOrchestrator.realizeForRun({
      environment: selectedEnvironment,
      lease: activeEnvironmentLease.lease,
      adapterType: agent.adapterType,
      companyId: agent.companyId,
      issueId: issueId ?? null,
      heartbeatRunId: run.id,
      executionWorkspace,
      effectiveExecutionWorkspaceMode,
      persistedExecutionWorkspace,
      duplexObservabilityRecorder,
    });
    nativeRunnerPreparationSpans.push({
      name: "environment.workspace.realize",
      parentName: "task.provider_session",
      startedAtMs: environmentRealizeStartedAtMs,
      endedAtMs: Date.now(),
      attributes: { driver: selectedEnvironment.driver },
    });
  } catch (error) {
    nativeRunnerPreparationSpans.push({
      name: "environment.workspace.realize",
      parentName: "task.provider_session",
      startedAtMs: environmentRealizeStartedAtMs,
      endedAtMs: Date.now(),
      outcome: "failed",
      attributes: { driver: selectedEnvironment.driver },
    });
    throw error;
  }
  const environmentRealizeEndedAtMs = Date.now();
  activeEnvironmentLease = {
    ...activeEnvironmentLease,
    lease: realizationResult.lease,
  };
  persistedExecutionWorkspace =
    realizationResult.persistedExecutionWorkspace;
  // A sandbox realization may materialize or replace the durable workspace
  // after the host-side provisioning boundary above. Bind that final ID to
  // the issue before dispatch so warm turns reuse the exact same workspace
  // and lease scope instead of silently creating a per-run replacement.
  await bindIssueToPersistedExecutionWorkspace(persistedExecutionWorkspace);
  const workspaceRealization = realizationResult.workspaceRealization;
  const executionTarget = realizationResult.executionTarget;
  // Preserve the host-owned source before adapter context can share lease
  // metadata. A later copy-back failure must not adopt a rebound source.
  const workspaceRestoreSource = structuredClone(realizationResult.lease);
  return {
    resolvedWorkspace,
    hostExecutionWorkspaceConfig,
    latestWorkspaceConfigMetadata,
    workspaceConfigFreshness,
    workspaceOperationRecorder,
    executionWorkspace,
    reusedExecutionWorkspace,
    resolvedWorkspaceReusePolicy,
    persistedExecutionWorkspace,
    projectRepositoryPaths,
    environmentAcquireStartedAtMs,
    selectedEnvironment,
    activeEnvironmentLease,
    realizationResult,
    environmentRealizeEndedAtMs,
    workspaceRealization,
    executionTarget,
    workspaceRestoreSource,
  };
}
