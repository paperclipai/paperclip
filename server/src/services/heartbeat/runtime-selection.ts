import { museRunnerBroker } from "../muse-runner-broker.js";
import {
  ConfigurationIncompleteFailure,
  type buildPaperclipWakePayload,
  type createHeartbeatRunPreparation,
} from "./run-preparation.js";
import { dotRunnerBroker } from "../dot-runner-broker.js";
import { isAgentDirectoryCopy } from "../agent-directory-working-copies.js";
import { isConversation } from "../agent-conversations.js";
import { renewLegacyControllerLease } from "../legacy-controller-lease.js";
import type { prepareManagedAiRuntime } from "../ai-connection-runtime.js";
import {
  getNativeReviewAssignment,
  readNativeReviewAssignmentContext,
} from "../native-runtime/native-review-participant.js";
import { buildNativeReviewRequest } from "../native-runtime/native-review-prompt.js";
import type { buildExecutionContinuation } from "../execution-continuation.js";
import type { agentInstructionWorkingCopyService } from "../agent-instruction-working-copies.js";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { CHAT_PROVIDERS } from "@paperclipai/shared";
import {
  type agents,
  completionContracts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getStartupTracer } from "../../instrumentation.js";
import { documentService } from "../documents.js";
import { managedAgentProfileService } from "../managed-agent-profiles.js";
import { remoteAgentProfileService } from "../remote-agent-profiles.js";
import {
  buildNativeExecutionInput,
  buildNativeExecutionWithCheckpoint,
  buildNativeRuntimeContext,
  ensureNativeCompletionContract,
  findNativeSessionResumeRun,
  isNativeSessionId,
  isUnusedNativeSessionBootstrap,
  isUnusedLegacyNativeRetryReplacement,
  materializeNativeInteractionResponses,
  nativeCompletionRequestsWithSources,
  nativeCompletionSource,
  nativeImmediateObjectiveSource,
  nativeToolContractFingerprintForTarget,
  prepareNativeSessionBootstrapPersistence,
  prepareNativeWorkspaceSync,
  type NativeRestartRecoveryClaim,
  rebindNativeSessionCheckpoint,
  type resolveHeartbeatNativeRuntimeMode,
} from "../native-runtime/index.js";
import {
  assertAgentCoreProfileRecoveryBinding,
  assertManagedProfileRecoveryBinding,
  projectPaperclipRunnerTaskConfig,
  resolvePaperclipRunnerNativeProviderInput,
} from "../native-runtime/provider-profile.js";
import { readRemoteCodexModelCliVersion } from "../native-runtime/codex-model-fallback.js";
import {
  describeRunnerdNativeSessionBackend,
  parseNativeExecutionInput,
  type NativeExecutionInput,
} from "../../vendor/paperclip-runner/index.js";
import { PROVIDER_TRACE_MAX_BYTES } from "../provider-trace-store.js";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";
import { parseObject } from "../../adapters/utils.js";
import { EXTERNAL_CHAT_QUESTION_RESPONSE_KEY } from "../native-runtime/external-chat-question-response.js";
import {
  materializeExternalChatQuestionResponseInput,
} from "../native-runtime/external-chat-question-response-input.js";
import { CHAT_CONTROL_RECOVERY_ADMISSION_KEY } from "../chat-control-recovery-stop.js";
import type { issueService } from "../issues.js";
import { buildPlanReviewContext } from "../plan-review-context.js";
import { resolvePaperclipRunnerIdleTimeoutMs } from "@paperclipai/adapter-utils";
import { selectPaperclipTaskMarkdown } from "@paperclipai/adapter-utils/server-utils";
import type { ProviderResourceDisposition } from "../environment-runtime.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;
type IssueContext = Awaited<ReturnType<ReturnType<typeof createHeartbeatRunPreparation>["getIssueExecutionContext"]>> | null;
type IssueRef = Parameters<typeof ensureNativeCompletionContract>[0]["issue"] & Parameters<typeof buildNativeExecutionInput>[0]["issue"];

export interface NativeLifecycleTelemetry {
  provider: string;
  harness: string;
  lifecycleMode: "per_turn" | "warm";
  sandboxResource: "keep_running" | "stop_and_reuse" | "destroy_after_turn";
}

export interface HeartbeatRuntimeSelectionInput {
  run: Run;
  agent: Agent;
  nativeRuntimeResolution: ReturnType<typeof resolveHeartbeatNativeRuntimeMode>;
  task: {
    issueRef: IssueRef | null;
    issueContext: IssueContext;
    context: Record<string, unknown>;
    executionContinuation: Awaited<ReturnType<typeof buildExecutionContinuation>> | null;
    safeWakeComments: Parameters<typeof nativeCompletionRequestsWithSources>[0];
    safeWakeCommentContext: { id: string; body: string } | null;
    paperclipWakePayload: Awaited<ReturnType<typeof buildPaperclipWakePayload>>;
    acceptedPlanContinuationWake: boolean;
  };
  session: {
    persistedNativeExecutionInput: NativeExecutionInput | null;
    persistedRunnerProfile: Record<string, unknown>;
    taskSessionCredentialCompatible: boolean;
    taskSessionDecodedParams: Record<string, unknown> | null;
    taskSessionForRun: { lastRunId: string | null } | null;
    isFailedChatRunRetry: boolean;
    getFreshSessionHandoff: (() => Promise<string | null>) | undefined;
  };
  workspace: {
    persistedExecutionWorkspace: { id: string } | null;
    executionWorkspace: Omit<Parameters<typeof buildNativeExecutionInput>[0]["workspace"], "id">;
    executionTarget: Parameters<typeof prepareNativeWorkspaceSync>[0]["target"];
    activeEnvironmentLease: Pick<Parameters<typeof prepareNativeWorkspaceSync>[0], "lease">;
    isDotRun: boolean;
    projectRepositoryPaths: string[];
  };
  config: {
    runtimeConfig: Record<string, unknown>;
    runtimeSkillEntries: Parameters<typeof buildNativeRuntimeContext>[0]["runtimeSkillEntries"];
    runScopedMentionedSkillKeys: string[];
    instructionCopy: Awaited<ReturnType<ReturnType<typeof agentInstructionWorkingCopyService>["prepare"]>>;
    agentIdentity: { keyId: string } | undefined;
    issueAssigneeOverrides: { adapterConfig: Record<string, unknown> | null } | null;
    resolvedConfig: Record<string, unknown>;
    managedAiRuntime: Awaited<ReturnType<typeof prepareManagedAiRuntime>> | undefined;
  };
  recovery: { nativeLeaseOwner?: string; nativeRestartRecovery?: NativeRestartRecoveryClaim };
  trace: { providerTraceRequested: boolean; providerTraceCapture: { metadata: { id: string } } | null };
  issuesSvc: Pick<ReturnType<typeof issueService>, "addComment">;
  runtimeEnv: Record<string, string | undefined>;
  beforeNativeRuntimeSelection?: (runId: string) => Promise<void>;
  onAdapterEvent: (event: AdapterRuntimeEvent) => Promise<void>;
  // Teardown must observe these updates even when a later preparation step throws.
  onNativeLifecycleSelected: (telemetry: NativeLifecycleTelemetry) => void;
  onProviderResourceDisposition: (disposition: ProviderResourceDisposition | undefined) => void;
  onNativeOwnershipHeld: () => void;
  stopControllerLease: () => void;
}

export type HeartbeatRuntimeSelectionResult = { selected: false } | {
  selected: true;
  nativeExecution: NativeExecutionInput | null;
  nativeRunnerInstanceId: string | null;
  getNativeFreshSessionHandoff: (() => Promise<string | null>) | undefined;
  nativeWorkspaceSync: Awaited<ReturnType<typeof prepareNativeWorkspaceSync>>;
};

export interface NativeSandboxLifecycle {
  runnerProcess: "per_turn" | "warm";
  sandboxResource: "keep_running" | "stop_and_reuse" | "destroy_after_turn";
  failoverBackup: "verified";
}

export function resolveReusableSandboxLifecycle(input: {
  lifecyclePolicy:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  target: {
    kind: "local" | "remote";
    transport?: string;
    reusableLeaseConfigured?: boolean;
    effectiveCapabilities?: { reusableLeases: boolean } | null;
  } | null;
}): NativeSandboxLifecycle | null {
  if (input.target?.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }
  const reusableLease =
    input.target.reusableLeaseConfigured === true &&
    input.target.effectiveCapabilities?.reusableLeases === true;
  if (input.lifecyclePolicy.mode === "warm" && !reusableLease) {
    throw new Error("runner_warm_lifecycle_requires_reusable_provider_lease");
  }
  return {
    runnerProcess: input.lifecyclePolicy.mode,
    sandboxResource:
      input.lifecyclePolicy.mode === "warm"
        ? "keep_running"
        : reusableLease
          ? "stop_and_reuse"
          : "destroy_after_turn",
    failoverBackup: "verified",
  };
}

export function resolveNativeSandboxLifecycle(input: {
  adapterType: string;
  lifecyclePolicy:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  target: {
    kind: "local" | "remote";
    transport?: string;
    reusableLeaseConfigured?: boolean;
    effectiveCapabilities?: { reusableLeases: boolean } | null;
  } | null;
}): NativeSandboxLifecycle | null {
  if (
    input.adapterType !== "paperclip_runner" ||
    input.target?.kind !== "remote" ||
    input.target.transport !== "sandbox"
  )
    return null;
  return resolveReusableSandboxLifecycle(input);
}

export async function postNativeModelFallbackWarning(input: {
  issuesSvc: Pick<ReturnType<typeof issueService>, "addComment">;
  onEvent: (event: AdapterRuntimeEvent) => Promise<void>;
  issueId: string;
  runId: string;
  requestedModel: string | null;
  effectiveModel: string | null;
  codexCliVersion: string;
}): Promise<void> {
  const message = `Using ${input.effectiveModel} because the sandbox's Codex ${input.codexCliVersion} does not support ${input.requestedModel}. Work will continue with the compatible model. Update the sandbox's Codex CLI to use the requested model.`;
  await input.onEvent({
    eventType: "runner.model_fallback",
    stream: "system",
    level: "warn",
    message,
    payload: {
      requestedModel: input.requestedModel,
      effectiveModel: input.effectiveModel,
      codexCliVersion: input.codexCliVersion,
    },
  });
  await input.issuesSvc.addComment(input.issueId, message, { runId: input.runId }, {
    authorType: "system",
    presentation: {
      kind: "system_notice",
      tone: "warning",
      title: `Using ${input.effectiveModel}`,
      density: "compact",
      detailsDefaultOpen: false,
    },
  });
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Prepare and persist the selected runtime before the executor dispatches provider work. */
export async function selectHeartbeatRuntime(db: Db, input: HeartbeatRuntimeSelectionInput): Promise<HeartbeatRuntimeSelectionResult> {
  const { run, agent, nativeRuntimeResolution, issuesSvc, runtimeEnv, beforeNativeRuntimeSelection, onAdapterEvent,
    onNativeLifecycleSelected, onProviderResourceDisposition, onNativeOwnershipHeld, stopControllerLease } = input;
  const { issueRef, issueContext, context, executionContinuation, safeWakeComments, safeWakeCommentContext,
    paperclipWakePayload, acceptedPlanContinuationWake } = input.task;
  const { persistedNativeExecutionInput, persistedRunnerProfile, taskSessionCredentialCompatible, taskSessionDecodedParams,
    taskSessionForRun, isFailedChatRunRetry, getFreshSessionHandoff } = input.session;
  const { persistedExecutionWorkspace, executionWorkspace, executionTarget, activeEnvironmentLease, isDotRun, projectRepositoryPaths } = input.workspace;
  const { runtimeConfig, runtimeSkillEntries, runScopedMentionedSkillKeys, instructionCopy, agentIdentity, issueAssigneeOverrides, resolvedConfig, managedAiRuntime } = input.config;
  const runOptions = input.recovery;
  const { providerTraceRequested, providerTraceCapture } = input.trace;
  let nativeExecution: NativeExecutionInput | null = null;
  let getNativeFreshSessionHandoff: (() => Promise<string | null>) | undefined;
  let nativeRunnerInstanceId: string | null = null;
  let nativeWorkspaceSync: Awaited<ReturnType<typeof prepareNativeWorkspaceSync>> = null;
  let providerResourceDispositionForRun: ProviderResourceDisposition | undefined;
  if (nativeRuntimeResolution.kind === "native") {
    if (!issueRef) {
      throw new Error("native_runtime_ineligible: issue is required");
    }
    const nativeExecutionWorkspaceId =
      persistedExecutionWorkspace?.id ?? run.id;
    const nativeReviewContext = readNativeReviewAssignmentContext(context);
    const nativeReview = nativeReviewContext ? await getNativeReviewAssignment(db, {
      companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id,
      contextSnapshot: nativeReviewContext,
    }) : null;
    if (nativeReviewContext && !nativeReview) throw new Error("native_review_assignment_no_longer_available");
    const nativeReviewRequest = nativeReview
      ? buildNativeReviewRequest({
          title: nativeReview.interaction.title,
          summary: nativeReview.interaction.summary,
          payload: nativeReview.interaction.payload,
        })
      : null;
    const persistedContract = run.completionContractId
      ? await db
          .select()
          .from(completionContracts)
          .where(
            and(
              eq(completionContracts.id, run.completionContractId),
              eq(completionContracts.companyId, agent.companyId),
              eq(completionContracts.issueId, issueRef.id),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    // Only a server-verified human resolution may supply a current answer
    // reference. Tool/agent results and generated summaries stay evidence.
    const currentHumanResponseId = !nativeReviewRequest
      ? executionContinuation?.humanResponses?.find(
          (response) => response.id === executionContinuation.trigger.interactionId,
        )?.id
      : undefined;
    const immediateCompletion = (() => {
      if (nativeReviewRequest) return { requests: [nativeReviewRequest], sources: [null] };
      const { requests, sources } = nativeCompletionRequestsWithSources(
        safeWakeComments.length > 0
          ? safeWakeComments
          : safeWakeCommentContext?.body
            ? [safeWakeCommentContext]
            : [],
        {
          requiredFullWakeCommentCount:
            paperclipWakePayload?.fallbackFetchNeeded === true &&
            CHAT_PROVIDERS.some(
              (provider) =>
                provider ===
                paperclipWakePayload.externalChatProvider,
            ) &&
            Array.isArray(paperclipWakePayload.commentIds)
              ? paperclipWakePayload.commentIds.length
              : undefined,
        },
      );
      // Preserve every admitted pending chat request while also
      // retaining newer user direction materialized by recovery.
      // A file-only wake must not inherit an old task objective.
      const latestComment =
        executionContinuation?.messages.findLast(
          (message) =>
            message.authorType === "user" &&
            !message.createdByRunId &&
            !message.deleted &&
            message.body.trim().length > 0,
        );
      const latestRequest = latestComment?.body;
      if (
        latestRequest &&
        !requests.some(
          (request) => request === latestRequest.trim(),
        )
      ) {
        requests.push(latestRequest.trim());
        sources.push(nativeCompletionSource("comment", latestComment!.id, latestRequest));
      }
      return { requests: requests.length > 0 ? requests : undefined, sources };
    })();
    // Rebuilding a default contract is not a change in user direction.
    // In particular, an upgraded checkpoint may have an intentionally
    // authored contract and no continuation envelope yet.
    const completionContract =
      persistedContract && persistedNativeExecutionInput
        ? {
            row: persistedContract,
            contract: persistedContract.contractJson as never,
          }
        : await ensureNativeCompletionContract({
            db,
            companyId: agent.companyId,
            issue: issueRef,
            actorId: agent.id,
            immediateRequest:
              nativeReviewRequest ?? (currentHumanResponseId
                ? null
                : executionContinuation?.objective ?? safeWakeCommentContext?.body ?? null),
            // The ordinary initial objective is selected by the server-owned
            // continuation envelope. Carry its explicit description source
            // through the singular-request compatibility path; do not infer
            // provenance for review requests, answers, or wake fallbacks.
            immediateRequestSource: nativeImmediateObjectiveSource({
              issueId: issueRef.id,
              objectiveSource: executionContinuation?.objectiveSource,
              excluded: Boolean(nativeReviewRequest || currentHumanResponseId),
            }),
            humanResponseId: currentHumanResponseId,
            immediateRequests: immediateCompletion.requests,
            immediateRequestSources: immediateCompletion.sources,
          });
    const taskNativeSessionId = !taskSessionCredentialCompatible ? null : readNonEmptyString(
      taskSessionDecodedParams?.sessionId,
    );
    // Compatibility for native retry rows created before same-run restart
    // recovery existed. Only an entirely unused replacement row may
    // inherit its source checkpoint; any process/provider evidence on the
    // replacement makes the ownership ambiguous and therefore ineligible.
    const legacyRetrySource =
      run.retryOfRunId && !isFailedChatRunRetry
        ? await db
            .select({
              id: heartbeatRuns.id,
              companyId: heartbeatRuns.companyId,
              agentId: heartbeatRuns.agentId,
              runnerInstanceId: heartbeatRuns.runnerInstanceId,
              nativeSessionId: heartbeatRuns.nativeSessionId,
              runnerProfileJson: heartbeatRuns.runnerProfileJson,
              runtimeMode: heartbeatRuns.runtimeMode,
              status: heartbeatRuns.status,
            })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, run.retryOfRunId),
                eq(heartbeatRuns.companyId, agent.companyId),
                eq(heartbeatRuns.agentId, agent.id),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null;
    const nativeBootstrapHasProviderEvidence =
      legacyRetrySource ||
      run.nativeSessionId ||
      persistedNativeExecutionInput
        ? await db
            .select({ id: heartbeatRunEvents.id })
            .from(heartbeatRunEvents)
            .where(
              and(
                eq(heartbeatRunEvents.runId, run.id),
                inArray(heartbeatRunEvents.eventType, [
                  "harness.ready",
                  "session.started",
                  "session.resumed",
                  "session.updated",
                  "turn.started",
                  "provider.event",
                  "provider.rpc_result",
                ]),
              ),
            )
            .limit(1)
            .then((rows) => rows.length > 0)
        : false;
    const compatibleLegacyRetrySource =
      !managedAiRuntime && !isConversation(issueContext) && context.forceFreshSession !== true && isUnusedLegacyNativeRetryReplacement({
        replacement: run,
        source: legacyRetrySource,
        hasProviderEvents: nativeBootstrapHasProviderEvidence,
      })
        ? legacyRetrySource
        : null;
    const legacyRetrySessionId =
      compatibleLegacyRetrySource?.nativeSessionId;
    const taskResumeRunId =
      taskSessionForRun?.lastRunId &&
      taskSessionForRun.lastRunId !== run.id &&
      isNativeSessionId(taskNativeSessionId)
        ? taskSessionForRun.lastRunId
        : null;
    const resumableTaskSessionId = isDotRun ? null : taskResumeRunId
      ? taskNativeSessionId
      : (legacyRetrySessionId ?? null);
    const requestedNativeSessionId =
      run.nativeSessionId ?? resumableTaskSessionId;
    // A task-session lastRunId can lag a failed turn or point at an older
    // normalized session. Find the newest exact-session authority instead.
    // Rows that already acquired provider authority are progress barriers,
    // even when they do not contain a usable checkpoint.
    const previousNativeRun =
      requestedNativeSessionId &&
      isUnusedNativeSessionBootstrap(
        run,
        nativeBootstrapHasProviderEvidence,
      )
        ? await findNativeSessionResumeRun(db, {
            companyId: agent.companyId,
            agentId: agent.id,
            issueId: issueRef.id,
            normalizedSessionId: requestedNativeSessionId,
            currentRunId: run.id,
            beforeCreatedAt: run.createdAt,
          })
        : null;
    nativeRunnerInstanceId =
      previousNativeRun?.runnerInstanceId &&
      previousNativeRun.nativeSessionId ===
        (run.nativeSessionId ?? resumableTaskSessionId)
        ? previousNativeRun.runnerInstanceId
        : (run.runnerInstanceId ?? randomUUID());
    let nativeSessionId =
      run.nativeSessionId ?? resumableTaskSessionId ?? randomUUID();
    let nativeResumeCheckpoint: ReturnType<
      typeof rebindNativeSessionCheckpoint
    > = null;
    const agentLifecyclePolicy =
      parseObject(agent.adapterConfig).lifecycleMode === "warm"
        ? {
            mode: "warm" as const,
            idleTimeoutMs: resolvePaperclipRunnerIdleTimeoutMs(
              parseObject(agent.adapterConfig).idleTimeoutMs,
            ),
          }
        : { mode: "per_turn" as const, idleTimeoutMs: null };
    const environmentLifecyclePolicy =
      executionTarget?.kind === "remote" &&
      executionTarget.transport === "sandbox"
        ? (executionTarget.runnerLifecyclePolicy ?? null)
        : null;
    // Native Codex owns a durable, session-scoped home. It flushes refreshed
    // auth into each invocation's private home before that home is removed.
    // Other managed harnesses still require per-turn credential cleanup.
    const supportsManagedWarmSession = agent.adapterType === "paperclip_runner" &&
      nativeRuntimeResolution.profile.backend === "codex_app_server";
    const effectiveLifecyclePolicy = persistedNativeExecutionInput?.session.lifecyclePolicy ??
      (["openai_dot_mcp", "muse_external"].includes(nativeRuntimeResolution.profile.backend) || managedAiRuntime && !supportsManagedWarmSession
        ? { mode: "per_turn" as const, idleTimeoutMs: null }
        : environmentLifecyclePolicy ?? agentLifecyclePolicy);
    if (
      effectiveLifecyclePolicy.mode === "warm" &&
      executionTarget?.kind === "remote" &&
      executionTarget.transport === "sandbox" &&
      (executionTarget.reusableLeaseConfigured !== true ||
        executionTarget.effectiveCapabilities?.reusableLeases !== true)
    ) {
      throw new Error("runner_warm_environment_requires_reusable_lease");
    }
    const persistedProfile = persistedRunnerProfile;
    if (persistedNativeExecutionInput) {
      nativeExecution = persistedNativeExecutionInput;
      if (
        nativeExecution.binding.companyId !== agent.companyId ||
        nativeExecution.binding.runId !== run.id ||
        nativeExecution.binding.issueId !== issueRef.id ||
        nativeExecution.binding.agentId !== agent.id ||
        nativeExecution.binding.executionWorkspaceId !==
          nativeExecutionWorkspaceId ||
        nativeExecution.completionContract.id !==
          completionContract.row.id ||
        nativeExecution.completionContract.sha256 !==
          completionContract.row.canonicalSha256
      )
        throw new Error(
          "native_execution_input_persisted_binding_mismatch",
        );
      // Recover only the originally admitted request. A stored idle
      // checkpoint can precede an already-started provider turn, so even
      // apparent idleness is not authority to rewrite its contract.
      // Newer user direction retains its separate durable wakeup cause.
      // A failed pre-bootstrap attempt may have persisted its immutable
      // input before discovering that lastRunId no longer names this
      // session. Restore only an exactly compatible prior checkpoint;
      // never rewrite the admitted input or skip current provider work.
      if (
        previousNativeRun &&
        isUnusedNativeSessionBootstrap(
          run,
          nativeBootstrapHasProviderEvidence,
        )
      ) {
        nativeResumeCheckpoint = rebindNativeSessionCheckpoint({
          previousRun: previousNativeRun,
          currentExecution: nativeExecution,
          executionTargetKind: executionTarget?.kind ?? "local",
        });
      }
      if (nativeExecution.provider.kind === "claude_managed") {
        const recoveryProfile = await managedAgentProfileService(
          db,
        ).requireQualified(
          agent.companyId,
          nativeExecution.provider.managedProfile.profileId,
        );
        assertManagedProfileRecoveryBinding({
          adapterConfig: agent.adapterConfig,
          snapshot: nativeExecution.provider.managedProfile,
          stored: recoveryProfile,
        });
      }
      if (nativeExecution.provider.kind === "aws_agentcore") {
        const recoveryProfile = await remoteAgentProfileService(
          db,
        ).requireQualified(
          agent.companyId,
          nativeExecution.provider.agentCoreProfile.profileId,
          "aws_bedrock_agentcore_harness",
        );
        assertAgentCoreProfileRecoveryBinding({
          snapshot: nativeExecution.provider.agentCoreProfile,
          stored: recoveryProfile,
        });
      }
    } else {
      const interactionId = readNonEmptyString(context.interactionId);
      const interactionResponses = context[
        EXTERNAL_CHAT_QUESTION_RESPONSE_KEY
      ]
        ? await materializeExternalChatQuestionResponseInput({
            db,
            binding: {
              companyId: agent.companyId,
              issueId: issueRef.id,
              runId: run.id,
              agentId: agent.id,
            },
            contextSnapshot: context,
          })
        : await materializeNativeInteractionResponses({
            db,
            companyId: agent.companyId,
            issueId: issueRef.id,
            runId: run.id,
            agentId: agent.id,
            interactionIds: Array.isArray(context.interactionIds)
              ? [
                  ...new Set([
                    ...(interactionId ? [interactionId] : []),
                    ...context.interactionIds.filter(
                      (id): id is string => typeof id === "string",
                    ),
                  ]),
                ]
              : interactionId
                ? [interactionId]
                : [],
          });
      const runnerAdapterConfig = parseObject(agent.adapterConfig);
      const managedProfile =
        nativeRuntimeResolution.profile.backend ===
        "claude_managed_agents_api"
          ? await managedAgentProfileService(db).requireQualified(
              agent.companyId,
              readNonEmptyString(runnerAdapterConfig.managedProfileId) ??
                "",
            )
          : null;
      const agentCoreProfile =
        nativeRuntimeResolution.profile.backend ===
        "aws_agentcore_harness_api"
          ? await remoteAgentProfileService(db).requireQualified(
              agent.companyId,
              readNonEmptyString(
                runnerAdapterConfig.agentCoreProfileId,
              ) ?? "",
              "aws_bedrock_agentcore_harness",
            )
          : null;
      if (managedProfile) {
        const rawApiKeyBinding = parseObject(
          runnerAdapterConfig.env,
        ).ANTHROPIC_API_KEY;
        const boundSecretId =
          typeof rawApiKeyBinding === "object" &&
          rawApiKeyBinding !== null
            ? readNonEmptyString(
                (rawApiKeyBinding as Record<string, unknown>).secretId,
              )
            : null;
        if (boundSecretId !== managedProfile.apiKeySecretId) {
          throw new ConfigurationIncompleteFailure(
            "configuration incomplete: Claude Managed profile API key is not bound at env.ANTHROPIC_API_KEY",
            {
              configurationIncomplete: {
                reason: "managed_agent_profile_secret_binding_mismatch",
                companyId: agent.companyId,
                agentId: agent.id,
                profileId: managedProfile.id,
                requiredEnvKeys: ["ANTHROPIC_API_KEY"],
              },
            },
          );
        }
      }
      const executionMode =
        issueRef.workMode === "planning" && !isConversation(issueContext) && !acceptedPlanContinuationWake
          ? ("plan" as const)
          : ("default" as const);
      const pinnedPlan =
        executionMode === "plan"
          ? await documentService(db).getIssueDocumentByKey(
              issueRef.id,
              "plan",
            )
          : null;
      const pinnedReviewContext =
        executionMode === "plan"
          ? await buildPlanReviewContext({
              db,
              companyId: agent.companyId,
              issueId: issueRef.id,
              issueWorkMode: issueRef.workMode,
              interactionId: readNonEmptyString(context.interactionId),
            })
          : null;
      const pinnedPlanMarkdown = pinnedPlan?.body ?? "";
      const museBinding = nativeRuntimeResolution.profile.backend === "muse_external"
        ? await museRunnerBroker(db).snapshot(agent.companyId, agent.id, String(parseObject(agent.adapterConfig).museBindingId ?? "")) : undefined;
      const dotBinding = nativeRuntimeResolution.profile.backend === "openai_dot_mcp"
        ? await dotRunnerBroker(db).snapshot(agent.companyId, agent.id, String(parseObject(agent.adapterConfig).dotBindingId ?? "")) : undefined;
      const nativeRuntimeContext = await buildNativeRuntimeContext({
        db,
        agent,
        runId: run.id,
        runtimeConfig,
        runtimeSkillEntries,
        instructionWorkingCopy: instructionCopy ? { rootPath: instructionCopy.executionRoot, entryPath: instructionCopy.entryFile, ...(isAgentDirectoryCopy(instructionCopy) ? { kind: "agent_files" as const } : {}) } : undefined,
      });
      getNativeFreshSessionHandoff = nativeReviewRequest ? undefined : getFreshSessionHandoff;
      const nativeProviderConfig = nativeRuntimeResolution.profile.backend === "codex_app_server"
        || nativeRuntimeResolution.profile.backend === "opencode_server"
        ? projectPaperclipRunnerTaskConfig(
            nativeRuntimeResolution.profile.backend,
            agent.adapterConfig,
            issueAssigneeOverrides?.adapterConfig,
            managedAiRuntime ? readNonEmptyString(resolvedConfig.model) ?? undefined : undefined,
          )
        : agent.adapterConfig;
      const requestedNativeProvider = resolvePaperclipRunnerNativeProviderInput({
        backend: nativeRuntimeResolution.profile.backend,
        adapterConfig: nativeProviderConfig, managedProfile, agentCoreProfile, dotBinding, museBinding,
      });
      const codexCliVersion = agent.adapterType === "paperclip_runner" && requestedNativeProvider.provider === "codex"
        ? await readRemoteCodexModelCliVersion({
            model: requestedNativeProvider.model,
            target: executionTarget,
            remoteCodexPath: runtimeEnv.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH,
            remoteCodexNpmSpec: runtimeEnv.PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC,
          }) : null;
      const nativeProvider = codexCliVersion
        ? resolvePaperclipRunnerNativeProviderInput({
            backend: nativeRuntimeResolution.profile.backend,
            adapterConfig: nativeProviderConfig, codexCliVersion, managedProfile, agentCoreProfile, dotBinding, museBinding,
          }) : requestedNativeProvider;
      if (nativeProvider.model !== requestedNativeProvider.model) {
        await postNativeModelFallbackWarning({
          issuesSvc, onEvent: onAdapterEvent, issueId: issueRef.id, runId: run.id,
          requestedModel: requestedNativeProvider.model, effectiveModel: nativeProvider.model,
          codexCliVersion: codexCliVersion!,
        });
      }
      const buildExecution = ({ normalizedSessionId, resumedSession }: { normalizedSessionId: string; resumedSession: boolean }) =>
            buildNativeExecutionInput({
              agentKeyId: agentIdentity?.keyId,
              companyId: agent.companyId,
              runId: run.id,
              issue: nativeReviewRequest ? { ...issueRef, title: `Review: ${issueRef.title}`, description: nativeReviewRequest } : issueRef,
              taskPrompt: [
                nativeReviewRequest ?? readNonEmptyString(
                  selectPaperclipTaskMarkdown(context, {
                    resumedSession: false,
                    includeCommunicationGuidance: false,
                  }),
                ) ??
                `# ${issueRef.identifier ?? issueRef.id}: ${issueRef.title}`,
                nativeRuntimeResolution.profile.backend !== "openai_dot_mcp" && nativeRuntimeResolution.profile.backend !== "muse_external" && projectRepositoryPaths.length > 0
                  ? `## Project repositories\nThe task workspace also contains these editable Git repositories:\n${projectRepositoryPaths.map((repo) => `- ${repo}`).join("\n")}`
                  : null,
              ].filter(Boolean).join("\n\n"),
              initialCommunicationGuidance: nativeReviewRequest ? null : readNonEmptyString(context.paperclipTaskCommunicationGuidance),
              wakePayload: context.paperclipWake,
              turnContext: context.paperclipTurnContext,
              githubInstructionSkillKeys: runScopedMentionedSkillKeys,
              resumedSession,
              previousTurn: (() => {
                if (!previousNativeRun || nativeReviewRequest) return null;
                try {
                  const previousTask = parseNativeExecutionInput(parseObject(previousNativeRun.runnerProfileJson).nativeExecutionInput).task;
                  if (paperclipWakePayload?.externalChatProvider) {
                    // External native inputs use a neutral task title. Compare
                    // the saved canonical brief so old provider text is not
                    // repeated as a change, while genuine edits still arrive.
                    const savedIssue = parseObject(parseObject(previousNativeRun.contextSnapshot).paperclipIssue);
                    if (savedIssue.id !== issueRef.id || typeof savedIssue.title !== "string" ||
                      (savedIssue.description !== null && typeof savedIssue.description !== "string")) return null;
                    return { runId: previousNativeRun.id, task: { title: savedIssue.title, description: savedIssue.description } };
                  }
                  return { runId: previousNativeRun.id, task: previousTask };
                } catch {
                  // An invalid prior snapshot must use the fresh bootstrap.
                  return null;
                }
              })(),
              conversationMode: context.conversationMode === true,
              agentId: agent.id,
              workspace: {
                // Projectless paperclip_runner tasks still have a resolved local cwd. Bind that
                // transient workspace to the run id so the native input remains durable and replayable
                // without fabricating a project-scoped execution_workspaces row.
                id: nativeExecutionWorkspaceId,
                cwd: executionWorkspace.cwd,
                repoUrl: executionWorkspace.repoUrl,
                repoRef: executionWorkspace.repoRef,
                branchName: executionWorkspace.branchName,
              },
              normalizedSessionId,
              executionMode,
              planningContext:
                executionMode === "plan"
                  ? {
                      documentId: pinnedPlan?.id ?? null,
                      baseRevisionId:
                        pinnedPlan?.latestRevisionId ?? null,
                      baseRevisionNumber:
                        pinnedPlan?.latestRevisionNumber ?? 0,
                      markdown: pinnedPlanMarkdown,
                      sha256: createHash("sha256")
                        .update(pinnedPlanMarkdown)
                        .digest("hex"),
                      reviewContext: pinnedReviewContext
                        ? (structuredClone(
                            pinnedReviewContext,
                          ) as unknown as Record<string, unknown>)
                        : {},
                    }
                  : null,
              ...nativeProvider,
              lifecyclePolicy: effectiveLifecyclePolicy,
              interactionResponses,
              completionContract: {
                id: completionContract.row.id,
                sha256: completionContract.row.canonicalSha256,
                schemaVersion: completionContract.row.schemaVersion,
                contract: completionContract.contract,
                sources: "sources" in completionContract ? completionContract.sources : undefined,
              },
              runtimeContext: nativeRuntimeContext,
            });
      const backendDescriptor = await describeRunnerdNativeSessionBackend(buildExecution({
        normalizedSessionId: nativeSessionId, resumedSession: previousNativeRun !== null,
      }));
      const nativeExecutionWithCheckpoint = buildNativeExecutionWithCheckpoint({
        previousRun: previousNativeRun,
        normalizedSessionId: nativeSessionId,
        executionTargetKind: executionTarget?.kind ?? "local",
        toolRefreshOnResume: backendDescriptor.capabilities.toolRefreshOnResume === true,
        refreshTools: context.refreshTools === true,
        buildExecution,
      });
      nativeExecution = nativeExecutionWithCheckpoint.execution;
      nativeResumeCheckpoint = nativeExecutionWithCheckpoint.checkpoint;
      if (
        nativeSessionId !==
        nativeExecutionWithCheckpoint.normalizedSessionId
      ) {
        nativeRunnerInstanceId = randomUUID();
      }
      nativeSessionId = nativeExecutionWithCheckpoint.normalizedSessionId;
    }
    const nativeSandboxLifecycle = resolveNativeSandboxLifecycle({
      adapterType: agent.adapterType,
      lifecyclePolicy: nativeExecution.session.lifecyclePolicy,
      target: executionTarget,
    });
    if (nativeSandboxLifecycle) {
      onNativeLifecycleSelected({
        provider: nativeExecution.provider.kind,
        harness: nativeExecution.session.driverKind,
        lifecycleMode: nativeExecution.session.lifecyclePolicy.mode,
        sandboxResource: nativeSandboxLifecycle.sandboxResource,
      });
      const selectedLifecycleSpan = getStartupTracer(
        "paperclip.environment-lifecycle",
      ).startSpan("sandbox.lifecycle.selected", {
        attributes: {
          "paperclip.native.span.provider": nativeExecution.provider.kind,
          "paperclip.native.span.harness":
            nativeExecution.session.driverKind,
          "paperclip.native.span.lifecycle_mode":
            nativeExecution.session.lifecyclePolicy.mode,
          "paperclip.native.span.sandbox_resource":
            nativeSandboxLifecycle.sandboxResource,
          "paperclip.native.span.outcome": "selected",
          "paperclip.native.span.bytes_transferred": 0,
        },
      });
      selectedLifecycleSpan.end();
    }
    providerResourceDispositionForRun =
      nativeSandboxLifecycle?.sandboxResource === "keep_running"
        ? "keep_running"
        : nativeSandboxLifecycle?.sandboxResource === "stop_and_reuse"
          ? "stop_and_retain"
          : nativeSandboxLifecycle?.sandboxResource ===
              "destroy_after_turn"
            ? "destroy"
            : undefined;
    onProviderResourceDisposition(providerResourceDispositionForRun);
    await beforeNativeRuntimeSelection?.(run.id);
    const nativeSelected = await db.transaction(async (tx) => {
      const lockedRun = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!lockedRun) throw new Error("native_runtime_run_missing");
      // Cancellation and runtime selection serialize on this row. A
      // stopped preparation must never create a new native coordinator.
      if (lockedRun.status !== "running" || lockedRun.resultJson?.startupCancellation) return false;
      if (lockedRun.runtimeMode === "legacy" && lockedRun.controllerBootId &&
          !(await renewLegacyControllerLease(tx as unknown as Db, lockedRun))) {
        onNativeOwnershipHeld();
        return false;
      }
      if (
        lockedRun.runtimeModeResolvedAt &&
        lockedRun.runtimeMode !== "native"
      ) {
        throw new Error("native_runtime_mode_conflict");
      }
      const lockedProfile = parseObject(lockedRun.runnerProfileJson);
      const persistedNativeSessionId =
        await prepareNativeSessionBootstrapPersistence(tx, {
          run: lockedRun,
          selectedSessionId: nativeSessionId,
          execution: nativeExecution!,
          restoringCheckpoint: nativeResumeCheckpoint !== null,
        });
      await tx
        .update(heartbeatRuns)
        .set({
          runtimeMode: "native",
          runtimeModeResolverVersion:
            lockedRun.runtimeModeResolverVersion ??
            nativeRuntimeResolution.resolverVersion,
          runtimeModeReason:
            lockedRun.runtimeModeReason ?? nativeRuntimeResolution.reason,
          runtimeModeResolvedAt:
            lockedRun.runtimeModeResolvedAt ?? new Date(),
          runnerProfileJson: {
            ...nativeRuntimeResolution.profile,
            ...lockedProfile,
            ...(lockedProfile.nativeExecutionInput
              ? {}
              : { recoveryEventInventoryVersion: 1 }),
            ...(providerTraceRequested
              ? {
                  providerTrace: {
                    mode: "raw",
                    traceId: providerTraceCapture?.metadata.id ?? null,
                    maxBytes: PROVIDER_TRACE_MAX_BYTES,
                  },
                }
              : {}),
            nativeExecutionInput:
              lockedProfile.nativeExecutionInput ?? nativeExecution,
            nativeToolContractFingerprint:
              nativeToolContractFingerprintForTarget(
                executionTarget?.kind ?? "local",
              ),
            ...(lockedProfile.sessionCheckpoint != null
              ? { sessionCheckpoint: lockedProfile.sessionCheckpoint }
              : nativeResumeCheckpoint
                ? {
                    sessionCheckpoint:
                      nativeResumeCheckpoint as unknown as Record<
                        string,
                        unknown
                      >,
                  }
                : {}),
          },
          runnerInstanceId:
            previousNativeRun?.runnerInstanceId &&
            persistedNativeSessionId === previousNativeRun.nativeSessionId
              ? previousNativeRun.runnerInstanceId
              : lockedRun.nativeSessionId !== persistedNativeSessionId
                ? nativeRunnerInstanceId
                : (lockedRun.runnerInstanceId ?? nativeRunnerInstanceId),
          nativeSessionId: persistedNativeSessionId,
          processPid:
            lockedRun.processPid ??
            (previousNativeRun?.nativeSessionId === nativeSessionId
              ? previousNativeRun.processPid
              : null),
          processGroupId:
            lockedRun.processGroupId ??
            (previousNativeRun?.nativeSessionId === nativeSessionId
              ? previousNativeRun.processGroupId
              : null),
          processStartedAt:
            lockedRun.processStartedAt ??
            (previousNativeRun?.nativeSessionId === nativeSessionId
              ? previousNativeRun.processStartedAt
              : null),
          nativeIssueId: lockedRun.nativeIssueId ?? issueRef.id,
          driverKind:
            lockedRun.driverKind ??
            nativeExecution?.session.driverKind ??
            "codex_app_server",
          driverVersion: lockedRun.driverVersion ?? "phase6-v1",
          completionContractId:
            lockedRun.completionContractId ?? completionContract.row.id,
          completionContractSha256:
            lockedRun.completionContractSha256 ??
            completionContract.row.canonicalSha256,
          nativePhase: lockedRun.nativePhase ?? "observed",
          nativePhaseUpdatedAt:
            lockedRun.nativePhaseUpdatedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
      await tx
        .insert(nativeRunFinalizations)
        .values({
          runId: run.id,
          companyId: agent.companyId,
          issueId: issueRef.id,
          phase: "observed",
        })
        .onConflictDoNothing();
      return true;
    });
    if (!nativeSelected) return { selected: false };
    stopControllerLease();
    nativeWorkspaceSync = await prepareNativeWorkspaceSync({
      db,
      runId: run.id,
      companyId: agent.companyId,
      workspaceId: nativeExecutionWorkspaceId,
      workspaceLocalDir: executionWorkspace.cwd,
      target: executionTarget,
      lease: activeEnvironmentLease.lease,
      restartRecovery: runOptions.nativeRestartRecovery,
      sameRunRecovery: Boolean(runOptions.nativeLeaseOwner),
      resourceDisposition: providerResourceDispositionForRun,
    });
  } else {
    const legacyWarmLifecycle =
      executionTarget?.kind === "remote" &&
      executionTarget.transport === "sandbox" &&
      executionTarget.runnerLifecyclePolicy?.mode === "warm"
        ? resolveReusableSandboxLifecycle({
            lifecyclePolicy: executionTarget.runnerLifecyclePolicy,
            target: executionTarget,
          })
        : null;
    if (legacyWarmLifecycle?.sandboxResource === "keep_running") {
      providerResourceDispositionForRun = "keep_running";
      onProviderResourceDisposition(providerResourceDispositionForRun);
    }
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "legacy",
        runtimeModeResolverVersion:
          nativeRuntimeResolution.resolverVersion,
        runtimeModeReason: nativeRuntimeResolution.reason,
        runtimeModeResolvedAt: run.runtimeModeResolvedAt ?? new Date(),
        // Preserve server-owned admission and dispatch evidence on this
        // row; never copy another run's execution profile.
        runnerProfileJson: sql`(case when ${heartbeatRuns.runnerProfileJson} ? ${CHAT_CONTROL_RECOVERY_ADMISSION_KEY}
                then jsonb_build_object(${CHAT_CONTROL_RECOVERY_ADMISSION_KEY}::text, ${heartbeatRuns.runnerProfileJson}->${CHAT_CONTROL_RECOVERY_ADMISSION_KEY})
                else '{}'::jsonb end)
              || (case when ${heartbeatRuns.runnerProfileJson} ? 'adapterDispatch'
                then jsonb_build_object('adapterDispatch', ${heartbeatRuns.runnerProfileJson}->'adapterDispatch')
                else '{}'::jsonb end) || ${JSON.stringify(providerTraceRequested ? { providerTrace: { mode: "raw", traceId: providerTraceCapture?.metadata.id ?? null, maxBytes: PROVIDER_TRACE_MAX_BYTES } } : {})}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id));
  }
  return { selected: true, nativeExecution, nativeRunnerInstanceId, getNativeFreshSessionHandoff, nativeWorkspaceSync };
}
