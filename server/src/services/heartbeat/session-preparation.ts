import { and, desc, eq } from "drizzle-orm";
import { agentConfigRevisions, type Db, type agents, type agentTaskSessions, type heartbeatRuns, type issues, type projects } from "@paperclipai/db";
import type { AiConnectionBinding, AiRuntimeConnectionBinding } from "@paperclipai/shared";
import { getServerAdapter } from "../../adapters/index.js";
import type { prepareManagedAiRuntime } from "../ai-connection-runtime.js";
import { aiConnectionSessionCompatibilityInputs, managedAiSessionIdentityCompatible } from "../ai-connection-session.js";
import { createNativeSessionHandoffLoader } from "../native-runtime/native-session-handoff.js";
import { agentInstructionsService } from "../agent-instructions.js";
import {
  describeSessionResetReason, shouldResetTaskSessionForWake, isCanonicalSessionIdForAdapter,
  normalizeResumeParamsForAdapter, normalizeSessionParams, requiresCanonicalSessionIds,
  truncateDisplayId, type createHeartbeatRunState, type getAdapterSessionCodec,
} from "./run-state.js";
import {
  buildEffectiveRunSessionConfigMetadata, readConfigFingerprintFromSessionParams,
  readConfiguredModelFromAdapterConfig, resolveTaskSessionConfigFreshness,
  stripPaperclipSessionMetadataFromSessionParams, type EffectiveRunSessionConfigMetadata,
} from "./workspaces.js";
import type { HeartbeatWorkspacePreparationInput, prepareHeartbeatWorkspace } from "./workspace-preparation.js";
import type { prepareHeartbeatTaskContext } from "./task-context.js";

type RunState = ReturnType<typeof createHeartbeatRunState>;
type WorkspaceInput = HeartbeatWorkspacePreparationInput;
type PreparedWorkspace = Awaited<ReturnType<typeof prepareHeartbeatWorkspace>>;
type TaskContext = Awaited<ReturnType<typeof prepareHeartbeatTaskContext>>;
type SessionMetadataInput = Parameters<typeof buildEffectiveRunSessionConfigMetadata>[0];
type ManagedAiRuntime = Awaited<ReturnType<typeof prepareManagedAiRuntime>>;
type TaskSession = typeof agentTaskSessions.$inferSelect | null;
type SessionCodec = ReturnType<typeof getAdapterSessionCodec>;

export interface HeartbeatSessionPreparationInput {
  run: Pick<typeof heartbeatRuns.$inferSelect, "createdAt">;
  agent: typeof agents.$inferSelect;
  task: {
    context: Record<string, unknown>;
    issueRef: Pick<typeof issues.$inferSelect, "id"> | null;
    issueContext: Pick<typeof issues.$inferSelect, "updatedAt"> | null;
    taskProjectContext: Pick<typeof projects.$inferSelect, "env"> | null;
    workspaceProjectContext: Pick<typeof projects.$inferSelect, "updatedAt"> | null;
    wakeCommentId: string | null;
    acceptedPlanContinuationWake: boolean;
    acceptedPlanWakeRoutingDecision: unknown;
  };
  session: {
    taskSession: TaskSession;
    taskSessionDecodedParams: Record<string, unknown> | null;
    explicitResumeSessionParams: Record<string, unknown> | null;
    explicitResumeSessionDisplayId: string | null;
    sessionCodec: SessionCodec;
  };
  config: {
    runtimeConfig: Record<string, unknown>;
    agentIdentity: { keyId: string } | undefined;
    issueAssigneeOverrides: unknown;
    originalAiIssueOverrides: unknown;
    managedAiRuntime: ManagedAiRuntime | undefined;
    aiBinding: AiConnectionBinding | undefined;
    requestedAiBinding: AiRuntimeConnectionBinding | undefined;
    secretManifest: SessionMetadataInput["secretManifest"];
    runtimeSkillEntries: SessionMetadataInput["runtimeSkills"];
    routineEnvContext: { env: unknown };
  };
  workspace: Pick<WorkspaceInput["policy"], "requestedExecutionWorkspaceMode" | "effectiveExecutionWorkspaceMode" | "projectExecutionWorkspacePolicy" | "issueExecutionWorkspaceSettings" | "executionPolicy"> & {
    requestedReusableExecutionWorkspaceConfig: NonNullable<WorkspaceInput["reuse"]["reusableExistingExecutionWorkspace"]>["config"] | null;
    reusableExistingExecutionWorkspace: WorkspaceInput["reuse"]["reusableExistingExecutionWorkspace"];
  };
  environment: Pick<WorkspaceInput["environment"], "environmentResolution" | "selectedEnvironmentId" | "selectedEnvironmentForConfig">;
  getLatestAgentConfigRevision: RunState["getLatestAgentConfigRevision"];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Selects a resumable session before workspace preparation; acquires no runtime resources. */
export async function prepareHeartbeatSession(db: Db, input: HeartbeatSessionPreparationInput) {
  const { run, agent, getLatestAgentConfigRevision } = input;
  const { context, issueRef, issueContext, taskProjectContext, workspaceProjectContext, wakeCommentId, acceptedPlanContinuationWake, acceptedPlanWakeRoutingDecision } = input.task;
  const { taskSession, taskSessionDecodedParams, explicitResumeSessionParams, explicitResumeSessionDisplayId, sessionCodec } = input.session;
  const { runtimeConfig, agentIdentity, issueAssigneeOverrides, originalAiIssueOverrides, managedAiRuntime, aiBinding, requestedAiBinding, secretManifest, runtimeSkillEntries, routineEnvContext } = input.config;
  const { requestedExecutionWorkspaceMode, effectiveExecutionWorkspaceMode, projectExecutionWorkspacePolicy, issueExecutionWorkspaceSettings, executionPolicy, requestedReusableExecutionWorkspaceConfig, reusableExistingExecutionWorkspace } = input.workspace;
  const { environmentResolution, selectedEnvironmentId, selectedEnvironmentForConfig } = input.environment;
  const latestAgentConfigRevision = await getLatestAgentConfigRevision(
    agent.companyId,
    agent.id,
  );
  const sessionConfigMetadataInput = {
      agentIdentityKeyId: agentIdentity?.keyId,
      adapterType: agent.adapterType,
      effectiveAdapterConfig: runtimeConfig,
      managedInstructions: await agentInstructionsService(db).getManagedEntryFingerprint({ ...agent, adapterConfig: runtimeConfig }),
      managedAiHome: managedAiRuntime?.home,
      agentRuntimeConfig: agent.runtimeConfig,
      issueOverrides: issueAssigneeOverrides,
      workspaceConfig: {
        requestedMode: requestedExecutionWorkspaceMode,
        effectiveMode: effectiveExecutionWorkspaceMode,
        issueConfigRevisionAt:
          issueContext?.updatedAt instanceof Date
            ? issueContext.updatedAt.toISOString()
            : (issueContext?.updatedAt ?? null),
        projectConfigRevisionAt:
          workspaceProjectContext?.updatedAt instanceof Date
            ? workspaceProjectContext.updatedAt.toISOString()
            : (workspaceProjectContext?.updatedAt ?? null),
        projectPolicy: projectExecutionWorkspacePolicy,
        issueSettings: issueExecutionWorkspaceSettings,
        reusableExecutionWorkspaceConfig:
          requestedReusableExecutionWorkspaceConfig,
        existingExecutionWorkspace: reusableExistingExecutionWorkspace
          ? {
              id: reusableExistingExecutionWorkspace.id,
              mode: reusableExistingExecutionWorkspace.mode,
              strategyType: reusableExistingExecutionWorkspace.strategyType,
              projectWorkspaceId:
                reusableExistingExecutionWorkspace.projectWorkspaceId,
              repoUrl: reusableExistingExecutionWorkspace.repoUrl,
              baseRef: reusableExistingExecutionWorkspace.baseRef,
              branchName: reusableExistingExecutionWorkspace.branchName,
              config: reusableExistingExecutionWorkspace.config,
            }
          : null,
      },
      environment: {
        selectionSource: environmentResolution.source,
        selectedEnvironmentId,
        selectedEnvironment: selectedEnvironmentForConfig
          ? {
              id: selectedEnvironmentForConfig.id,
              driver: selectedEnvironmentForConfig.driver,
              config: selectedEnvironmentForConfig.config,
              configRevisionAt:
                selectedEnvironmentForConfig.updatedAt instanceof Date
                  ? selectedEnvironmentForConfig.updatedAt.toISOString()
                  : (selectedEnvironmentForConfig.updatedAt ?? null),
            }
          : null,
        executionPolicy,
      },
      environmentEnv: selectedEnvironmentForConfig?.envVars ?? null,
      projectEnv: taskProjectContext?.env ?? null,
      routineEnv: routineEnvContext.env,
      secretManifest,
      runtimeSkills: runtimeSkillEntries,
      agentConfigRevision: latestAgentConfigRevision
        ? {
            id: latestAgentConfigRevision.id,
            changedKeys: latestAgentConfigRevision.changedKeys,
            configRevisionAt:
              latestAgentConfigRevision.createdAt.toISOString(),
          }
        : null,
    };
  const sessionConfigMetadata = await buildEffectiveRunSessionConfigMetadata(sessionConfigMetadataInput);
  let compatibleConfigMetadata: EffectiveRunSessionConfigMetadata[] = [];
  if (managedAiRuntime && aiBinding && taskSession &&
    readConfigFingerprintFromSessionParams(taskSession.sessionParamsJson)?.fingerprint !== sessionConfigMetadata.fingerprint) {
    const revisions = requestedAiBinding?.mode === "router"
      ? await db.select().from(agentConfigRevisions).where(and(eq(agentConfigRevisions.companyId, agent.companyId), eq(agentConfigRevisions.agentId, agent.id))).orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id)).limit(21)
      : [];
    const candidates = aiConnectionSessionCompatibilityInputs({
      effectiveAdapterConfig: runtimeConfig, agentRuntimeConfig: agent.runtimeConfig,
      agentConfigRevision: sessionConfigMetadataInput.agentConfigRevision,
      issueOverrides: issueAssigneeOverrides, originalIssueOverrides: originalAiIssueOverrides,
      binding: aiBinding, router: requestedAiBinding?.mode === "router",
      storedIdentity: taskSession.sessionParamsJson?.paperclipAiCredentialIdentity,
      sessionIdentity: managedAiRuntime.sessionIdentity, credentialIdentity: managedAiRuntime.identity, revisions,
    });
    compatibleConfigMetadata = await Promise.all(candidates.map(candidate => buildEffectiveRunSessionConfigMetadata({ ...sessionConfigMetadataInput, ...candidate })));
  }
  const configuredModel =
    readConfiguredModelFromAdapterConfig(runtimeConfig);
  if (context.refreshTools === true && agent.adapterType !== "paperclip_runner") {
    const capability = getServerAdapter(agent.adapterType).supportsToolRefreshOnResume;
    const canRefresh = typeof capability === "function" ? capability(runtimeConfig) : capability === true;
    if (!canRefresh) context.forceFreshSession = true;
  }
  const wakeSessionResetReason = describeSessionResetReason(context);
  const sessionConfigFreshness = resolveTaskSessionConfigFreshness({
    hasTaskSession: taskSession != null,
    configuredModel,
    taskSessionParams:
      taskSession?.sessionParamsJson ?? taskSessionDecodedParams,
    configMetadata: sessionConfigMetadata,
    compatibleConfigMetadata,
    wakeResetReason: wakeSessionResetReason,
    preserveLegacySessionWithoutConfigMetadata:
      acceptedPlanContinuationWake && !acceptedPlanWakeRoutingDecision && !agentIdentity,
  });
  const resetTaskSession =
    context.workspaceSelectionChanged === true || shouldResetTaskSessionForWake(context) || sessionConfigFreshness.reset;
  const sessionResetReason =
    sessionConfigFreshness.reasons.join("; ") || null;
  const taskSessionForRun = resetTaskSession ? null : taskSession;
  const getFreshSessionHandoff = issueRef ? createNativeSessionHandoffLoader({
    db, companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id, before: run.createdAt,
    throughCommentId: readNonEmptyString(context.conversationReplayThroughCommentId) ?? (context.interactionKind ? null : wakeCommentId),
  }) : undefined;
  const previousSessionParams =
    explicitResumeSessionParams ??
    (isCanonicalSessionIdForAdapter(
      agent.adapterType,
      explicitResumeSessionDisplayId,
    )
      ? { sessionId: explicitResumeSessionDisplayId }
      : null) ??
    normalizeResumeParamsForAdapter(
      agent.adapterType,
      stripPaperclipSessionMetadataFromSessionParams(
        sessionCodec.deserialize(
          taskSessionForRun?.sessionParamsJson ?? null,
        ),
      ),
    );
  // Legacy plugins can consume the existing context field on a known-fresh
  // dispatch. Built-ins also load lazily if their resume attempt fails.
  if (agent.adapterType !== "paperclip_runner" && !previousSessionParams && getFreshSessionHandoff) {
    const handoff = await getFreshSessionHandoff();
    if (handoff) context.paperclipFreshSessionHandoffMarkdown = handoff;
  }
  return { sessionConfigMetadata, configuredModel, sessionConfigFreshness, resetTaskSession, sessionResetReason, taskSessionForRun, getFreshSessionHandoff, previousSessionParams };
}

export interface HeartbeatAdapterSessionInput {
  agent: typeof agents.$inferSelect;
  task: {
    context: Record<string, unknown>;
    taskKey: string | null;
    issueId: string | null;
    continuationSummary: TaskContext["continuationSummary"];
    executionContinuation: TaskContext["executionContinuation"];
  };
  session: {
    runtime: { sessionId: string | null };
    taskSession: TaskSession;
    sessionCodec: SessionCodec;
    explicitResumeSessionDisplayId: string | null;
    runtimeSessionParams: Record<string, unknown> | null;
    managedAiRuntime: ManagedAiRuntime | undefined;
    prepared: Awaited<ReturnType<typeof prepareHeartbeatSession>>;
  };
  workspace: Pick<PreparedWorkspace, "latestWorkspaceConfigMetadata" | "workspaceConfigFreshness" | "reusedExecutionWorkspace" | "resolvedWorkspaceReusePolicy" | "persistedExecutionWorkspace"> & {
    runtimeWorkspaceWarnings: string[];
    requestedShouldReuseExisting: boolean;
    workspaceReuseRequest: WorkspaceInput["reuse"]["workspaceReuseRequest"];
  };
  evaluateSessionCompaction: RunState["evaluateSessionCompaction"];
}

/** Resolves adapter identity after workspace preparation, retaining in-place context and delta updates. */
export async function resolveHeartbeatAdapterSession(input: HeartbeatAdapterSessionInput) {
  const { agent, evaluateSessionCompaction } = input;
  const { context, taskKey, issueId, continuationSummary, executionContinuation } = input.task;
  const { runtime, taskSession, sessionCodec, explicitResumeSessionDisplayId, runtimeSessionParams, managedAiRuntime, prepared } = input.session;
  const { sessionConfigMetadata, sessionConfigFreshness, resetTaskSession, taskSessionForRun, previousSessionParams } = prepared;
  const { latestWorkspaceConfigMetadata, workspaceConfigFreshness, reusedExecutionWorkspace, resolvedWorkspaceReusePolicy, persistedExecutionWorkspace, runtimeWorkspaceWarnings, requestedShouldReuseExisting, workspaceReuseRequest } = input.workspace;
  const runtimeSessionFallback =
    taskKey || resetTaskSession
      ? null
      : isCanonicalSessionIdForAdapter(agent.adapterType, runtime.sessionId)
        ? runtime.sessionId
        : null;
  const runtimeSessionDisplayId = truncateDisplayId(
    explicitResumeSessionDisplayId ??
      taskSessionForRun?.sessionDisplayId ??
      (sessionCodec.getDisplayId
        ? sessionCodec.getDisplayId(runtimeSessionParams)
        : null) ??
      readNonEmptyString(runtimeSessionParams?.sessionId) ??
      runtimeSessionFallback,
  );
  let previousSessionDisplayId = requiresCanonicalSessionIds(
    agent.adapterType,
  )
    ? truncateDisplayId(
        readNonEmptyString(previousSessionParams?.sessionId) ??
          (isCanonicalSessionIdForAdapter(
            agent.adapterType,
            runtimeSessionDisplayId,
          )
            ? runtimeSessionDisplayId
            : null) ??
          runtimeSessionFallback,
      )
    : runtimeSessionDisplayId;
  let runtimeSessionIdForAdapter =
    readNonEmptyString(runtimeSessionParams?.sessionId) ??
    runtimeSessionFallback;
  let runtimeSessionParamsForAdapter = normalizeSessionParams(
    stripPaperclipSessionMetadataFromSessionParams(runtimeSessionParams),
  );

  const sessionCompaction = await evaluateSessionCompaction({
    agent,
    sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
    issueId,
    continuationSummaryBody: continuationSummary?.body ?? null,
  });
  if (sessionCompaction.rotate) {
    context.paperclipSessionHandoffMarkdown =
      sessionCompaction.handoffMarkdown;
    context.paperclipSessionRotationReason = sessionCompaction.reason;
    context.paperclipPreviousSessionId =
      previousSessionDisplayId ?? runtimeSessionIdForAdapter;
    runtimeSessionIdForAdapter = null;
    runtimeSessionParamsForAdapter = null;
    previousSessionDisplayId = null;
    if (sessionCompaction.reason) {
      runtimeWorkspaceWarnings.push(
        `Starting a fresh session because ${sessionCompaction.reason}.`,
      );
    }
  } else {
    delete context.paperclipSessionHandoffMarkdown;
    delete context.paperclipSessionRotationReason;
    delete context.paperclipPreviousSessionId;
  }

  const taskSessionCredentialCompatible = !managedAiRuntime || managedAiSessionIdentityCompatible(
    taskSession?.sessionParamsJson?.paperclipAiCredentialIdentity,
    managedAiRuntime.sessionIdentity,
    managedAiRuntime.identity,
  );
  if (managedAiRuntime) {
    sessionConfigMetadata.aiCredentialIdentity = managedAiRuntime.sessionIdentity;
    if (!taskSessionCredentialCompatible) {
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      delete executionContinuation?.resumeDelta;
    }
  }
  const runtimeForAdapter = {
    sessionId: runtimeSessionIdForAdapter,
    sessionParams: runtimeSessionParamsForAdapter,
    sessionDisplayId: previousSessionDisplayId,
    taskKey,
  };
  // A delta is safe only when the selected provider session is exactly the
  // task session whose last dispatch supplied the baseline history.
  if (
    executionContinuation?.resumeDelta &&
    (!taskSessionForRun ||
      !taskSession?.sessionDisplayId ||
      runtimeForAdapter.sessionDisplayId !== taskSession.sessionDisplayId ||
      resetTaskSession ||
      context.forceFreshSession === true)
  ) {
    delete executionContinuation.resumeDelta;
  }
  const configFreshnessResultMetadata = {
    version: sessionConfigMetadata.version,
    session: {
      fingerprintVersion: sessionConfigMetadata.version,
      categories: sessionConfigMetadata.categories,
      reset: resetTaskSession,
      resetReasons: sessionConfigFreshness.reasons,
      changedCategories: sessionConfigFreshness.changedCategories,
      taskSessionAvailable: taskSession != null,
      taskSessionReused: taskSessionForRun != null,
      storedFingerprintPresent: Boolean(
        sessionConfigFreshness.storedFingerprint,
      ),
      nextFingerprint: sessionConfigFreshness.nextFingerprint,
    },
    workspace: {
      fingerprintVersion: latestWorkspaceConfigMetadata.version,
      categories: latestWorkspaceConfigMetadata.categories,
      action: workspaceConfigFreshness.action,
      changedCategories: workspaceConfigFreshness.changedCategories,
      reasons: workspaceConfigFreshness.reasons,
      reuseRequested: requestedShouldReuseExisting,
      workspaceReused: Boolean(reusedExecutionWorkspace),
      configSnapshotRefreshed:
        resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
      storedFingerprintPresent:
        workspaceConfigFreshness.storedFingerprintPresent,
      storedFingerprint: workspaceConfigFreshness.storedFingerprint,
      inferredFingerprint: workspaceConfigFreshness.inferredFingerprint,
      nextFingerprint: workspaceConfigFreshness.nextFingerprint,
      previousWorkspaceId:
        workspaceReuseRequest.requestedExecutionWorkspaceId,
      activeWorkspaceId: persistedExecutionWorkspace?.id ?? null,
    },
  };

  return { previousSessionDisplayId, runtimeSessionParamsForAdapter, taskSessionCredentialCompatible, runtimeForAdapter, configFreshnessResultMetadata, sessionCompaction };
}
