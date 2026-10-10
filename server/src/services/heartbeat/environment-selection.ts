import type { Db, agents, heartbeatRuns, issues } from "@paperclipai/db";
import type { IssueExecutionWorkspaceSettings, ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { isExecutionForcedToKubernetes } from "../execution-allowlist.js";
import { parseExecutionPolicyBootstrapEnv } from "../execution-policy-bootstrap.js";
import {
  parseIssueExecutionWorkspaceSettings,
  resolveExecutionWorkspaceEnvironmentId,
  resolveExecutionWorkspaceMode,
  resolveSharedWorkspaceConcurrency,
  type ParsedExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import { shouldUseIsolatedTaskDirectory } from "../isolated-task-directory.js";
import {
  findNativeChatWorkspaceScope,
  nativeChatWorkspaceCwd,
  nativeChatWorkspaceMatches,
} from "../native-runtime/native-chat-workspace.js";
import { NativeRunnerOwnershipUnverifiedError } from "../native-runtime/native-runner-ownership.js";
import type { environmentService } from "../environments.js";
import type { executionWorkspaceService } from "../execution-workspaces.js";
import type { instanceSettingsService } from "../instance-settings.js";
import type { TrustPresetResolution } from "../trust-preset-resolver.js";
import { WORKSPACE_BUSY_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { WorkspaceBusyDeferral, type createHeartbeatRetries } from "./retries.js";
import { ConfigurationIncompleteFailure } from "./run-preparation.js";
import { resolveNativeRecoveryExecutionWorkspaceBinding, resolveExecutionWorkspaceReuseRequestForIssue } from "./workspaces.js";

type Issue = typeof issues.$inferSelect;

/** Selects policy and reuse inputs; lease acquisition and cleanup belong to the executor. */
export interface HeartbeatEnvironmentSelectionInput {
  run: Pick<typeof heartbeatRuns.$inferSelect,
    "id" | "runtimeMode" | "runnerProfileJson" | "scheduledRetryReason" | "scheduledRetryAttempt">;
  agent: Pick<typeof agents.$inferSelect,
    "id" | "companyId" | "adapterType" | "adapterConfig" | "defaultEnvironmentId">;
  task: {
    issueRef: Pick<Issue, "id" | "projectWorkspaceId" | "executionWorkspaceId" | "executionWorkspacePreference"> | null;
    issueContext: Pick<Issue, "assigneeAgentId" | "executionWorkspaceSettings"> | null;
    issueId: string | null;
    context: Record<string, unknown>;
    executionProjectId: string | null;
    projectContext: { hasWorkspace: boolean } | null;
  };
  policy: {
    trustPreset: TrustPresetResolution;
    requestedExecutionWorkspaceMode: ParsedExecutionWorkspaceMode;
    isolatedWorkspacesEnabled: boolean;
    projectExecutionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
    issueExecutionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  };
  config: {
    config: Record<string, unknown>;
    issueAssigneeOverrides: { adapterConfig: Record<string, unknown> | null } | null;
  };
  services: {
    executionWorkspacesSvc: Pick<ReturnType<typeof executionWorkspaceService>, "getById">;
    environmentsSvc: Pick<ReturnType<typeof environmentService>,
      "ensureLocalEnvironment" | "findManagedSandboxEnvironment" | "findKubernetesEnvironment" | "ensureKubernetesEnvironment" | "getById">;
    instanceSettings: Pick<ReturnType<typeof instanceSettingsService>, "get" | "getExperimental">;
    findSharedWorkspaceHolder: ReturnType<typeof createHeartbeatRetries>["findSharedWorkspaceHolder"];
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function selectHeartbeatEnvironment(db: Db, input: HeartbeatEnvironmentSelectionInput) {
  const { run, agent } = input;
  const { issueRef, issueContext, issueId, context, executionProjectId, projectContext } = input.task;
  const {
    trustPreset, requestedExecutionWorkspaceMode, isolatedWorkspacesEnabled,
    projectExecutionWorkspacePolicy, issueExecutionWorkspaceSettings,
  } = input.policy;
  const { config, issueAssigneeOverrides } = input.config;
  const { executionWorkspacesSvc, environmentsSvc, instanceSettings, findSharedWorkspaceHolder } = input.services;
  // A native run's execution input is immutable once persisted. Recovery must therefore
  // restore the workspace bound to that input rather than consulting the issue's current
  // workspace pointer: a newer run may already have moved or cleared the issue binding while
  // this older provider session is still recoverable.
  const persistedRunnerProfile = parseObject(run.runnerProfileJson);
  const persistedNativeExecutionInput =
    run.runtimeMode === "native" &&
    persistedRunnerProfile.nativeExecutionInput !== undefined
      ? parseNativeExecutionInput(
          persistedRunnerProfile.nativeExecutionInput,
        )
      : null;
  const isDotRun = persistedNativeExecutionInput?.provider.kind === "openai_dot"
    || (!persistedNativeExecutionInput && agent.adapterType === "paperclip_runner" && parseObject(agent.adapterConfig).provider === "openai_dot");
  const persistedNativeExecutionWorkspaceId =
    persistedNativeExecutionInput?.binding.executionWorkspaceId ?? null;
  const requestedExecutionWorkspaceId =
    persistedNativeExecutionWorkspaceId ??
    readNonEmptyString(issueRef?.executionWorkspaceId);
  const existingExecutionWorkspace = requestedExecutionWorkspaceId
    ? await executionWorkspacesSvc.getById(requestedExecutionWorkspaceId)
    : null;
  const nativeRecoveryExecutionWorkspaceId =
    resolveNativeRecoveryExecutionWorkspaceBinding({
      bindingId: persistedNativeExecutionWorkspaceId,
      persistedWorkspaceFound: existingExecutionWorkspace !== null,
    });
  const workspaceReuseRequest =
    resolveExecutionWorkspaceReuseRequestForIssue({
      issueExecutionWorkspaceId: requestedExecutionWorkspaceId,
      issueExecutionWorkspacePreference: nativeRecoveryExecutionWorkspaceId
        ? "reuse_existing"
        : (issueRef?.executionWorkspacePreference ?? null),
      existingExecutionWorkspaceStatus:
        existingExecutionWorkspace?.status ?? null,
    });
  const requestedShouldReuseExisting =
    workspaceReuseRequest.requestedShouldReuseExisting;
  const reusableExistingExecutionWorkspace =
    workspaceReuseRequest.existingExecutionWorkspaceAvailable
      ? existingExecutionWorkspace
      : null;
  const requestedReusableExecutionWorkspaceConfig =
    reusableExistingExecutionWorkspace?.config ?? null;
  const localEnvironment = await environmentsSvc.ensureLocalEnvironment(
    agent.companyId,
  );
  const resolvedInstanceSettings = await instanceSettings.get();
  // Managed-sandbox-only policy: a run that would land on the local
  // environment is redirected onto the platform-managed sandbox row, and
  // with no active managed row the resolution fails closed
  // (ManagedSandboxUnavailableError) — never local. Mirrors the forced
  // kubernetes execution mode below, which takes precedence when both
  // regimes are active.
  const managedSandboxOnly =
    (await instanceSettings.getExperimental()).enableManagedSandboxOnly ===
    true;
  const managedSandboxEnvironment = managedSandboxOnly
    ? await environmentsSvc.findManagedSandboxEnvironment(agent.companyId)
    : null;
  const environmentResolution = resolveExecutionWorkspaceEnvironmentId({
    lowTrustIssueEnvironmentId: trustPreset.kind === "low_trust_review"
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings, {includeEnvironmentId: true})?.environmentId : null,
    agentDefaultEnvironmentId: agent.defaultEnvironmentId,
    instanceDefaultEnvironmentId:
      resolvedInstanceSettings.defaultEnvironmentId ?? null,
    localDefaultEnvironmentId: localEnvironment.id,
    managedSandboxOnly,
    managedSandboxEnvironmentId: managedSandboxEnvironment?.id ?? null,
  });
  const effectiveExecutionWorkspaceMode: ReturnType<
    typeof resolveExecutionWorkspaceMode
  > = requestedExecutionWorkspaceMode;
  const executionPolicy = {
    executionMode: resolvedInstanceSettings.general.executionMode,
    // Backstop behind the resolver's local→managed redirect: the run-time
    // allowlist below fails any run that still resolved to a `local`
    // environment under managed-sandbox-only, so no selection path or
    // tenant-set env var can land untrusted execution on the tenant
    // container.
    managedSandboxOnly,
  };
  const executionForcedToKubernetes =
    isExecutionForcedToKubernetes(executionPolicy);
  let selectedEnvironmentId = environmentResolution.environmentId;
  if (executionForcedToKubernetes) {
    let kubernetesEnvironment =
      await environmentsSvc.findKubernetesEnvironment(agent.companyId);
    if (!kubernetesEnvironment) {
      // Lazy recovery for companies created after the startup bootstrap ran
      // (the boot hook only provisions environments for companies that exist
      // at boot). Re-derive the managed-env config from the bootstrap env.
      // If the process env no longer forces Kubernetes (rollback / config
      // drift relative to the persisted executionMode setting), skip the
      // provisioning gracefully: the guard below still refuses local
      // fallback with the explicit error, instead of crashing here on
      // undefined config.
      let bootstrap: ReturnType<typeof parseExecutionPolicyBootstrapEnv> =
        null;
      let bootstrapSkipReason: string | null = null;
      try {
        bootstrap = parseExecutionPolicyBootstrapEnv(process.env);
        if (!bootstrap) {
          bootstrapSkipReason =
            'PAPERCLIP_EXECUTION_MODE bootstrap env is not kubernetes-forced (absent or "any")';
        }
      } catch (err) {
        bootstrapSkipReason = `PAPERCLIP_EXECUTION_MODE bootstrap env failed to parse: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      if (bootstrap) {
        await environmentsSvc.ensureKubernetesEnvironment(
          agent.companyId,
          bootstrap.kubernetesConfig,
        );
        kubernetesEnvironment =
          await environmentsSvc.findKubernetesEnvironment(agent.companyId);
      } else {
        logger.warn(
          {
            runId: run.id,
            agentId: agent.id,
            companyId: agent.companyId,
            reason: bootstrapSkipReason,
          },
          "executionMode=kubernetes is persisted but the bootstrap env cannot provision a managed Kubernetes environment; skipping lazy provisioning for this company (the run will fail with the explicit no-managed-environment error)",
        );
      }
    }
    if (!kubernetesEnvironment) {
      throw new Error(
        "Instance execution policy requires the Kubernetes sandbox provider " +
          "(executionMode=kubernetes) but no managed Kubernetes environment is " +
          "configured for this company. Configure one (PAPERCLIP_K8S_* env on the " +
          "cloud instance) before running agents; refusing to fall back to local execution.",
      );
    }
    if (kubernetesEnvironment.id !== selectedEnvironmentId) {
      logger.info(
        {
          runId: run.id,
          issueId,
          agentId: agent.id,
          resolvedEnvironmentId: selectedEnvironmentId,
          forcedKubernetesEnvironmentId: kubernetesEnvironment.id,
        },
        "Forcing run onto the managed Kubernetes environment (executionMode=kubernetes)",
      );
    }
    selectedEnvironmentId = kubernetesEnvironment.id;
  }
  const selectedEnvironmentForConfig =
    selectedEnvironmentId === localEnvironment.id
      ? localEnvironment
      : selectedEnvironmentId
        ? await environmentsSvc.getById(selectedEnvironmentId)
        : null;
  const nativeChatWorkspaceScope = await findNativeChatWorkspaceScope(db, {
    adapterType: agent.adapterType,
    environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
    companyId: agent.companyId,
    agentId: agent.id,
    issueId,
  });
  const nativeChatExpectedCwd = nativeChatWorkspaceScope
    ? nativeChatWorkspaceCwd(
        nativeChatWorkspaceScope,
        reusableExistingExecutionWorkspace,
        requestedShouldReuseExisting,
      )
    : null;
  if (
    nativeChatWorkspaceScope &&
    persistedNativeExecutionInput &&
    persistedNativeExecutionInput.schema !== "paperclip.native-execution-input.v6" &&
    !nativeChatWorkspaceMatches({
      scope: nativeChatWorkspaceScope,
      expectedCwd: nativeChatExpectedCwd,
      execution: persistedNativeExecutionInput,
    })
  ) {
    // Never rewrite an admitted provider input or release ownership of an
    // older process whose permissions still include the shared agent home.
    throw new NativeRunnerOwnershipUnverifiedError(
      "native_chat_workspace_scope_mismatch",
    );
  }
  if (
    nativeChatWorkspaceScope &&
    (!nativeChatExpectedCwd ||
      executionProjectId !== nativeChatWorkspaceScope.projectId)
  ) {
    throw new ConfigurationIncompleteFailure(
      "External chat requires a task-owned isolated workspace. Configure and select an existing isolated worktree for this project task; shared project workspaces cannot be used for external chat.",
      {
        configurationIncomplete: {
          reason: "native_chat_workspace_isolation_required",
          issueId,
        },
      },
    );
  }
  const sharedWorkspaceConcurrency = resolveSharedWorkspaceConcurrency({
    projectPolicy: projectExecutionWorkspacePolicy,
    issueSettings: issueExecutionWorkspaceSettings,
  });
  // A live holder is always consulted for shared workspaces. Depending on policy and the final
  // execution target it either remains the existing deferral gate or becomes dispatch context.
  // Local/SSH folders never take an exclusive workspace lock, including when older
  // project or issue settings request serialization. Sandbox protection still uses
  // the existing holder staleness and workspace_busy retry ladder.
  if (
    issueRef?.projectWorkspaceId &&
    effectiveExecutionWorkspaceMode === "shared_workspace"
  ) {
    const workspaceHolder = await findSharedWorkspaceHolder({
      companyId: agent.companyId,
      projectWorkspaceId: issueRef.projectWorkspaceId,
      excludeIssueId: issueRef.id,
      excludeRunId: run.id,
      honorIsolatedWorkspaceModes: isolatedWorkspacesEnabled,
    });
    if (workspaceHolder) {
      const environmentDriver =
        selectedEnvironmentForConfig?.driver ?? null;
      const shouldSerialize =
        sharedWorkspaceConcurrency !== "allow" &&
        (executionForcedToKubernetes ||
          (environmentDriver !== "local" &&
            environmentDriver !== "ssh"));
      if (shouldSerialize) {
        throw new WorkspaceBusyDeferral({
          holder: workspaceHolder,
          projectWorkspaceId: issueRef.projectWorkspaceId,
          deferralAttempt:
            run.scheduledRetryReason === WORKSPACE_BUSY_RETRY_REASON
              ? (run.scheduledRetryAttempt ?? 0)
              : 0,
          wasIssueAssignee: issueContext?.assigneeAgentId === agent.id,
        });
      }

      const holderIssueLabel =
        workspaceHolder.issueIdentifier ?? workspaceHolder.issueId;
      const concurrentWorkspaceNote =
        `shared workspace is concurrently held by run ${workspaceHolder.runId} (issue ${holderIssueLabel}); ` +
        "expect concurrent mutations, coordinate via commits";
      const appendConcurrentWorkspaceNote = (value: unknown) => {
        const existing = typeof value === "string" ? value.trimEnd() : "";
        return existing
          ? `${existing}\n${concurrentWorkspaceNote}`
          : concurrentWorkspaceNote;
      };
      context.paperclipTaskMarkdown = appendConcurrentWorkspaceNote(
        context.paperclipTaskMarkdown,
      );
      context.paperclipTaskMarkdownAssignment = appendConcurrentWorkspaceNote(
        context.paperclipTaskMarkdownAssignment,
      );
      if (typeof context.paperclipTaskMarkdownCompact === "string") {
        context.paperclipTaskMarkdownCompact =
          appendConcurrentWorkspaceNote(
            context.paperclipTaskMarkdownCompact,
          );
      }
      if (typeof context.paperclipTaskMarkdownAssignmentCompact === "string") {
        context.paperclipTaskMarkdownAssignmentCompact =
          appendConcurrentWorkspaceNote(
            context.paperclipTaskMarkdownAssignmentCompact,
          );
      }
      logger.info(
        {
          event: "shared_workspace_concurrent_dispatch",
          runId: run.id,
          issueId: issueRef.id,
          projectWorkspaceId: issueRef.projectWorkspaceId,
          holderRunId: workspaceHolder.runId,
          holderIssueId: workspaceHolder.issueId,
          sharedWorkspaceConcurrency,
          environmentDriver,
          executionForcedToKubernetes,
        },
        "Dispatching alongside a live shared-workspace holder",
      );
    }
  }
  const useIsolatedTaskDirectory = issueRef !== null && shouldUseIsolatedTaskDirectory({
    trustPreset: trustPreset.kind,
    environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
    mode: requestedExecutionWorkspaceMode,
    hasProjectWorkspace: projectContext?.hasWorkspace ?? false,
    projectWorkspaceId: issueRef.projectWorkspaceId,
    workspaceStrategies: [
      config.workspaceStrategy,
      issueAssigneeOverrides?.adapterConfig?.workspaceStrategy,
      projectExecutionWorkspacePolicy?.workspaceStrategy,
      issueExecutionWorkspaceSettings?.workspaceStrategy,
    ],
  });
  return {
    persistedRunnerProfile,
    persistedNativeExecutionInput,
    isDotRun,
    existingExecutionWorkspace,
    nativeRecoveryExecutionWorkspaceId,
    workspaceReuseRequest,
    requestedShouldReuseExisting,
    reusableExistingExecutionWorkspace,
    requestedReusableExecutionWorkspaceConfig,
    localEnvironment,
    resolvedInstanceSettings,
    environmentResolution,
    effectiveExecutionWorkspaceMode,
    executionPolicy,
    selectedEnvironmentId,
    selectedEnvironmentForConfig,
    nativeChatWorkspaceScope,
    nativeChatExpectedCwd,
    useIsolatedTaskDirectory,
  };
}
