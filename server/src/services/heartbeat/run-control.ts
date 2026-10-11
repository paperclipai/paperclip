import { isHeartbeatRunTerminalStatus } from "./run-lifecycle.js";
import { DEFERRED_WAKE_CONTEXT_KEY } from "./queue.js";
import { CANCELLABLE_HEARTBEAT_RUN_STATUSES } from "./recovery.js";
import {
  type WakeupOptions,
} from "./run-preparation.js";
import { preserveWorkspaceRestoreRecoveryMetadataSql } from "../legacy-workspace-restore-recovery.js";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import {
  nativeRetryCancellationCommitCondition,
  claimCancellationRequest,
} from "../native-runtime/native-cancellation-request.js";
import {
  canContinueCancelledRun,
  readRunCancellation,
  requestedRunCancellation,
} from "../run-cancellation.js";
import { settleSlackConversation } from "../slack-conversation-lifecycle.js";
import { readQueuedInteractionResponse } from "../queued-interaction-response.js";
import {
  isAcknowledgedNativeStop,
  acknowledgedNativeStopExecutionHasStopped,
} from "../acknowledged-native-stop.js";
import { completeTerminatedRemoteNativeSessionCleanup } from "../../vendor/paperclip-runner/index.js";
import {
  hasRemoteTerminationReceipt,
  remoteExecutionHasStopped,
  stoppedRemoteCleanupScopes,
} from "../remote-execution-termination.js";
import {
  admitExplicitNativeContinuation,
  undeliveredLegacyUserCommentIds,
} from "../explicit-native-continuation.js";
import { isPausedComputerAdmissionRetryBeforeProvider, isCancelledNativeStartup, isComputerAdmissionWaitBeforeProvider, hasSettledComputerAdmissionPreparation } from "../cancelled-native-startup.js";
import {
  executionBlockerPredicate,
  getExecutionBlocker,
} from "../execution-blocker.js";
import {
  CONVERSATION_CONTINUATION_POLICY,
  runUsedConversationAdapter,
  hasConversationContinuationPolicy,
} from "../conversation-continuation.js";
import {
  adapterExecutionControls,
  captureAdapterStopOwnership,
  waitForAdapterStop,
} from "../adapter-execution-control.js";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  type EnvironmentLeaseStatus,
} from "@paperclipai/shared";
import {
  agentWakeupRequests,
  companies,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  conflict,
  HttpError,
  notFound,
} from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import {
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInWakePayload,
  withQueuedCommentIdsInRunContext,
} from "../issue-queued-comment-queue.js";
import {
  cancelNativeSession,
  closeWarmNativeSessionsForRun,
} from "../native-runtime/index.js";
import { runningProcesses } from "../../adapters/index.js";
import { parseObject } from "../../adapters/utils.js";
import { isNativeRunnerOwnershipHeld } from "../native-runtime/native-runner-ownership.js";
import {
  withCurrentBudgetEnforcement,
  type BudgetEnforcementScope,
} from "../budgets.js";
import { terminateLocalService } from "../local-service-supervisor.js";
import { deriveCommentId } from "../../modules/run-dispatch/index.js";
import { WakeQueueApplicationError } from "../../modules/wake-queue/index.js";
import { isUuidLike } from "@paperclipai/shared";
import {
  type ProviderResourceDisposition,
} from "../environment-runtime.js";

import type { createHeartbeatRunState } from "./run-state.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import type { createHeartbeatRetries, HeartbeatRetryDependencies } from "./retries.js";
import type { createHeartbeatQueue } from "./queue.js";
import type { createHeartbeatRecovery } from "./recovery.js";
import type { createWakeQueue, PostCommitEffect as WakeQueuePostCommitEffect } from "../../modules/wake-queue/index.js";
import type { environmentRunOrchestrator } from "../environment-run-orchestrator.js";

type ProcessRunCancellationSettlement = {
  settled: Promise<void>;
  failed: boolean;
  error?: unknown;
};

/** Cancellation shares executor ownership and delegates lifecycle and admission effects. */
export interface HeartbeatRunControlDependencies extends Pick<ReturnType<typeof createHeartbeatRunState>,
  "getRun" | "getAgent">,
  Pick<ReturnType<typeof createHeartbeatLifecycle>,
    "mergeRunStopMetadataForAgent" | "setRunStatusFromLive" | "setRunStatus" | "setWakeupStatus" | "appendRunEvent">,
  Pick<HeartbeatRetryDependencies, "finalizeAgentStatus"> {
  options: {
    closeWarmNativeSessionsForRun?: (input: {
      runId: string;
      reason: string;
    }) => Promise<{ closed: number; busy: number; failed: number }>;
  };
  envOrchestrator: Pick<ReturnType<typeof environmentRunOrchestrator>, "releaseForRun">;
  enqueueWakeup: ReturnType<typeof createHeartbeatQueue>["enqueueWakeup"];
  startNextQueuedRunForAgent: ReturnType<typeof createHeartbeatQueue>["startNextQueuedRunForAgent"];
  sweepPendingCleanupLeases: ReturnType<typeof createHeartbeatRecovery>["sweepPendingCleanupLeases"];
  timerClaimWasFirstHeartbeat: ReturnType<typeof createHeartbeatRetries>["timerClaimWasFirstHeartbeat"];
  wakeQueue: Pick<ReturnType<typeof createWakeQueue>, "releaseIssueExecution">;
  applyWakeQueuePostCommitEffects: (effects: WakeQueuePostCommitEffect[]) => Promise<void>;
  getSchedulingSuppression: () => Promise<{ suppressed: boolean }>;
  // Scheduler and route service instances must retain the same in-process barriers.
  activeRunExecutions: Set<string>;
  processRunCancellationSettlements: Map<string, ProcessRunCancellationSettlement>;
  failedProcessRunCancellations: Map<string, ProcessRunCancellationSettlement>;
}

export function leaseReleaseStatusForRunStatus(
  status: string | null | undefined,
): Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> {
  if (status === "cancelled") return "expired";
  return status === "failed" || status === "timed_out" ? "failed" : "released";
}

export function providerResourceDispositionForTerminalRun(
  desired: ProviderResourceDisposition | undefined,
  status: string | null | undefined,
): ProviderResourceDisposition | undefined {
  if (desired !== "keep_running") return desired;
  return status === "succeeded" ? desired : "stop_and_retain";
}

export async function terminateHeartbeatRunProcess(input: {
  pid: number | null | undefined;
  processGroupId: number | null | undefined;
  graceMs?: number;
  signal?: NodeJS.Signals;
}) {
  const pid = input.pid ?? null;
  const processGroupId = input.processGroupId ?? null;
  if (typeof pid !== "number" && typeof processGroupId !== "number") return;

  await terminateLocalService(
    {
      pid:
        typeof pid === "number" && Number.isInteger(pid) && pid > 0
          ? pid
          : (processGroupId ?? 0),
      processGroupId:
        typeof processGroupId === "number" &&
        Number.isInteger(processGroupId) &&
        processGroupId > 0
          ? processGroupId
          : null,
    },
    { forceAfterMs: input.graceMs, signal: input.signal },
  );
}

export async function cancelHeartbeatNativeRun(input: {
  db: Db;
  runId: string;
  reason: string;
  runtimeMode: string | null;
  cancellationRequestId?: string;
  cancel?: (
    runId: string,
    reason: string,
    options: { db: Db; scope: "run"; cancellationRequestId?: string },
  ) => Promise<{ decision: unknown | null; auditId: string | null }>;
}) {
  if (input.runtimeMode !== "native") {
    return { decision: null, auditId: null };
  }
  const cancellation = input.cancel
    ? await input.cancel(input.runId, input.reason, {
        db: input.db,
        scope: "run",
        ...(input.cancellationRequestId ? { cancellationRequestId: input.cancellationRequestId } : {}),
      })
    : await cancelNativeSession(input.runId, input.reason, {
        db: input.db,
        scope: "run",
        ...(input.cancellationRequestId ? { cancellationRequestId: input.cancellationRequestId } : {}),
      });
  if (!cancellation.decision || !cancellation.auditId) {
    throw new Error("native_cancellation_outcome_not_audited");
  }
  return cancellation;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export type CancelRunOptions = {
    budgetEnforcement?: BudgetEnforcementScope;
    /** Optional board request identity, atomically reserved for native Stop. */
    cancellationRequestId?: string;
    cancellationRequestedByUserId?: string | null;
    errorCode?: string;
    resultJson?: Record<string, unknown>;
    eventMessage?: string;
    eventPayload?: Record<string, unknown>;
    /** Per-call graceful process shutdown window, bounded to a safe range. */
    terminationGraceMs?: number;
    /** Caller is immediately scheduling an explicit successor path. */
    suppressImmediateRecovery?: boolean;
  };

/** Run control binds cancellation, resource release, and saved-input resumption. */
export function createHeartbeatRunControl(db: Db, dependencies: HeartbeatRunControlDependencies) {
  const {
    getRun,
    options,
    envOrchestrator,
    activeRunExecutions,
    enqueueWakeup,
    getAgent,
    sweepPendingCleanupLeases,
    getSchedulingSuppression,
    wakeQueue,
    applyWakeQueuePostCommitEffects,
    processRunCancellationSettlements,
    mergeRunStopMetadataForAgent,
    setRunStatusFromLive,
    failedProcessRunCancellations,
    setWakeupStatus,
    appendRunEvent,
    finalizeAgentStatus,
    timerClaimWasFirstHeartbeat,
    startNextQueuedRunForAgent,
    setRunStatus,
  } = dependencies;

  async function releaseEnvironmentLeasesForRun(input: {
    runId: string;
    companyId: string;
    agentId: string;
    status: string | null | undefined;
    failureReason?: string | null;
    providerResourceDisposition?: ProviderResourceDisposition;
    nativeLifecycleTelemetry?: {
      provider: string;
      harness: string;
      lifecycleMode: "per_turn" | "warm";
      sandboxResource: "keep_running" | "stop_and_reuse" | "destroy_after_turn";
    };
  }) {
    const leaseOwnerRun = await getRun(input.runId);
    if (leaseOwnerRun && isNativeRunnerOwnershipHeld(leaseOwnerRun)) return;
    // Recovery can finish workspace copy-back outside the executor's finally.
    // Successful copy-back does not earn warm retention for a failed turn.
    const status = leaseOwnerRun?.status ?? input.status;
    const providerResourceDisposition = providerResourceDispositionForTerminalRun(
      input.providerResourceDisposition,
      status,
    );
    if (providerResourceDisposition === "destroy") {
      const closeResult = await (
        options.closeWarmNativeSessionsForRun ??
        closeWarmNativeSessionsForRun
      )({
        runId: input.runId,
        reason: "terminal heartbeat run destroyed its environment lease",
      }).catch((err) => {
        logger.warn(
          { err, runId: input.runId },
          "failed to close warm native sessions before environment lease destruction",
        );
        return { closed: 0, busy: 0, failed: 1 };
      });
      // A failed remote checkpoint cannot veto destruction of the isolated
      // sandbox after the run stopped. Provider destruction supplies the exit
      // proof; it does not turn the interrupted checkpoint into a success.
      const remoteLeases = closeResult.failed > 0 && leaseOwnerRun &&
          ["cancelled", "failed", "timed_out", "interrupted"].includes(leaseOwnerRun.status)
        ? await db.select({ provider: environmentLeases.provider }).from(environmentLeases).where(and(
            eq(environmentLeases.companyId, input.companyId),
            eq(environmentLeases.heartbeatRunId, input.runId),
          ))
        : [];
      const canDestroyRemote = remoteLeases.length > 0 &&
        remoteLeases.every(lease => lease.provider && lease.provider !== "local");
      if (closeResult.busy > 0 || (closeResult.failed > 0 && !canDestroyRemote)) {
        logger.warn(
          { runId: input.runId, warmNativeSessions: closeResult },
          "deferred environment lease destruction until warm native sessions close",
        );
        return;
      }
    }
    const releaseResult = await envOrchestrator
      .releaseForRun({
        heartbeatRunId: input.runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: leaseReleaseStatusForRunStatus(status),
        failureReason: input.failureReason ?? undefined,
        providerResourceDisposition,
        nativeLifecycleTelemetry: input.nativeLifecycleTelemetry,
      })
      .catch((err) => {
        logger.warn(
          { err, runId: input.runId },
          "failed to release environment leases for heartbeat run",
        );
        return null;
      });
    for (const releaseError of releaseResult?.errors ?? []) {
      logger.warn(
        {
          err: releaseError.error,
          leaseId: releaseError.leaseId,
          runId: input.runId,
        },
        "failed to release environment lease for heartbeat run",
      );
    }
    await acknowledgeRemoteStop(input.runId, input.companyId);
  }

  async function acknowledgeRemoteStop(runId: string, companyId: string) {
    // The provider receipt arrives after adapter settlement. A remote ACP child
    // has no host PID, so only this target-aware boundary can acknowledge Stop.
    const stopped = await getRun(runId);
    if (stopped?.runtimeMode === "native") {
      const scopes = await stoppedRemoteCleanupScopes(db, companyId, runId);
      for (const remoteCleanupScope of scopes ?? []) {
        completeTerminatedRemoteNativeSessionCleanup({ companyId, runId, remoteCleanupScope });
      }
    }
    if (stopped?.runtimeMode === "legacy" && stopped.status === "cancelled" &&
        parseObject(stopped.resultJson?.executionCancellation).state === "requested" &&
        await runUsedConversationAdapter(db, stopped) &&
        await remoteExecutionHasStopped(db, companyId, runId)) {
      await db.update(heartbeatRuns).set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
          executionCancellation: { ...parseObject(stopped.resultJson?.executionCancellation),
            state: "acknowledged", acknowledgedAt: new Date().toISOString(),
            proof: "provider_termination_receipt" },
          conversationContinuation: CONVERSATION_CONTINUATION_POLICY,
                 })}::jsonb`,
        updatedAt: new Date(),
      }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "cancelled")));
    }
  }

  async function resumeRemoteStopComments(run: typeof heartbeatRuns.$inferSelect, requestId?: string) {
    if (!isHeartbeatRunTerminalStatus(run.status) || adapterExecutionControls.has(run.id)) return;
    const [preparationCoordinator] = run.runtimeMode === "legacy" && run.status === "cancelled" && !run.runtimeModeResolvedAt
      ? await db.select().from(nativeRunFinalizations).where(and(
          eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
        )) : [];
    const pausedComputerRetry = await isPausedComputerAdmissionRetryBeforeProvider(db, run);
    const cancelledPreparation = pausedComputerRetry || run.runtimeMode === "legacy" &&
      await isCancelledNativeStartup(db, run, preparationCoordinator);
    if (run.runtimeMode !== "native" && !cancelledPreparation &&
        parseObject(run.resultJson?.startupCancellation).beforeNativeSelection !== true &&
        !(await remoteExecutionHasStopped(db, run.companyId, run.id))) return;
    const issueId = run.nativeIssueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
    if (!issueId) return;
    const currentRun = run.runtimeMode === "native" ? await getRun(run.id, { includeExecutionEvidence: true }) : null;
    const [coordinator] = currentRun ? await db.select({ phase: nativeRunFinalizations.phase,
      leaseOwner: nativeRunFinalizations.leaseOwner }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
    )) : [];
    // Stop ends one response. Saved user input can enter ordinary admission
    // once its executor settles; it does not need a manufactured crash incident.
    // The ordinary path still enforces task holds, ownership, and native session
    // cleanup before starting a provider.
    const stoppedNativeContinuation = currentRun && isAcknowledgedNativeStop(currentRun) &&
      !activeRunExecutions.has(run.id) && !coordinator?.leaseOwner &&
      ["terminal_failure", "applied"].includes(coordinator?.phase ?? "") &&
      await acknowledgedNativeStopExecutionHasStopped(db, currentRun) &&
      !(await getExecutionBlocker(db, run.companyId, issueId));
    const legacyContinuation = run.runtimeMode === "legacy" &&
      hasConversationContinuationPolicy((await getRun(run.id, { includeExecutionEvidence: true }))?.resultJson) &&
      !(await getExecutionBlocker(db, run.companyId, issueId));
    if (run.runtimeMode !== "native" && run.runtimeMode !== "legacy") return;
    const pending = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      eq(agentWakeupRequests.requestedByActorType, "user"),
      requestId ? eq(agentWakeupRequests.id, requestId) : undefined,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )).orderBy(asc(agentWakeupRequests.requestedAt)).limit(50);
    for (const wake of pending) {
      if (wake.idempotencyKey?.startsWith("chat-inbound:")) continue;
      let payload = parseObject(wake.payload);
      if (payload.queuedCommentInterrupt) {
        if (pausedComputerRetry) continue;
        await resumeQueuedCommentInterrupt(wake.companyId, wake.id);
        continue;
      }
      let context = parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]);
      let commentId = deriveCommentId(context, payload);
      let requestedByActorId = wake.requestedByActorId;
      const reason = readNonEmptyString(context.wakeReason) ?? wake.reason;
      if (run.runtimeMode === "native" || cancelledPreparation) {
        const ids = await undeliveredLegacyUserCommentIds(db, run.companyId, issueId, run.agentId,
          queuedCommentIdsFromWakePayload(payload));
        if (!ids.length) continue;
        payload = withQueuedCommentIdsInWakePayload(payload, ids);
        context = withQueuedCommentIdsInRunContext(context, ids);
        commentId = ids.at(-1)!;
        // A coalesced queue can contain several authors. Its saved comments,
        // not the outer wake's first author, authorize the remaining input.
        const [author] = await db.select({ id: issueComments.authorUserId }).from(issueComments).where(and(
          eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId), eq(issueComments.id, commentId),
        ));
        requestedByActorId = author?.id ?? null;
      }
      if (legacyContinuation || stoppedNativeContinuation) {
        if (!commentId || !run.finishedAt || !requestedByActorId ||
            !["issue_commented", "issue_reopened_via_comment"].includes(reason ?? "")) continue;
        const [comment] = await db.select().from(issueComments).where(and(
          eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
          sql`${issueComments.id}::text = ${commentId}`, eq(issueComments.authorType, "user"),
          eq(issueComments.authorUserId, requestedByActorId), isNull(issueComments.deletedAt),
          isNull(issueComments.createdByRunId),
          stoppedNativeContinuation ? undefined : gt(issueComments.createdAt, run.finishedAt),
        ));
        if (!comment?.body.trim()) continue;
      } else {
        let wait = { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." };
        const admitted = await admitExplicitNativeContinuation({ db, companyId: run.companyId, issueId,
          agentId: run.agentId, actorType: wake.requestedByActorType, actorId: requestedByActorId,
          reason, commentId, successorRunId: randomUUID(), dryRun: true,
          ...((run.runtimeMode === "native" || cancelledPreparation) ? { queuedCommentRequestId: wake.id } : {}),
          onBlocked: (reason, message) => { wait = { reason, message }; },
        });
        if (!admitted) {
          await db.update(agentWakeupRequests).set({
            payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}',
              coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) || ${JSON.stringify(wait)}::jsonb)`,
            updatedAt: new Date(),
          }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, run.companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution")));
          continue;
        }
      }
      // Re-enter ordinary admission with the original user's authority. It
      // atomically adopts the deferred comments and still applies every gate.
      await enqueueWakeup(run.agentId, { source: wake.source as WakeupOptions["source"], triggerDetail: (wake.triggerDetail ?? undefined) as WakeupOptions["triggerDetail"],
        reason, payload, contextSnapshot: context,
        requestedByActorType: "user", requestedByActorId,
        ...((run.runtimeMode === "native" || cancelledPreparation) ? { queuedCommentRequestId: wake.id } : {}),
        idempotencyKey: `remote-stop-comment:${run.id}:${wake.id}` }, wake.id);
      break;
    }
  }

  async function resumeQueuedCommentInterrupt(companyId: string, queueId: string, opts?: { retryCleanup?: boolean }) {
    return resumeSavedLegacyComments(companyId, queueId, true, opts);
  }

  async function resumeSavedLegacyComments(companyId: string, queueId: string, interrupted = false, opts?: { retryCleanup?: boolean }) {
    const [wake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, queueId), eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    if (!wake) return;
    const payload = parseObject(wake.payload);
    let actorId = readNonEmptyString(parseObject(payload.queuedCommentInterrupt).actorId);
    let commentIds = queuedCommentIdsFromWakePayload(payload);
    const issueId = readNonEmptyString(payload.issueId);
    if (!issueId || wake.idempotencyKey?.startsWith("chat-inbound:")) return;
    const response = await readQueuedInteractionResponse(db, companyId, issueId, payload);
    if (!commentIds.length && !response) return;
    // Resolved cards are immutable input. Only an explicit Interrupt click can
    // authorize continuation across a stopped execution; ordinary completion
    // uses normal deferred-wake promotion.
    if (response && !interrupted) return;
    if (!interrupted) {
      commentIds = await undeliveredLegacyUserCommentIds(db, companyId, issueId, wake.agentId, commentIds);
      if (!commentIds.length) return;
      // The queue itself may have begun as a system wake. The saved human
      // comment, not that wake's origin or mutable caller payload, is authority.
      const [comment] = await db.select().from(issueComments).where(and(
        eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
        eq(issueComments.id, commentIds[commentIds.length - 1]!), eq(issueComments.authorType, "user"),
        isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
      )).orderBy(desc(issueComments.createdAt)).limit(1);
      if (!comment?.body.trim() || !comment.authorUserId) return;
      actorId = comment.authorUserId;
    }
    if (!actorId) return;
    const agent = await getAgent(wake.agentId);
    if (!agent || agent.companyId !== companyId || (agent.adapterType === "paperclip_runner" && !response?.source.requiresFreshSession)) return;
    const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, wake.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
    )).limit(1);
    if (active) return;
    if (interrupted && opts?.retryCleanup) {
      // Only the HTTP click grants an extra cleanup attempt. Periodic retries
      // reuse the intent to deliver, never a fresh provider teardown budget.
      const sourceRun = await db.transaction(async tx => {
        const [task] = await tx.select().from(issues).where(and(
          eq(issues.companyId, companyId), eq(issues.id, issueId),
        )).for("update");
        const [current] = await tx.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.id, queueId), eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, wake.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
          sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${actorId}`,
        ));
        if (!task || task.assigneeAgentId !== wake.agentId || ["done", "cancelled"].includes(task.status) ||
            !current || (!queuedCommentIdsFromWakePayload(current.payload).length &&
              !await readQueuedInteractionResponse(tx as unknown as Db, companyId, issueId, current.payload))) return null;
        const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, wake.agentId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
          inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
        )).limit(1);
        if (successor) return null;
        const blocker = await getExecutionBlocker(tx as unknown as Db, companyId, issueId);
        const run = blocker?.runId ? await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, blocker.runId),
          eq(heartbeatRuns.agentId, wake.agentId), eq(heartbeatRuns.runtimeMode, "legacy"),
          inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        )).then(rows => rows[0]) : null;
        if (!run || activeRunExecutions.has(run.id) || adapterExecutionControls.has(run.id)) return null;
        // Older ephemeral leases recorded successful cleanup without a provider
        // receipt. Re-verify them through the recorded teardown path; a timestamp
        // alone never certifies termination. Retained/reusable resources stay put.
        const historical = await tx.select().from(environmentLeases).where(and(
          eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
          eq(environmentLeases.leasePolicy, "ephemeral"), isNotNull(environmentLeases.releasedAt),
          inArray(environmentLeases.status, ["released", "expired", "failed"]),
        )).for("update");
        for (const lease of historical) {
          if (!lease.provider || lease.provider === "local" || !lease.providerLeaseId || hasRemoteTerminationReceipt(lease)) continue;
          // Provider resource IDs identify physical sandboxes. A lease in any
          // company can still own this resource; never destroy it on behalf of
          // this company. This existence-only guard exposes no foreign data.
          const [otherOwner] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
            ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider),
            eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
            or(isNull(environmentLeases.releasedAt), inArray(environmentLeases.status, ["active", "retained", "pending_cleanup"])),
          )).limit(1);
          if (otherOwner) continue;
          await tx.update(environmentLeases).set({ status: "pending_cleanup", updatedAt: new Date() })
            .where(eq(environmentLeases.id, lease.id));
        }
        return run;
      });
      if (sourceRun) await sweepPendingCleanupLeases({ explicitRetry: {
        companyId, runId: sourceRun.id, actorId, reason: "queued_comment_interrupt",
      } });
    }
    const deliveryPayload = response ? { ...payload } : withQueuedCommentIdsInWakePayload(payload, commentIds);
    delete deliveryPayload.queuedCommentInterrupt;
    await enqueueWakeup(wake.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: deliveryPayload, contextSnapshot: response
        ? { ...parseObject(payload._paperclipWakeContext), issueId, triggeredBy: "board", actorId,
            responsibleUserId: actorId }
        : withQueuedCommentIdsInRunContext({
            issueId, triggeredBy: "board", actorId, responsibleUserId: actorId,
          }, commentIds),
      requestedByActorType: "user", requestedByActorId: actorId,
      ...(interrupted ? { queuedCommentInterruptId: queueId } : { queuedCommentRequestId: queueId }),
      issueStateGuard: { assigneeAgentId: wake.agentId, statuses: ["todo", "in_progress", "in_review", "blocked"] },
      idempotencyKey: `queued-comment-${interrupted ? "interrupt" : "delivery"}:${queueId}`,
    }, queueId);
  }

  async function resumeExecutionWaitComments() {
    if ((await getSchedulingSuppression()).suppressed) return;
    const waits = await db.select({ wake: agentWakeupRequests })
      .from(agentWakeupRequests)
      .innerJoin(issues, and(eq(issues.companyId, agentWakeupRequests.companyId),
        sql`${issues.id}::text = ${agentWakeupRequests.payload}->>'issueId'`,
        eq(issues.assigneeAgentId, agentWakeupRequests.agentId)))
      .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
      .where(and(exists(db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, issues.companyId), eq(issueRecoveryActions.sourceIssueId, issues.id),
        executionBlockerPredicate(),
      ))), eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(agentWakeupRequests.requestedByActorType, "user"),
        sql`${agentWakeupRequests.payload}->'executionWait' is not null`,
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
        lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 30_000)),
        notInArray(issues.status, ["done", "cancelled"])))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    const seen = new Set<string>();
    for (const { wake } of waits) {
      const issueId = String(wake.payload?.issueId);
      if (seen.has(issueId)) continue;
      seen.add(issueId);
      // Advance the cursor even for invalid evidence so one damaged task cannot
      // starve later requests in this bounded scan. Preserve concurrent edits.
      const [claimed] = await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, wake.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 30_000)),
      )).returning({ id: agentWakeupRequests.id });
      if (!claimed) continue;
      // Match normal admission's deterministic current blocker selection. An
      // arbitrary historical action must not choose the retry's source run.
      const blocker = await getExecutionBlocker(db, wake.companyId, issueId);
      const sourceId = blocker?.runId;
      if (!sourceId || !isUuidLike(sourceId)) continue;
      const run = await getRun(sourceId, { includeExecutionEvidence: true });
      if (!run || run.companyId !== wake.companyId || run.agentId !== wake.agentId) continue;
      if (canContinueCancelledRun(run)) {
        await resumeSavedLegacyComments(wake.companyId, wake.id).catch(err => {
          logger.warn({ err, runId: run.id }, "failed to resume saved input after provider cancellation");
        });
        continue;
      }
      await resumeRemoteStopComments(run, wake.id).catch(err => {
        logger.warn({ err, runId: run.id }, "failed to resume saved execution-wait message");
      });
    }
  }

  async function releaseIssueExecutionAndPromote(
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">,
    options: { suppressImmediateRecovery?: boolean; deferredPostCommitEffects?: WakeQueuePostCommitEffect[] } = {},
  ) {
    try {
      const source = await getRun(run.id);
      const { postCommitEffects } = await wakeQueue.releaseIssueExecution({
        companyId: run.companyId,
        runId: run.id,
        now: new Date(),
        // A durable authentication card owns recovery. This covers the review path,
        // while continuation classification blocks periodic generic retries.
        suppressImmediateRecovery: options.suppressImmediateRecovery || isAiAuthenticationBlocked(source),
      });
      if (options.deferredPostCommitEffects) {
        options.deferredPostCommitEffects.push(...postCommitEffects);
      } else {
        await applyWakeQueuePostCommitEffects(postCommitEffects);
      }
      const completed = await getRun(run.id);
      const issueId = readNonEmptyString(completed?.contextSnapshot?.issueId)
        ?? readNonEmptyString(completed?.contextSnapshot?.taskId) ?? completed?.nativeIssueId;
      if (completed?.status === "succeeded" && issueId) {
        await settleSlackConversation(db, run.companyId, issueId).catch((err) => {
          logger.warn({ err, runId: run.id }, "Slack conversation settlement deferred to reconciliation");
        });
      }
    } catch (error) {
      if (
        error instanceof WakeQueueApplicationError &&
        error.code === "responsible_user_unresolved"
      ) {
        // Every other `responsible_user_unresolved` HttpError in this file
        // carries `code` inside its own `details`; match that shape here too.
        throw new HttpError(422, error.message, { code: error.code, ...error.details });
      }
      throw error;
    }
  }

  async function listProjectScopedRunIds(companyId: string, projectId: string, createdBefore?: Date) {
    const runIssueId = sql<
      string | null
    >`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const effectiveProjectId = sql<
      string | null
    >`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          createdBefore ? lt(heartbeatRuns.createdAt, createdBefore) : undefined,
          inArray(heartbeatRuns.status, [
            ...CANCELLABLE_HEARTBEAT_RUN_STATUSES,
          ]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(
    companyId: string,
    projectId: string,
    database: Db = db,
  ) {
    const wakeIssueId = sql<
      string | null
    >`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<
      string | null
    >`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await database
      .selectDistinctOn([agentWakeupRequests.id], {
        id: agentWakeupRequests.id,
      })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [
            "queued",
            "deferred_issue_execution",
          ]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(
    scope: BudgetEnforcementScope,
  ) {
    return withCurrentBudgetEnforcement(db, scope, async (tx) => {
      const now = new Date();
      let wakeupIds: string[] = [];

      if (scope.scopeType === "company") {
        wakeupIds = await tx
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, scope.companyId),
              inArray(agentWakeupRequests.status, [
                "queued",
                "deferred_issue_execution",
              ]),
              sql`${agentWakeupRequests.runId} is null`,
            ),
          )
          .then((rows) => rows.map((row) => row.id));
      } else if (scope.scopeType === "agent") {
        wakeupIds = await tx
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, scope.companyId),
              eq(agentWakeupRequests.agentId, scope.scopeId),
              inArray(agentWakeupRequests.status, [
                "queued",
                "deferred_issue_execution",
              ]),
              sql`${agentWakeupRequests.runId} is null`,
            ),
          )
          .then((rows) => rows.map((row) => row.id));
      } else {
        wakeupIds = await listProjectScopedWakeupIds(
          scope.companyId,
          scope.scopeId,
          tx,
        );
      }

      if (wakeupIds.length === 0) return 0;

      await tx
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled due to budget pause",
          updatedAt: now,
        })
        .where(and(
          inArray(agentWakeupRequests.id, wakeupIds),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          isNull(agentWakeupRequests.runId),
          scope.createdBefore ? lt(agentWakeupRequests.createdAt, scope.createdBefore) : undefined,
        ));

      return wakeupIds.length;
    });
  }

  function cancellationTerminationGraceMs(
    configuredGraceSec: number,
    requestedGraceMs: number | undefined,
  ) {
    const configuredGraceMs = Math.max(1, configuredGraceSec) * 1000;
    if (requestedGraceMs === undefined || !Number.isFinite(requestedGraceMs)) {
      return configuredGraceMs;
    }
    return Math.max(100, Math.min(30_000, Math.trunc(requestedGraceMs)));
  }

  async function cancelComputerAdmissionWait(
    run: typeof heartbeatRuns.$inferSelect, reason: string, options: CancelRunOptions,
  ) {
    const cancellation = requestedRunCancellation(options.resultJson ?? {}, reason);
    const stop = async (tx: Db) => {
      // Match retry scheduling's lock order, including a scheduler that already
      // transferred the task to this wait's exact successor.
      if (run.scopeKind === "issue" && run.issueId) await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.id, run.issueId))).for("update");
      const [current] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
      )).for("update");
      if (!current || current.status !== "cancelled" || current.errorCode !== "computer_admission_wait") return null;
      const alreadyStopped = current.resultJson?.computerAdmissionRetryOutcome === "aborted";
      // A scheduler may have suppressed its successor but not released the
      // task yet. Stop can still claim this exact verified pre-provider wait;
      // removing only that disposition for proof does not authorize a retry.
      const beforeSuppression = current.resultJson?.computerAdmissionRetryOutcome === "suppressed"
        ? { ...current, resultJson: { ...current.resultJson, computerAdmissionRetryOutcome: undefined } }
        : current;
      if (!alreadyStopped && !(await isComputerAdmissionWaitBeforeProvider(tx, beforeSuppression))) return null;
      const [stopped] = alreadyStopped ? [current] : await tx.update(heartbeatRuns).set({
        error: reason, updatedAt: new Date(),
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
          computerAdmissionRetryOutcome: "aborted", cancellation,
          // This Stop did not cancel provider work; preparation never admitted it.
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        })}::jsonb`,
      }).where(eq(heartbeatRuns.id, current.id)).returning();
      const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
        eq(heartbeatRuns.retryOfRunId, run.id), eq(heartbeatRuns.scheduledRetryReason, "computer_admission_wait"),
        eq(heartbeatRuns.scopeKind, current.scopeKind),
        current.issueId ? eq(heartbeatRuns.issueId, current.issueId) : isNull(heartbeatRuns.issueId),
      )).limit(1);
      return { stopped, successorId: successor?.id, updated: !alreadyStopped };
    };
    const outcome = await db.transaction(tx => options.budgetEnforcement
      ? withCurrentBudgetEnforcement(tx as unknown as Db, options.budgetEnforcement, stop)
      : stop(tx as unknown as Db));
    if (!outcome) return getRun(run.id);
    adapterExecutionControls.get(run.id)?.controller.abort(new Error(reason));
    if (outcome.successorId) {
      // Native cancellation request IDs belong to one run and cannot be lent
      // to its successor. The successor uses its existing owned Stop path.
      const { cancellationRequestId: _requestId, cancellationRequestedByUserId: _requestUser, ...successorOptions } = options;
      await cancelRunInternal(outcome.successorId, reason, successorOptions);
    }
    if (outcome.updated) {
      await appendRunEvent(outcome.stopped, { eventType: "lifecycle", stream: "system", level: "info",
        message: "computer admission retry cancelled", payload: { cancellation } });
    }
    // The executor's finally block owns this acknowledgement while cleanup is
    // live. Until then retain the task lock and do not drain queued messages.
    if (!activeRunExecutions.has(run.id) && hasSettledComputerAdmissionPreparation(outcome.stopped)) {
      const [acknowledged] = await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
        ${JSON.stringify({ executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } })}::jsonb`,
      }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "cancelled"),
        sql`${heartbeatRuns.resultJson}->>'computerAdmissionRetryOutcome' = 'aborted'`)).returning();
      if (!acknowledged) return getRun(run.id);
      await releaseIssueExecutionAndPromote(acknowledged, { suppressImmediateRecovery: true });
      await finalizeAgentStatus(run.agentId, "cancelled", undefined, { wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run) });
    }
    return getRun(run.id);
  }

  async function cancelRunInternal(
    runId: string,
    reason = "Cancelled by control plane",
    options: CancelRunOptions = {},
  ): Promise<typeof heartbeatRuns.$inferSelect | null> {
    let run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (options.cancellationRequestId) {
      run = await claimCancellationRequest(db, runId, run.companyId, options.cancellationRequestId, options.cancellationRequestedByUserId ?? null);
    }
    if (run.status === "cancelled" && run.errorCode === "computer_admission_wait") {
      return cancelComputerAdmissionWait(run, reason, options);
    }
    // The caller claim checked retry eligibility under both durable row locks.
    // This is only a cancellation candidate: dispatch rechecks the coordinator
    // under lock, and the final CAS requires its own unchanged acknowledged
    // retry fence. Re-reading only retryable_failure here would strand replay.
    const pendingNativeRetry =
      run.runtimeMode === "native" && run.status === "failed" && (
        Boolean(options.cancellationRequestId) || await db
          .select({ runId: nativeRunFinalizations.runId })
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.runId, run.id),
              eq(nativeRunFinalizations.companyId, run.companyId),
              eq(nativeRunFinalizations.phase, "retryable_failure"),
            ),
          )
          .then((rows) => rows.length > 0)
      );
    if (
      !pendingNativeRetry &&
      !CANCELLABLE_HEARTBEAT_RUN_STATUSES.includes(
        run.status as (typeof CANCELLABLE_HEARTBEAT_RUN_STATUSES)[number],
      )
    )
      return run;
    const agent = await getAgent(run.agentId);
    const errorCode = options.errorCode ?? "cancelled";
    const cancellation = requestedRunCancellation(options.resultJson ?? {}, reason);

    const pendingProcessCancellation = processRunCancellationSettlements.get(
      run.id,
    );
    if (pendingProcessCancellation) {
      await pendingProcessCancellation.settled;
      if (pendingProcessCancellation.failed)
        throw pendingProcessCancellation.error;
      return getRun(run.id);
    }
    const running = runningProcesses.get(run.id);
    const stopOwnership =
      run.runtimeMode !== "native"
        ? captureAdapterStopOwnership(run.id)
        : undefined;
    const control = stopOwnership?.control;
    // Capture the existing adapter owner before waiting on the run lock. Then
    // atomically fence preparation and refresh the selected runtime, so Stop
    // cannot miss a native handoff that won after its first read.
    // Established legacy processes must still be stopped if the database is
    // unavailable. Only native or not-yet-dispatched preparation needs this
    // additional durable fence before its existing cancellation path.
    if (options.budgetEnforcement || (!options.cancellationRequestId && (run.runtimeMode === "native" || (!run.runtimeModeResolvedAt && !running && !control)))) {
      const fence = async (tx: Db) => {
        const [fenced] = await tx.update(heartbeatRuns).set({
          // Record handoff intent before native cancellation can finalize and release
          // the run. Only its audited stop acknowledgement suppresses recovery.
          resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
            ${JSON.stringify(options.errorCode === "issue_reassigned" && options.resultJson?.reassignmentStopConfirmed === true
              ? { reassignmentStopRequested: true } : {})}::jsonb ||
            ${JSON.stringify({ cancellation })}::jsonb ||
            jsonb_build_object('startupCancellation', jsonb_build_object(
              'requestedAt', ${new Date().toISOString()}::text,
              'beforeNativeSelection', ${heartbeatRuns.runtimeMode} = 'legacy'
                and ${heartbeatRuns.runtimeModeResolvedAt} is null
                and ${heartbeatRuns.executionStage} = 'preparing'
                and coalesce(${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = 'paperclip_runner', false)
            ))`,
        }).where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status,
          pendingNativeRetry ? [...CANCELLABLE_HEARTBEAT_RUN_STATUSES, "failed"] : [...CANCELLABLE_HEARTBEAT_RUN_STATUSES],
        ))).returning();
        return fenced ?? null;
      };
      let fenced: typeof run | null;
      try {
        fenced = options.budgetEnforcement
          ? await withCurrentBudgetEnforcement(db, options.budgetEnforcement, fence)
          : await fence(db);
      } catch (error) {
        stopOwnership?.release();
        throw error;
      }
      if (!fenced) {
        stopOwnership?.release();
        return getRun(runId);
      }
      run = fenced;
    }
    const resultJson = { ...(agent
      ? {
          ...mergeRunStopMetadataForAgent(agent, "cancelled", {
            resultJson: parseObject(run.resultJson),
            errorCode,
            errorMessage: reason,
          }),
          ...(options.resultJson ?? {}),
        }
      : options.resultJson), cancellation };

    try {
      let releaseProcessCancellation: (() => void) | undefined;
      const processCancellationSettlement =
        run.runtimeMode !== "native" &&
        !control &&
        running
          ? {
              settled: new Promise<void>((resolve) => {
                releaseProcessCancellation = resolve;
              }),
              failed: false,
              error: undefined as unknown,
            }
          : undefined;
      if (processCancellationSettlement) {
        // No await between joining an existing owner above and registering ours.
        processRunCancellationSettlements.set(
          run.id,
          processCancellationSettlement,
        );
      }
      const cancellation = await (async () => {
        try {
          if (control) {
            await db
              .update(heartbeatRuns)
              .set({
                error: reason,
                errorCode,
                // Stop may have read the row before adapter settlement saved
                // a required-copyback receipt. Merge into current database JSON
                // and leave those server-owned fields to the restore recorder.
                resultJson: preserveWorkspaceRestoreRecoveryMetadataSql({
                  ...resultJson,
                  ...(!running ? { executionCancellation: {
                    state: "requested", requestedAt: new Date().toISOString(),
                  } } : {}),
                }, true),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(heartbeatRuns.id, run.id),
                  eq(heartbeatRuns.status, "running"),
                ),
              );
            control.controller.abort(new Error(reason));
          }
          let terminationSettled = false;
          try {
            await cancelHeartbeatNativeRun({
              db,
              runId: run.id,
              reason,
              runtimeMode: run.runtimeMode,
              ...(options.cancellationRequestId ? { cancellationRequestId: options.cancellationRequestId } : {}),
            });
            if (running) {
              await terminateHeartbeatRunProcess({
                pid: running.child.pid,
                processGroupId: running.processGroupId,
                // Codex handles Ctrl-C by cancelling its tool sessions. SIGTERM
                // can leave commands in their separate process groups alive.
                signal: !control && agent?.adapterType === "codex_local" ? "SIGINT" : undefined,
                graceMs: cancellationTerminationGraceMs(
                  running.graceSec,
                  options.terminationGraceMs,
                ),
              });
            }
            terminationSettled = true;
          } finally {
            if (
              (!processCancellationSettlement || terminationSettled) &&
              runningProcesses.get(run.id) === running
            ) {
              runningProcesses.delete(run.id);
            }
          }

          if (control) {
            await waitForAdapterStop(control.settled, undefined, {
              runId: run.id,
              adapterType: agent?.adapterType,
              runtimeMode: run.runtimeMode,
              abortRequested: control.controller.signal.aborted,
            }, control);
            const stopped = await getRun(run.id);
            if (stopped && isHeartbeatRunTerminalStatus(stopped.status)) {
              if (
                parseObject(stopped.resultJson?.executionCancellation).state !==
                "acknowledged"
              ) {
                throw conflict(
                  "Execution ended, but provider termination could not be verified. Inspect the stopped run before continuing.",
                );
              }
              // The owned adapter already finalized this run and its lifecycle.
              // Do not replay the process cancellation side effects below.
              return { run: stopped, updated: false };
            }
          }

          const finishedAt = new Date();
          const persistedCancellationResult =
            run.runtimeMode === "native"
              ? await getRun(run.id).then((current) =>
                  parseObject(current?.resultJson),
                )
              : {};
          return await setRunStatusFromLive(
            run.id,
            "cancelled",
            pendingNativeRetry
              ? [...CANCELLABLE_HEARTBEAT_RUN_STATUSES, "failed"]
              : [...CANCELLABLE_HEARTBEAT_RUN_STATUSES],
            {
              finishedAt,
              error: reason,
              errorCode,
              ...(resultJson ||
              Object.keys(persistedCancellationResult).length > 0
                ? {
                    resultJson: {
                      ...persistedCancellationResult,
                      ...(resultJson ?? {}),
                      // A scheduler placeholder has no process to acknowledge.
                      // Preserve its normal release policy instead of treating
                      // it as an operator stop of provider work.
                      ...(processCancellationSettlement && agent && running && (
                        (Number.isInteger(running.child.pid) && (running.child.pid ?? 0) > 0) ||
                        (Number.isInteger(running.processGroupId) && (running.processGroupId ?? 0) > 0)
                      )
                        ? mergeRunStopMetadataForAgent(agent, "cancelled", {
                            resultJson: {
                              ...resultJson,
                              executionCancellation: { state: "acknowledged", acknowledgedAt: finishedAt.toISOString() },
                            },
                            errorCode, errorMessage: reason,
                          })
                        : {}),
                      // The native cancellation helper may have advanced a durable
                      // pending intent to its acknowledged state after `run` was
                      // first read. Never let that stale snapshot overwrite the
                      // authoritative post-dispatch acknowledgement.
                      ...(Object.hasOwn(
                        persistedCancellationResult,
                        "nativeCancellation",
                      )
                        ? {
                            nativeCancellation:
                              persistedCancellationResult.nativeCancellation,
                          }
                        : {}),
                    },
                  }
                : {}),
            },
            undefined,
            pendingNativeRetry ? nativeRetryCancellationCommitCondition(persistedCancellationResult) : undefined,
          );
        } catch (error) {
          if (processCancellationSettlement) {
            processCancellationSettlement.failed = true;
            processCancellationSettlement.error = error;
            if (activeRunExecutions.has(run.id)) {
              failedProcessRunCancellations.set(
                run.id,
                processCancellationSettlement,
              );
            }
          }
          throw error;
        } finally {
          if (processCancellationSettlement) {
            if (
              processRunCancellationSettlements.get(run.id) ===
              processCancellationSettlement
            ) {
              processRunCancellationSettlements.delete(run.id);
            }
            // Always settle waiters, including termination and DB errors. A
            // failed Stop remains an error to its caller, never a cancellation
            // receipt; the signal-bearing executor may then record failure.
            releaseProcessCancellation?.();
          }
        }
      })();
      const cancelled = cancellation.run;

      if (cancellation.updated && cancelled) {
        await setWakeupStatus(run.wakeupRequestId, "cancelled", {
          finishedAt: cancelled.finishedAt ?? new Date(),
          error: reason,
        });
        await appendRunEvent(cancelled, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: options.eventMessage ?? "run cancelled",
          payload: { ...options.eventPayload, cancellation: readRunCancellation(cancelled.resultJson) },
        });
        await releaseIssueExecutionAndPromote(cancelled, {
          suppressImmediateRecovery: options.suppressImmediateRecovery,
        });
        await finalizeAgentStatus(run.agentId, "cancelled", undefined, {
          wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
        });
        await startNextQueuedRunForAgent(run.agentId);
      }
      return cancelled;
    } finally {
      stopOwnership?.release();
    }
  }

  async function cancelActiveForAgentInternal(
    agentId: string,
    reason = "Cancelled due to agent pause",
    errorCode = "cancelled",
  ) {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, [...CANCELLABLE_HEARTBEAT_RUN_STATUSES]),
        ),
      );

    for (const run of runs) await cancelRunInternal(run.id, reason, { errorCode });

    return runs.length;
  }

  async function cancelPendingWakeupsForAgentsInternal(
    agentIds: string[],
    reason: string,
  ) {
    const uniqueAgentIds = [...new Set(agentIds)].filter(
      (agentId) => agentId.length > 0,
    );
    if (uniqueAgentIds.length === 0) return 0;

    const now = new Date();
    const wakeupIds = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          inArray(agentWakeupRequests.agentId, uniqueAgentIds),
          inArray(agentWakeupRequests.status, [
            "queued",
            "deferred_issue_execution",
          ]),
          sql`${agentWakeupRequests.runId} is null`,
        ),
      )
      .then((rows) => rows.map((row) => row.id));

    if (wakeupIds.length === 0) return 0;

    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: reason,
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));

    return wakeupIds.length;
  }

  async function cancelInvocationsForAgentsInternal(
    agentIds: string[],
    reason: string,
  ) {
    const uniqueAgentIds = [...new Set(agentIds)].filter(
      (agentId) => agentId.length > 0,
    );
    let runsCancelled = 0;
    for (const agentId of uniqueAgentIds) {
      runsCancelled += await cancelActiveForAgentInternal(agentId, reason);
    }
    const wakeupsCancelled = await cancelPendingWakeupsForAgentsInternal(
      uniqueAgentIds,
      reason,
    );
    return {
      agentIds: uniqueAgentIds,
      runsCancelled,
      wakeupsCancelled,
    };
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    const runIds = scope.scopeType === "project"
      ? await listProjectScopedRunIds(scope.companyId, scope.scopeId, scope.createdBefore)
      : await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, scope.companyId),
        scope.scopeType === "agent" ? eq(heartbeatRuns.agentId, scope.scopeId) : undefined,
        scope.createdBefore ? lt(heartbeatRuns.createdAt, scope.createdBefore) : undefined,
        inArray(heartbeatRuns.status, [...CANCELLABLE_HEARTBEAT_RUN_STATUSES]),
      )).then((rows) => rows.map((row) => row.id));
    for (const runId of runIds) await cancelRunInternal(runId, "Cancelled due to budget pause", { budgetEnforcement: scope });
    await cancelPendingWakeupsForBudgetScope(scope);
  }

  return {
    cancelBudgetScopeWork,
    releaseIssueExecutionAndPromote,
    releaseEnvironmentLeasesForRun,
    acknowledgeRemoteStop,
    resumeRemoteStopComments,
    cancelRunInternal,
    resumeExecutionWaitComments,
    resumeQueuedCommentInterrupt,
    resumeSavedLegacyComments,
    cancelActiveForAgentInternal,
    cancelInvocationsForAgentsInternal,
  };
}
