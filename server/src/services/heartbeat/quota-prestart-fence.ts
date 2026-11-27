import { and, eq, gte, inArray, isNull, ne, not, or, sql } from "drizzle-orm";
import {
  agentTaskSessions, agentWakeupRequests, agents, aiConnectionTaskPins, approvals, environmentLeases,
  heartbeatRunEvents, heartbeatRuns, issueApprovals, issueThreadInteractions, issues, nativeRunFinalizations,
  nativeRunResults, toolInvocations, type Db,
} from "@paperclipai/db";
import { effectiveAiConnectionInput, type AiConnectionRouterSelection } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { AI_CONNECTION_POOL_WAIT_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { isConversation } from "../../lib/conversation-wake-policy.js";
import { aiConnectionRouterService, samePoolSelection } from "../ai-connection-router.js";
import { getExecutionBlocker, hasPendingRunCleanup } from "../execution-blocker.js";
import { activeIssueInteractionCondition } from "../issue-question-context.js";
import { legacyRunHasUnsettledActions, nativeRunHasUnsettledActions } from "../legacy-action-outcomes.js";
import { executionStartedEventPredicate, noRetainedExecutionPredicate } from "../pre-dispatch-execution-evidence.js";
import { hasRequiredWorkspaceRecovery } from "../workspace-restore-recovery-state.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { conflict, HttpError } from "../../errors.js";
import { cancellationRequestId } from "../native-runtime/native-cancellation-request.js";
import { poolFailureKind } from "./pool-failover.js";
import { harnessPoolEnvironmentScope } from "./harness-pool-environment.js";
import { instanceSettingsService } from "../instance-settings.js";

const KEY = "legacyQuotaPrestartFence";

/** Called only from a first durable queue claim, before run preparation. */
export function legacyQuotaFenceForFirstClaim(agent: { adapterType: string; runtimeConfig: unknown }, run: {
  id: string; companyId: string; agentId: string; startedAt: Date | null; runnerProfileJson: Record<string, unknown> | null;
}): Record<string, unknown> {
  const config = agent.runtimeConfig && typeof agent.runtimeConfig === "object" && !Array.isArray(agent.runtimeConfig)
    ? agent.runtimeConfig as Record<string, unknown> : {};
  const binding = config.aiConnection && typeof config.aiConnection === "object" && !Array.isArray(config.aiConnection)
    ? config.aiConnection as Record<string, unknown> : {};
  if (agent.adapterType !== "claude_local" || binding.mode !== "router" || run.startedAt !== null ||
      (run.runnerProfileJson && Object.hasOwn(run.runnerProfileJson, KEY))) return {};
  return { [KEY]: { schema: "paperclip.legacy-quota-prestart.v1", companyId: run.companyId,
    agentId: run.agentId, runId: run.id, state: "preparing" } };
}

/** Consume before any provider-capable preparation. Old runs remain unproven.
 * This state alone is never a provider-stop, action-outcome, or handoff proof. */
export async function consumeLegacyQuotaPrestartFence(db: Db, run: { id: string; companyId: string; agentId: string }): Promise<void> {
  await db.transaction(async tx => {
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId))).for("update");
    const profile = current?.runnerProfileJson;
    const raw = profile?.[KEY];
    if (!raw) return;
    if (!current || current.status !== "running" || typeof raw !== "object" || Array.isArray(raw) ||
        (raw as Record<string, unknown>).schema !== "paperclip.legacy-quota-prestart.v1" ||
        (raw as Record<string, unknown>).companyId !== run.companyId || (raw as Record<string, unknown>).agentId !== run.agentId ||
        (raw as Record<string, unknown>).runId !== run.id || !["preparing", "consumed"].includes(String((raw as Record<string, unknown>).state)))
      throw new Error("legacy_quota_prestart_fence_invalid");
    if ((raw as Record<string, unknown>).state === "consumed") return;
    await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, [KEY]: { ...raw, state: "consumed" } }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "running")));
  });
}

/** Caller holds issue and run locks and inserts the successor in this transaction. */
export async function switchUnstartedLegacyQuotaPin(tx: Db, input: { companyId: string; runId: string; issueId: string; agentId: string; userId: string | null }) {
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).for("share");
  const fence = run?.runnerProfileJson?.[KEY] as Record<string, unknown> | undefined;
  const recovery = run?.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  const cancellation = run?.resultJson?.cancellation as Record<string, unknown> | undefined;
  const bindingValue = agent?.runtimeConfig?.aiConnection;
  const binding = bindingValue && typeof bindingValue === "object" && !Array.isArray(bindingValue)
    ? bindingValue as Record<string, unknown> : {};
  const poolId = typeof binding.connectionId === "string" ? binding.connectionId : null;
  if (!run || !issue || !agent || agent.adapterType !== "claude_local" || agent.status === "paused" || agent.status === "terminated" ||
      binding.mode !== "router" || !poolId || run.scopeKind !== "issue" || run.issueId !== input.issueId ||
      run.status !== "cancelled" || run.errorCode !== "ai_connection_pool_exhausted" || !run.finishedAt || !run.startedAt ||
      run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdBefore || run.sessionIdAfter || run.runtimeModeResolvedAt ||
      run.contextSnapshot?.resumeSessionParams != null || run.contextSnapshot?.resumeSessionDisplayId != null ||
      run.contextSnapshot?.executionContinuation != null || run.contextSnapshot?.paperclipContinuationSummary != null ||
      run.contextSnapshot?.previousRunId != null ||
      recovery?.kind !== "ai_connection_wait" || recovery.providerWorkStarted !== false ||
      cancellation?.source !== "control_plane" || cancellation.reason !== "Waiting for an AI connection pool account" ||
      run.resultJson?.executionCancellation != null || run.resultJson?.startupCancellation != null || run.resultJson?.legacyQuotaStopRequested != null ||
      fence?.schema !== "paperclip.legacy-quota-prestart.v1" || fence.state !== "preparing" || fence.runId !== run.id ||
      fence.companyId !== run.companyId || fence.agentId !== run.agentId ||
      issue.executionRunId !== run.id || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId ||
      !["todo", "in_progress", "in_review"].includes(issue.status) || run.contextSnapshot?.aiRouterTaskKey !== issue.id) return null;
  const aliases = [issue.id, ...(issue.identifier ? [issue.identifier] : [])];
  const [other] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).leftJoin(agentWakeupRequests,
    and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId), eq(agentWakeupRequests.companyId, heartbeatRuns.companyId)))
    .where(and(eq(heartbeatRuns.companyId, input.companyId), ne(heartbeatRuns.id, run.id), or(
      eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
      ...["issueId", "taskId", "taskKey"].flatMap(key => aliases.flatMap(alias => [
        sql`${heartbeatRuns.contextSnapshot}->>${key} = ${alias}`, sql`${agentWakeupRequests.payload}->>${key} = ${alias}`,
      ])),
    ))).limit(1);
  const [session] = await tx.select({ id: agentTaskSessions.id }).from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, input.companyId),
    inArray(agentTaskSessions.taskKey, [issue.id, ...(issue.identifier ? [issue.identifier] : [])]))).limit(1);
  if (other || session) return null;
  const [pin] = await tx.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, input.companyId),
    eq(aiConnectionTaskPins.poolId, poolId), eq(aiConnectionTaskPins.agentId, input.agentId), eq(aiConnectionTaskPins.taskKey, issue.id))).limit(1);
  if (!pin || pin.createdAt < run.startedAt || pin.createdAt > run.finishedAt) return null;
  const result = await aiConnectionRouterService(tx).transitionQuotaPin({ companyId: input.companyId, poolId,
    agentId: input.agentId, taskKey: issue.id, expectedSelection: pin.selection, userId: input.userId,
    adapterType: "claude_local", attemptedMemberIds: [pin.member.id] });
  return result.kind === "selected" ? result.selection : null;
}

type Run = typeof heartbeatRuns.$inferSelect;
type HistoricalQuotaHandoff = { selection: AiConnectionRouterSelection; sourceRunId: string; predecessorRunId: string };

export function isPoolPreDispatchCancellation(run: Run): boolean {
  const recovery = parseObject(run.resultJson?.executionRecovery);
  const cancellation = parseObject(run.resultJson?.cancellation);
  return run.status === "cancelled" && run.errorCode === "ai_connection_pool_exhausted" && run.scopeKind === "issue" &&
    Boolean(run.issueId && run.startedAt && run.finishedAt && run.startedAt <= run.finishedAt) &&
    recovery.kind === "ai_connection_wait" && recovery.providerWorkStarted === false &&
    cancellation.source === "control_plane" && cancellation.expected === true &&
    parseObject(cancellation.initiator).type === "system" && cancellation.reason === "Waiting for an AI connection pool account" &&
    !run.runtimeModeResolvedAt && !run.runnerInstanceId && !run.nativeIssueId && !run.nativeSessionId &&
    !run.controllerLeaseExpiresAt && !run.executionControlDeadlineAt &&
    !run.processPid && !run.processGroupId && !run.processStartedAt && !run.sessionIdAfter &&
    (!run.executionStage || run.executionStage === "preparing" || run.executionStage === "settled");
}

function hasStopRequest(run: Run): boolean {
  return Boolean(run.resultJson?.executionCancellation || run.resultJson?.startupCancellation ||
    run.resultJson?.nativeCancellation || run.resultJson?.legacyQuotaStopRequested);
}

/** For a settled turn, the last session identifies the predecessor but grants
 * no execution authority. The provider and workspace must both be settled. */
async function historicalClaudeTurnSettled(tx: Db, run: Run): Promise<boolean> {
  if (run.status !== "succeeded" || !run.startedAt || !run.finishedAt || run.startedAt > run.finishedAt ||
      run.controllerLeaseExpiresAt || run.executionControlDeadlineAt ||
      hasStopRequest(run) || hasRequiredWorkspaceRecovery(run.resultJson)) return false;
  const unknownReceipt = (values: unknown) => Object.values(parseObject(values)).some(value =>
    parseObject(parseObject(value).result).outcome === "unknown");
  if (unknownReceipt(run.resultJson?.apiToolReceipts) || unknownReceipt(run.resultJson?.semanticToolReceipts)) return false;
  if (run.runtimeMode === "legacy") {
    const settlement = parseObject(run.resultJson?.executionSettlement);
    if (settlement.providerStopped !== true || settlement.workspaceSettled !== true ||
        run.resultJson?.acpToolInventoryComplete !== true || run.resultJson?.acpPendingToolCount !== 0) return false;
  } else if (run.runtimeMode === "native" && run.nativeIssueId === run.issueId &&
      run.resultJson?.workspaceFinalizeStatus === "succeeded") {
    const [result] = await tx.select({ id: nativeRunResults.id }).from(nativeRunFinalizations)
      .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.companyId, nativeRunFinalizations.companyId),
        eq(nativeRunResults.issueId, nativeRunFinalizations.issueId), eq(nativeRunResults.runId, nativeRunFinalizations.runId)))
      .where(and(eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.issueId, run.issueId!),
        eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.phase, "committed"),
        isNull(nativeRunFinalizations.leaseOwner), isNull(nativeRunFinalizations.leaseExpiresAt),
        isNull(nativeRunFinalizations.controlDeadlineAt), isNull(nativeRunFinalizations.failureCode),
        eq(nativeRunResults.schemaStatus, "accepted"))).for("share");
    if (!result || Object.values(parseObject(run.resultJson?.semanticToolReceipts)).some(value => {
      const receipt = parseObject(value);
      return typeof receipt.operationId !== "string" || !Object.hasOwn(receipt, "result");
    })) return false;
  } else return false;
  return !await hasPendingRunCleanup(tx, run.companyId, run.id) &&
    !await (run.runtimeMode === "native" ? nativeRunHasUnsettledActions(tx, run) : legacyRunHasUnsettledActions(tx, run));
}

/** The caller owns the issue and the held run locks and will bind the new
 * selection to that issue's only eligible successor in this transaction. */
export async function switchHistoricalQuotaPin(tx: Db, input: {
  source: Run; issueId: string; executionRunId: string; userId: string | null;
}): Promise<HistoricalQuotaHandoff | { retryAt: Date } | null> {
  const { source, issueId, executionRunId, userId } = input;
  if (!isPoolPreDispatchCancellation(source) || hasStopRequest(source) || source.issueId !== issueId ||
      !userId || source.responsibleUserId !== userId || hasRequiredWorkspaceRecovery(source.resultJson)) return null;
  const context = parseObject(source.contextSnapshot);
  const profile = parseObject(source.runnerProfileJson);
  const fence = parseObject(profile[KEY]);
  if (context.issueId !== issueId || context.aiRouterTaskKey !== issueId ||
      ["explicitUserContinuation", "interactionId", "continuationPolicy", "resumeSessionParams", "resumeSessionDisplayId",
        "chatThreadId", "conversationId", "chatCompletionDeliveryIds"].some(key => context[key] != null) ||
      ["nativeExecutionInput", "nativeWorkspaceSync", "remoteWorkspace", "nativeWorkspaceFinalizationOwner", "sessionCheckpoint"]
        .some(key => profile[key] != null) ||
      (profile[KEY] != null && (fence.schema !== "paperclip.legacy-quota-prestart.v1" || fence.state !== "preparing" ||
        fence.companyId !== source.companyId || fence.agentId !== source.agentId || fence.runId !== source.id))) return null;

  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, source.companyId)));
  const [agent] = await tx.select().from(agents).where(and(eq(agents.id, source.agentId), eq(agents.companyId, source.companyId))).for("share");
  const binding = parseObject(effectiveAiConnectionInput(agent?.runtimeConfig));
  const poolId = typeof binding.connectionId === "string" ? binding.connectionId : null;
  if (!issue || !agent || !["claude_local", "paperclip_runner"].includes(agent.adapterType) ||
      ["paused", "terminated", "pending_approval"].includes(agent.status) || agent.lifecycleState !== "ready" ||
      binding.mode !== "router" || !poolId || context.aiRouterPoolId !== poolId ||
      issue.executionRunId !== executionRunId || (issue.checkoutRunId && issue.checkoutRunId !== executionRunId) ||
      issue.assigneeAgentId !== source.agentId || issue.assigneeUserId ||
      (issue.responsibleUserId && issue.responsibleUserId !== userId) || issue.hiddenAt || isConversation(issue) ||
      !["todo", "in_progress", "in_review"].includes(issue.status)) return null;

  const [pin] = await tx.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, source.companyId),
    eq(aiConnectionTaskPins.poolId, poolId), eq(aiConnectionTaskPins.agentId, source.agentId), eq(aiConnectionTaskPins.taskKey, issueId)));
  if (!pin || pin.member.binding.provider !== "anthropic") return null;
  const previousSelection = context.aiRouterSelection as AiConnectionRouterSelection | undefined;
  const dispatch = parseObject(profile.adapterDispatch);
  const failure = parseObject(dispatch.poolPreparationFailure);
  const matchedSource = previousSelection ? samePoolSelection(pin.selection, previousSelection, agent.adapterType)
    : dispatch.adapterType === agent.adapterType && failure.kind === "exhausted" && failure.poolId === poolId &&
      typeof failure.retryAt === "string" && Number.isFinite(Date.parse(failure.retryAt)) &&
      failure.retryAt === source.resultJson?.retryAt;
  if (!matchedSource) return null;
  const priorAdapter = pin.selection.adapterType ?? agent.adapterType;
  if (!["claude_local", "paperclip_runner"].includes(priorAdapter)) return null;

  const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, source.companyId),
    eq(agentTaskSessions.agentId, source.agentId), eq(agentTaskSessions.adapterType, priorAdapter),
    eq(agentTaskSessions.taskKey, issueId))).for("share");
  if (!session?.lastRunId || !session.sessionDisplayId || (source.sessionIdBefore && source.sessionIdBefore !== session.sessionDisplayId)) return null;
  const [predecessor] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, session.lastRunId),
    eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.agentId, source.agentId),
    eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.scopeKind, "issue"))).for("share");
  const predecessorSelection = predecessor?.contextSnapshot?.aiRouterSelection as AiConnectionRouterSelection | undefined;
  if (!predecessor?.finishedAt || predecessor.finishedAt >= source.startedAt! || pin.createdAt > predecessor.finishedAt ||
      predecessor.responsibleUserId !== userId || predecessor.sessionIdAfter !== session.sessionDisplayId ||
      (predecessor.runtimeMode === "native") !== (priorAdapter === "paperclip_runner") ||
      predecessor.contextSnapshot?.issueId !== issueId || predecessor.contextSnapshot?.aiRouterTaskKey !== issueId ||
      !predecessorSelection || !samePoolSelection(pin.selection, predecessorSelection, agent.adapterType) ||
      !await historicalClaudeTurnSettled(tx, predecessor)) return null;

  const aliases = [issueId, ...(issue.identifier ? [issue.identifier] : [])];
  const [competing] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).leftJoin(agentWakeupRequests,
    and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId), eq(agentWakeupRequests.companyId, heartbeatRuns.companyId)))
    .where(and(eq(heartbeatRuns.companyId, source.companyId), ne(heartbeatRuns.id, source.id), ne(heartbeatRuns.id, executionRunId),
      ne(heartbeatRuns.id, predecessor.id), or(eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.nativeIssueId, issueId),
        ...["issueId", "taskId", "taskKey"].flatMap(key => aliases.flatMap(alias => [
          sql`${heartbeatRuns.contextSnapshot}->>${key} = ${alias}`, sql`${agentWakeupRequests.payload}->>${key} = ${alias}`,
        ]))),
      or(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        // A later cancelled queue row may represent a rejected duplicate only
        // if it has no evidence of any retained execution.
        and(gte(heartbeatRuns.createdAt, predecessor.createdAt),
          not(and(eq(heartbeatRuns.status, "cancelled"), noRetainedExecutionPredicate())!))),
    )).limit(1);
  if (competing || await getExecutionBlocker(tx, source.companyId, issueId)) return null;
  const [interaction] = await tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, source.companyId), eq(issueThreadInteractions.issueId, issueId),
    eq(issueThreadInteractions.status, "pending"), activeIssueInteractionCondition())).limit(1);
  if (interaction) return null;
  const [approval] = await tx.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, issueApprovals.companyId)))
    .where(and(eq(issueApprovals.companyId, source.companyId), eq(issueApprovals.issueId, issueId),
      inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  if (approval) return null;

  // A historical source may lack the first-claim fence. Its system wait
  // receipt and absence of provider execution records must agree instead.
  const [activity] = await tx.select({ found: sql<boolean>`
    exists (select 1 from ${heartbeatRunEvents} where ${and(eq(heartbeatRunEvents.companyId, source.companyId),
      eq(heartbeatRunEvents.runId, source.id), executionStartedEventPredicate())})
    or exists (select 1 from ${toolInvocations} where ${and(eq(toolInvocations.companyId, source.companyId), eq(toolInvocations.runId, source.id))})
    or exists (select 1 from ${environmentLeases} where ${and(eq(environmentLeases.companyId, source.companyId), eq(environmentLeases.heartbeatRunId, source.id))})
    or exists (select 1 from ${nativeRunFinalizations} where ${and(eq(nativeRunFinalizations.companyId, source.companyId), eq(nativeRunFinalizations.runId, source.id))})
  ` }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, source.id), eq(heartbeatRuns.companyId, source.companyId)));
  if (activity?.found !== false) return null;

  let environmentId: string | undefined;
  if (agent.runtimeConfig.harnessPool) {
    if (agent.adapterConfig.homeMode === "preconfigured" ||
        !(await instanceSettingsService(tx).getExperimentalReadOnly()).enableNativeRunner) return null;
    try {
      environmentId = await harnessPoolEnvironmentScope(tx, agent, issue, source);
    } catch (error) {
      if (error instanceof HttpError) return null;
      throw error;
    }
    if (pin.selection.runnerScope && pin.selection.runnerScope.environmentId !== environmentId) return null;
  }
  const transitioned = await aiConnectionRouterService(tx).transitionQuotaPin({
    companyId: source.companyId, poolId, agentId: source.agentId, taskKey: issueId,
    expectedSelection: pin.selection, userId, adapterType: agent.adapterType,
    attemptedMemberIds: [pin.member.id], requireSourceQuotaCooldown: true, environmentId,
    sourceAdapterConfig: { ...parseObject(agent.adapterConfig), ...parseObject(parseObject(issue.assigneeAdapterOverrides).adapterConfig) },
  });
  if (transitioned.kind === "cooldown") return { retryAt: transitioned.retryAt };
  return transitioned.kind === "selected" ? {
    selection: transitioned.selection, sourceRunId: source.id, predecessorRunId: predecessor.id,
  } : null;
}

/** Let ordinary task preparation rebuild the bounded handoff from issue
 * history and the saved workspace. No old provider transcript or session ID
 * is copied across accounts. */
export function applyHistoricalQuotaHandoff(context: Record<string, unknown>, handoff: HistoricalQuotaHandoff) {
  context.aiRouterSelection = handoff.selection;
  context.previousRunId = handoff.predecessorRunId;
  context.forceFreshSession = true;
  context.aiPoolPreDispatchHandoff = { sourceRunId: handoff.sourceRunId, predecessorRunId: handoff.predecessorRunId };
  delete context.aiConnection;
  delete context.executionContinuation;
  delete context.paperclipContinuationSummary;
  delete context.paperclipSessionHandoffMarkdown;
  delete context.paperclipPreviousSessionId;
  delete context.paperclipSessionRotationReason;
  delete context.resumeSessionDisplayId;
  delete context.resumeSessionParams;
  delete context.aiPoolFailover;
  delete context.poolWaitScope;
  delete context.harnessPoolSelection;
}

/** Reconsider a stored wait before the queue claims it or an operator
 * advances it. Persist the selection, session reset and deadline together. */
export async function reselectHistoricalQuotaWaitSuccessor(db: Db, candidate: Run, userId: string | null, now = new Date()) {
  const { companyId, agentId, issueId, retryOfRunId } = candidate;
  if (!issueId || !retryOfRunId || candidate.scheduledRetryReason !== AI_CONNECTION_POOL_WAIT_RETRY_REASON ||
      !["queued", "scheduled_retry"].includes(candidate.status) || !userId) return null;
  return db.transaction(async tx => {
    const [issue] = await tx.select({ id: issues.id, executionRunId: issues.executionRunId,
      assigneeAgentId: issues.assigneeAgentId }).from(issues).where(and(eq(issues.companyId, companyId),
      eq(issues.id, issueId))).for("update");
    if (issue?.executionRunId !== candidate.id || issue.assigneeAgentId !== agentId) return null;
    const runScope = and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.scopeKind, "issue"));
    const [source] = await tx.select().from(heartbeatRuns).where(and(runScope, eq(heartbeatRuns.id, retryOfRunId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(runScope, eq(heartbeatRuns.id, candidate.id))).for("update");
    if (!source || !isPoolPreDispatchCancellation(source) || !run || run.retryOfRunId !== source.id || run.scheduledRetryReason !== AI_CONNECTION_POOL_WAIT_RETRY_REASON ||
        !["queued", "scheduled_retry"].includes(run.status) || run.responsibleUserId !== userId ||
        run.startedAt || run.finishedAt || run.runtimeModeResolvedAt || run.executionStage || run.controllerBootId ||
        run.controllerLeaseExpiresAt || run.executionControlDeadlineAt || run.processPid || run.processGroupId ||
        run.processStartedAt || run.runnerInstanceId || run.nativeSessionId || run.nativeIssueId || run.sessionIdAfter ||
        Object.keys(parseObject(run.runnerProfileJson)).length || hasStopRequest(run) ||
        (run.sessionIdBefore && source.sessionIdBefore && run.sessionIdBefore !== source.sessionIdBefore) ||
        run.contextSnapshot?.retryOfRunId !== source.id || run.contextSnapshot.issueId !== issueId ||
        run.contextSnapshot.explicitUserContinuation != null) return null;
    const [wake] = run.wakeupRequestId ? await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.runId, run.id))).for("update") : [];
    if (!wake || wake.source !== "automation" || wake.requestedByActorType !== "system" || wake.status !== "queued" ||
        wake.payload?.issueId !== issueId || wake.payload.retryOfRunId !== source.id ||
        wake.payload.retryReason !== AI_CONNECTION_POOL_WAIT_RETRY_REASON || hasStopRequest(source)) return null;
    const context = parseObject(run.contextSnapshot);
    const recorded = parseObject(context.aiPoolPreDispatchHandoff);
    if (recorded.sourceRunId === source.id && typeof recorded.predecessorRunId === "string" &&
        context.previousRunId === recorded.predecessorRunId && context.forceFreshSession === true && !run.sessionIdBefore) {
      return context;
    }
    const handoff = await switchHistoricalQuotaPin(tx as unknown as Db, { source, issueId, executionRunId: run.id, userId });
    if (!handoff || !("selection" in handoff)) return null;
    context.scheduledRetryAt = now.toISOString();
    applyHistoricalQuotaHandoff(context, handoff);
    await tx.update(heartbeatRuns).set({ contextSnapshot: context, sessionIdBefore: null,
      scheduledRetryAt: now, updatedAt: now }).where(and(runScope, eq(heartbeatRuns.id, run.id)));
    await tx.update(agentWakeupRequests).set({ payload: { ...wake.payload, scheduledRetryAt: now.toISOString() },
      updatedAt: now }).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, wake.id)));
    if (run.status === "scheduled_retry") await notifyScheduledRetryDispatch(tx, { companyId, runId: run.id });
    return context;
  });
}

/** Serialize user Stop with a not-yet-started pool retry. */
export function isLegacyQuotaPrestartStopCandidate(run: typeof heartbeatRuns.$inferSelect): boolean {
  if (isPoolPreDispatchCancellation(run) || (run.runtimeMode !== "native" && poolFailureKind(run))) return true;
  const fence = run.runnerProfileJson?.[KEY] as Record<string, unknown> | undefined;
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  return run.status === "cancelled" && run.errorCode === "ai_connection_pool_exhausted" && Boolean(run.issueId) &&
    fence?.schema === "paperclip.legacy-quota-prestart.v1" && fence.state === "preparing" && fence.runId === run.id &&
    fence.companyId === run.companyId && fence.agentId === run.agentId && recovery?.kind === "ai_connection_wait" && recovery.providerWorkStarted === false;
}

export async function fenceLegacyQuotaPrestartStop(db: Db, input: { companyId: string; runId: string; issueId: string | null; requestId?: string; userId?: string | null }) {
  const requestId = cancellationRequestId(input.requestId);
  const userId = input.userId ?? null;
  return db.transaction(async tx => {
    if (input.issueId) await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const issueScope = input.issueId ? eq(heartbeatRuns.issueId, input.issueId) : isNull(heartbeatRuns.issueId);
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId), issueScope)).for("update");
    if (!run || !isLegacyQuotaPrestartStopCandidate(run)) return null;
    const previous = run.resultJson?.legacyQuotaStopRequested as Record<string, unknown> | undefined;
    const attempts = previous && Array.isArray(previous.attempts) ? previous.attempts as Array<Record<string, unknown>>
      : previous ? [{ requestId: previous.requestId, userId: previous.userId, requestedAt: previous.requestedAt }] : [];
    const knownAttempt = attempts.some(attempt => attempt.requestId === (requestId ?? null) && attempt.userId === userId);
    if (requestId && attempts.some(attempt => attempt.requestId === requestId && attempt.userId !== userId))
      throw conflict("Cancellation request belongs to another actor or conflicts with an earlier Stop");
    if (previous && !knownAttempt && previous.acknowledgedAt != null)
      throw conflict("Cancellation request belongs to another actor or conflicts with an earlier Stop");
    const [successor] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.retryOfRunId, run.id), eq(heartbeatRuns.agentId, run.agentId), issueScope)).limit(1);
    const now = new Date().toISOString();
    const nextAttempts = knownAttempt ? attempts : [...attempts, { requestId: requestId ?? null, userId, requestedAt: now }];
    const stop = previous ? { ...previous, attempts: nextAttempts, ...(!successor ? { acknowledgedAt: previous.acknowledgedAt ?? now } : {}) }
      : { requestedAt: now, requestId: requestId ?? null, userId, attempts: nextAttempts, ...(successor ? {} : { acknowledgedAt: now }) };
    await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, legacyQuotaStopRequested: stop }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
    if (successor) return { kind: "successor" as const, run: successor };
    return { kind: "fenced" as const };
  });
}

export async function acknowledgeLegacyQuotaPrestartStop(db: Db, input: { companyId: string; runId: string; requestId?: string; userId?: string | null }) {
  const requestId = cancellationRequestId(input.requestId), userId = input.userId ?? null;
  await db.transaction(async tx => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    const stop = run?.resultJson?.legacyQuotaStopRequested as Record<string, unknown> | undefined;
    const attempts = stop && Array.isArray(stop.attempts) ? stop.attempts as Array<Record<string, unknown>>
      : stop ? [{ requestId: stop.requestId, userId: stop.userId }] : [];
    if (!run || !stop || !attempts.some(attempt => attempt.requestId === (requestId ?? null) && attempt.userId === userId))
      throw conflict("Cancellation request changed before acknowledgement");
    await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, legacyQuotaStopRequested: { ...stop, acknowledgedAt: new Date().toISOString() } }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
  });
}
