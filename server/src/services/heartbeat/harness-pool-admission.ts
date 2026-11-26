import { harnessPoolEnvironmentScope } from "./harness-pool-environment.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agentTaskSessions, agentWakeupRequests, aiConnectionPools, aiConnectionTaskPins, agents, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, decodeHarnessPoolConfig, harnessPoolBindingSchema, type HarnessPoolExecutionSelection, type AiConnectionRouterSelection } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { unprocessable } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { aiConnectionRouterService, applyAiConnectionRouterTaskSettings, samePoolSelection } from "../ai-connection-router.js";
import { resolvePaperclipRunnerProviderProfile, type PaperclipRunnerProviderProfile } from "../native-runtime/provider-profile.js";
import { deriveTaskKeyWithHeartbeatFallback, shouldResetTaskSessionForWake } from "./run-state.js";
import { hasNativeLocalProcessStop } from "../native-local-process-stop.js";
import { readTaskRetryIntent } from "../task-retry.js";
import { readNativeReviewAssignmentContext } from "../native-runtime/native-review-participant.js";
import { AI_CONNECTION_POOL_WAIT_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { executionStartedEventPredicate, noRetainedExecutionPredicate } from "../pre-dispatch-execution-evidence.js";
import { isPoolPreDispatchCancellation } from "./quota-prestart-fence.js";

/** A completion review resolves through the Paperclip Runner review tool, so it
 * gets its own pool pin instead of inheriting the reviewer's task pin. */
export function harnessPoolReviewTaskKey(interactionId: string) {
  return `native-review:${interactionId}`;
}

export type HarnessPoolAdmission = { kind: "selected"; selection: HarnessPoolExecutionSelection;
  routerSelection: AiConnectionRouterSelection; taskKey: string; profile?: PaperclipRunnerProviderProfile };

/**
 * Authenticate a board reconciliation through its persisted action and queue
 * receipt. A retry parked at pool admission may inherit that authority only
 * through cancelled attempts that never dispatched a provider.
 */
async function reconciledQuotaSource(tx: Db, queued: typeof heartbeatRuns.$inferSelect, issueId: string) {
  const runContext = parseObject(queued.contextSnapshot);
  const actionId = z.uuid().safeParse(runContext.recoveryActionId);
  const sourceId = z.uuid().safeParse(runContext.previousRunId);
  if (runContext.source !== "execution.reconciled" || !actionId.success || !sourceId.success) return null;
  const scope = and(eq(heartbeatRuns.companyId, queued.companyId), eq(heartbeatRuns.agentId, queued.agentId),
    eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.scopeKind, "issue"));
  const [action] = await tx.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.id, actionId.data), eq(issueRecoveryActions.companyId, queued.companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.returnOwnerAgentId, queued.agentId),
    eq(issueRecoveryActions.kind, "active_run_watchdog"), eq(issueRecoveryActions.status, "resolved"),
    eq(issueRecoveryActions.ownerType, "board"),
  )).for("share");
  const evidence = parseObject(action?.evidence);
  const decision = parseObject(evidence.executionReconciliation);
  if (decision.runId !== sourceId.data || decision.providerStopped !== true ||
      !["completed", "not_performed", "mixed"].includes(String(decision.actionOutcome)) ||
      typeof decision.recordedAt !== "string" || typeof decision.actorId !== "string" ||
      typeof decision.outcomeEvidence !== "string" || decision.outcomeEvidence.trim().length < 20) return null;
  let run = queued;
  const seen = new Set<string>();
  while (seen.size < 20 && !seen.has(run.id)) {
    seen.add(run.id);
    const context = parseObject(run.contextSnapshot);
    if (context.recoveryActionId !== actionId.data || context.previousRunId !== sourceId.data ||
        context.issueId !== issueId || context.source !== "execution.reconciled" || context.forceFreshSession !== true) return null;
    const [wake] = run.wakeupRequestId ? await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.runId, run.id),
      eq(agentWakeupRequests.companyId, queued.companyId), eq(agentWakeupRequests.agentId, queued.agentId),
      eq(agentWakeupRequests.source, "automation"), eq(agentWakeupRequests.requestedByActorType, "system"),
      eq(agentWakeupRequests.triggerDetail, "system"),
    )).for("share") : [];
    if (!wake || wake.payload?.issueId !== issueId) return null;
    if (wake.reason === "issue_recovery_action_restored" &&
        wake.requestedByActorId === "execution-recovery" &&
        wake.idempotencyKey === `execution-reconciliation:${actionId.data}` &&
        wake.payload.recoveryActionId === actionId.data && context.retryOfRunId === sourceId.data &&
        (!run.retryOfRunId || run.retryOfRunId === sourceId.data)) {
      if (evidence.continuationDelivery === "delivered" && evidence.continuationRunId === run.id ||
          run.id === queued.id && evidence.continuationDelivery === "pending") return sourceId.data;
      return null;
    }
    if (run.scheduledRetryReason !== AI_CONNECTION_POOL_WAIT_RETRY_REASON || !run.retryOfRunId ||
        wake.reason !== "ai_connection_pool_retry" || wake.payload.retryOfRunId !== run.retryOfRunId ||
        wake.payload.retryReason !== AI_CONNECTION_POOL_WAIT_RETRY_REASON) return null;
    const [parent] = await tx.select().from(heartbeatRuns).where(and(scope, eq(heartbeatRuns.id, run.retryOfRunId))).for("share");
    if (!parent || !isPoolPreDispatchCancellation(parent)) return null;
    const [providerEvent] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.companyId, queued.companyId), eq(heartbeatRunEvents.runId, parent.id),
        executionStartedEventPredicate())).limit(1);
    if (providerEvent) return null;
    run = parent;
  }
  return null;
}

/** A stopped task's explicitly authorized fresh attempt can use a different
 * account. An ordinary wake still preserves affinity and the old receipts. */
async function switchFreshRetryQuotaPin(input: {
  db: Db; run: typeof heartbeatRuns.$inferSelect; agent: typeof agents.$inferSelect; userId: string | null;
  pin: typeof aiConnectionTaskPins.$inferSelect; environmentId: string; sourceAdapterConfig: Record<string, unknown>;
}): Promise<void> {
  const { db, run, agent, userId, pin, environmentId, sourceAdapterConfig } = input;
  const explicit = z.object({ commentId: z.null(), previousRunId: z.uuid(), taskRetryRequestId: z.uuid() })
    .safeParse(run.contextSnapshot?.explicitUserContinuation);
  if (!run.issueId || pin.taskKey !== run.issueId || run.contextSnapshot?.forceFreshSession !== true ||
      (!explicit.success && run.contextSnapshot.source !== "execution.reconciled")) return;
  const issueId = run.issueId;
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId))).for("update");
    if (!task || task.assigneeAgentId !== agent.id || task.assigneeUserId ||
        (task.checkoutRunId && task.checkoutRunId !== run.id) ||
        !["todo", "in_progress", "in_review"].includes(task.status)) return;
    // A reconciled continuation is admitted before claim binds the task. Its
    // durable queue receipt proves authority only while no other run owns it.
    if (task.executionRunId !== run.id && (explicit.success || task.executionRunId !== null)) return;
    const [queued] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.status, "queued"), isNull(heartbeatRuns.startedAt))).for("update");
    if (queued?.contextSnapshot?.forceFreshSession !== true) return;
    let previousRunId: string;
    if (explicit.success) {
      if (!isDeepStrictEqual(queued.contextSnapshot.explicitUserContinuation, run.contextSnapshot?.explicitUserContinuation)) return;
      const { previousRunId: explicitSource, taskRetryRequestId } = explicit.data;
      previousRunId = explicitSource;
      const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, run.companyId),
        eq(agentWakeupRequests.agentId, agent.id), eq(agentWakeupRequests.id, taskRetryRequestId), eq(agentWakeupRequests.runId, run.id),
        eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "coalesced"),
        eq(agentWakeupRequests.requestedByActorType, "user")));
      const retry = readTaskRetryIntent(wake?.payload);
      if (!wake || !retry || retry.generationId !== taskRetryRequestId || retry.sourceRunId !== previousRunId ||
          retry.strategy !== "fresh_isolated_workspace" || retry.actorId !== wake.requestedByActorId || wake.payload?.issueId !== issueId) return;
      const authority = { ...explicit.data, runId: run.id, actorId: retry.actorId };
      const [receipt] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->'explicitUserContinuation' @> ${JSON.stringify(authority)}::jsonb`,
      )).limit(1);
      if (!receipt && !Object.entries(authority).every(([key, value]) => parseObject(parseObject(wake.payload?.taskRetry).continuation)[key] === value)) return;
    } else {
      const [unstarted] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, queued.id), eq(heartbeatRuns.companyId, run.companyId), noRetainedExecutionPredicate()));
      if (!unstarted) return;
      const reconciledSource = await reconciledQuotaSource(tx, queued, issueId);
      if (!reconciledSource) return;
      previousRunId = reconciledSource;
    }
    const [source] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.id, previousRunId),
      eq(heartbeatRuns.status, "failed"), eq(heartbeatRuns.runtimeMode, "native"),
      eq(heartbeatRuns.errorCode, "native_provider_usage_limit")));
    const sourceSelection = source?.contextSnapshot?.aiRouterSelection as AiConnectionRouterSelection | undefined;
    if (!source?.finishedAt || source.contextSnapshot?.aiRouterTaskKey !== issueId || !sourceSelection ||
        !samePoolSelection(pin.selection, sourceSelection, agent.adapterType) ||
        !await hasNativeLocalProcessStop(tx, run.companyId, source.id)) return;
    const [finalization] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.issueId, issueId), eq(nativeRunFinalizations.runId, source.id))).for("update");
    if (finalization?.phase !== "terminal_failure" || finalization.leaseOwner ||
        finalization.failureCode !== "native_provider_usage_limit" ||
        finalization.failureDetail?.replacementDenied !== (explicit.success ? "explicit_user_continuation" : "operator_reconciled") || finalization.failureDetail.successorRunId) return;
    const [quota] = await tx.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, source.id),
      eq(heartbeatRunEvents.agentId, agent.id), eq(heartbeatRunEvents.eventType, "ai_connection.quota_attributed"),
      eq(heartbeatRunEvents.sourceEventId, `ai-connection-quota-attributed:${source.id}`), isNull(heartbeatRunEvents.sourceInstanceId),
    ));
    if (quota?.payload?.schema !== "paperclip.ai-connection-quota-attribution.v1" || quota.payload.runId !== source.id ||
        quota.payload.taskKey !== issueId || !isDeepStrictEqual(quota.payload.selection, sourceSelection)) return;
    const router = aiConnectionRouterService(tx);
    const cooldown = await router.currentMemberCooldown({ companyId: run.companyId, agentId: agent.id, userId,
      adapterType: agent.adapterType, member: pin.member, failureKind: "quota", sourceAdapterConfig });
    if (!cooldown?.retryAt) return;
    if (!explicit.success) {
      const [unreleased] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
        eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, source.id),
        isNull(environmentLeases.releasedAt))).limit(1);
      if (unreleased || source.responsibleUserId !== userId || source.processPid || source.processGroupId ||
          finalization.leaseExpiresAt || quota.payload.quotaIdentityHash !== cooldown.identityHash) return;
    }
    await router.transitionQuotaPin({ companyId: run.companyId, poolId: pin.poolId, agentId: agent.id, taskKey: issueId,
      expectedSelection: pin.selection, userId, adapterType: agent.adapterType, attemptedMemberIds: [pin.member.id],
      attemptedCredentialHashes: [cooldown.identityHash], requireSourceQuotaCooldown: true, environmentId, sourceAdapterConfig });
  });
}
export async function resolveHarnessPoolExecution(input: { db: Db; run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect; userId: string | null }): Promise<HarnessPoolAdmission> {
  const { db, run, agent, userId } = input;
  const binding = harnessPoolBindingSchema.parse(agent.runtimeConfig.harnessPool);
  if (agent.adapterType !== "paperclip_runner" || !(await instanceSettingsService(db).getExperimental()).enableNativeRunner)
    throw unprocessable("Pool harness requires an enabled Paperclip Runner");
  if (!run.issueId || run.scopeKind !== "issue") throw unprocessable("Pool harness requires a task");
  if (agent.runtimeConfig.aiConnection || agent.adapterConfig.homeMode === "preconfigured")
    throw unprocessable("Pool harness owns its model account; remove conflicting connection settings");
  const [pool] = await db.select().from(aiConnectionPools).where(and(eq(aiConnectionPools.companyId, agent.companyId), eq(aiConnectionPools.id, binding.poolId)));
  if (!pool || pool.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY || decodeHarnessPoolConfig(pool.config).kind !== "harness_pool")
    throw unprocessable("Choose an available harness pool");
  const context = parseObject(run.contextSnapshot);
  const review = readNativeReviewAssignmentContext(context);
  const taskKey = review ? harnessPoolReviewTaskKey(review.nativeReviewInteractionId)
    : typeof context.aiRouterTaskKey === "string" && context.aiRouterTaskKey.trim() ? context.aiRouterTaskKey : deriveTaskKeyWithHeartbeatFallback(context, null) ?? run.issueId;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, agent.companyId), eq(issues.id, run.issueId)));
  const [existingPin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, agent.companyId),
    eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent.id), eq(aiConnectionTaskPins.taskKey, taskKey)));
  const [session] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id),
    eq(agentTaskSessions.adapterType, existingPin?.selection.adapterType ?? "paperclip_runner"), eq(agentTaskSessions.taskKey, taskKey))).limit(1);
  const identity = session?.sessionParamsJson?.paperclipAiCredentialIdentity;
  const overrides = review ? {} : parseObject(parseObject(task?.assigneeAdapterOverrides).adapterConfig);
  const environmentId = await harnessPoolEnvironmentScope(db, agent, task, run);
  const sourceAdapterConfig = { ...agent.adapterConfig, ...overrides };
  if (!review && existingPin) await switchFreshRetryQuotaPin({ db, run, agent, userId, pin: existingPin, environmentId, sourceAdapterConfig });
  const routerSelection = await aiConnectionRouterService(db).resolve({ companyId: agent.companyId, agentId: agent.id, poolId: pool.id,
    adapterType: "paperclip_runner", environmentId, userId, taskKey, sourceAdapterConfig, overrides,
    existingGrantId: typeof identity === "string" ? identity.split(":")[0] : undefined,
    requireExisting: Boolean(session?.sessionDisplayId) && !shouldResetTaskSessionForWake(context), skipUsageProbe: true,
    requirePaperclipRunner: review !== null });
  const decoded = decodeHarnessPoolConfig(pool.config);
  if (decoded.kind !== "harness_pool") throw unprocessable("Invalid harness pool");
  const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, agent.companyId),
    eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent.id), eq(aiConnectionTaskPins.taskKey, taskKey)));
  const pinned = pin?.member && decodeHarnessPoolConfig({ ...pool.config, members: [pin.member] });
  const memberSnapshot = pinned?.kind === "harness_pool" ? pinned.config.members[0] : undefined;
  if (!memberSnapshot) throw unprocessable("The selected pool member is unavailable");
  // A retained pin owns its historical model profile, including after pool edits.
  const profile = routerSelection.adapterType === "paperclip_runner" ? resolvePaperclipRunnerProviderProfile(applyAiConnectionRouterTaskSettings(agent.adapterConfig, routerSelection, "paperclip_runner")) : undefined;
  if (routerSelection.binding.mode === "responsible_user") throw unprocessable("Pool members require an explicit account");
  const admittedMember = { ...memberSnapshot, connection: routerSelection.binding, model: String(routerSelection.runtimeConfig.model),
    effort: typeof routerSelection.runtimeConfig.modelReasoningEffort === "string" ? routerSelection.runtimeConfig.modelReasoningEffort
      : typeof routerSelection.runtimeConfig.reasoningEffort === "string" ? routerSelection.runtimeConfig.reasoningEffort
      : typeof routerSelection.runtimeConfig.effort === "string" ? routerSelection.runtimeConfig.effort : undefined };
  const selection: HarnessPoolExecutionSelection = { schemaVersion: 2, poolId: pool.id, poolRevision: pool.revision, poolName: decoded.config.name,
    memberId: routerSelection.memberId, memberSnapshot: admittedMember,
    fingerprint: createHash("sha256").update(JSON.stringify([routerSelection.binding, routerSelection.runtimeConfig, profile, routerSelection.runnerScope, ...(routerSelection.adapterType !== "paperclip_runner" ? [routerSelection.adapterType] : [])])).digest("hex") };
  return { kind: "selected", selection, routerSelection, taskKey, profile };
}
