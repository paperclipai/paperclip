import { safeChatWakeAuthorityReason, type ChatWakeAuthorityReason } from "./inbound/wakeup-authorization-error.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { admitExplicitNativeContinuation } from "../explicit-native-continuation.js";
import { continuingTeamsFilePublication, type ContinuingTeamsFileTransfer } from "./microsoft-teams/file-transfer-source.js";
import { readTaskChatRetryIntent, taskChatRetryCanAwaitRecovery, taskChatRetryExecutionStopped, taskChatRetryAdmittedContinuationStopped } from "./task-retry-authority.js";
import { notifyChatActionWork, notifyChatPublicationWork } from "../chat-work-notifications.js";
import { FAILED_RUN_RETRY_STALE_MS, dueChatAction } from "../chat-action-work.js";
import { readChatAuthorizationRun } from "./authorization-run-read.js";
import { selectTaskRetryInput, claimTaskRetryInput, settleTaskRetryInput, releaseUnadmittedTaskRetryInput, taskRetryInputSchema, type TaskRetryInput } from "./task-retry-input.js";
import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";
import type { TaskRetryWakeAuthority } from "./github/task-retry-authorization.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  createDurableChatWakeupRequest,
  assertDurableChatWakeupReceipt,
  registerFailedChatRunRetryAuthority,
  registerCommittedChatResponseAuthority,
  CommittedChatResponseAuthorizationError,
} from "../durable-chat-wakeup.js";
import {
  agentWakeupRequests,
  agents,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatPublications,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeRunFinalizations,
  nativeRunResults,
  environmentLeases,
  issueComments,
  issueThreadInteractions,
  issueQuestionResponseDeliveries,
  issues,
} from "@paperclipai/db";
import type {
  ChatProvider,
} from "@paperclipai/shared";
import {
  isAgentStatusInvokable,
  CHAT_PROVIDERS,
  isUuidLike,
} from "@paperclipai/shared";

import {
  nativeFailedRunRetryStateIsSafe,
  nativePreProviderRetryAfterCleanupStateIsSafe,
  nativeProviderRecoveryEvidence,
} from "../native-runtime/native-session-executor.js";

import {
  HttpError,
  conflict,
  notFound,
} from "../../errors.js";

import {
  logActivity,
  persistActivity,
} from "../activity-log.js";
import {
  type IssueAssignmentWakeupDeps,
} from "../issue-assignment-wakeup.js";

import {
  NativeChatReviewPresentationContentionError,
} from "../native-runtime/native-chat-review-presentation.js";
import { isExternalChatWaitAuthorizationContention } from "../native-runtime/chat-attachment-reuse.js";
import { CHAT_CONVERSATION_ID_KEY } from "../../modules/run-dispatch/index.js";
import { projectSafeChatPublication } from "../chat-publication-projection.js";

import {
  inboundWakePublicationKey,
} from "../chat-inbound-wakeup-publications.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type DeliveryRow = typeof chatDeliveries.$inferSelect;
type RetryRuntimeFence = { credentialFingerprint: string; generation: number };
export type ChatFailedRetrySource = Awaited<ReturnType<ReturnType<typeof createChatFailedRunRetry>["failedChatRetrySource"]>>;

type ChatFailedRunRetryOptions = {
  authorizeGitHubTaskRetryBatch: ReturnType<typeof import("./inbound/wakeup-authorization.js").createInboundWakeAuthority>["authorizeGitHubTaskRetryBatch"];
  authorizeInboundWakeup: (
    database: DbOrTransaction,
    action: typeof chatActions.$inferSelect,
    notice?: { nonblocking: true; terminal: boolean; taskRetry?: TaskRetryWakeAuthority },
  ) => Promise<{
    conversation: Pick<typeof chatConversations.$inferSelect, "sessionGeneration">;
    endpoint: Pick<typeof chatEndpoints.$inferSelect, "provider">;
    delivery: DeliveryRow;
    retryRuntimeFence?: RetryRuntimeFence;
  }>;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  inboundWakeScope: (action: typeof chatActions.$inferSelect) => string;
  lifecycleRuntimeFence: (delivery: DeliveryRow) => RetryRuntimeFence | null;
  isShuttingDown: () => boolean;
  wakeup: IssueAssignmentWakeupDeps["wakeup"];
};

export function createChatFailedRunRetry(db: Db, options: ChatFailedRunRetryOptions) {
  const {
    authorizeInboundWakeup,
    authorizeGitHubTaskRetryBatch,
    isExternalActionAuthorizationChange,
    inboundWakeScope,
    lifecycleRuntimeFence,
    isShuttingDown,
    wakeup,
  } = options;


  const failedChatRetryDenied = (reason?: "accepted_result_without_new_input" |
    "prior_result_publication" | "prior_interaction" | "source_authorization", authorityReason?: ChatWakeAuthorityReason) =>
    conflict(
      reason === "accepted_result_without_new_input"
        ? "This attempt already recorded a result. Send a new message on the task to continue from the saved work."
        : "The exact failed chat request can no longer be retried safely. Check its current connection, access, and recovery state.",
      { code: "chat_failed_run_retry_not_authorized", ...(reason ? { reason } : {}), ...(reason === "source_authorization" && authorityReason ? { authorityReason } : {}) },
    );
  class FailedChatRetryPublicationReadError extends Error {
    constructor() {
      super("Chat retry publication authorization is temporarily unavailable");
    }
  }

  function retryCommentIds(context: Record<string, unknown>, taskRetryInput?: TaskRetryInput): string[] {
    const ids =
      context.wakeCommentIds ??
      (context.wakeCommentId ? [context.wakeCommentId] : []);
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      (!taskRetryInput && ids.length > 50) ||
      ids.some((id) => typeof id !== "string" || !isUuidLike(id)) ||
      new Set(ids).size !== ids.length ||
      (context.wakeCommentId !== undefined &&
        context.wakeCommentId !== ids.at(-1))
    )
      throw failedChatRetryDenied();
    return ids as string[];
  }

  type FailedChatRetrySource = {
    failedRunId: string;
    sourceWakeupRequestId: string;
    issueId: string;
    agentId: string;
    taskKey: string;
    provider: ChatProvider;
    commentIds: string[];
    sources: Array<Record<string, unknown>>;
    endpointId: string;
    conversationId: string;
    principalId: string;
    sessionGeneration: number;
    requestedByActorType: "user" | "system";
    requestedByActorId: string;
    retryAncestors: Array<{
      actionId: string;
      failedRunId: string;
      sourceScopeSha256: string;
    }>;
    taskRetryInput?: TaskRetryInput;
    sourceScopeSha256: string;
  };
  function hashFailedRetrySource(
    scope: Omit<FailedChatRetrySource, "sourceScopeSha256">,
  ): FailedChatRetrySource {
    return {
      ...scope,
      sourceScopeSha256: createHash("sha256")
        .update(JSON.stringify(scope))
        .digest("hex"),
    };
  }

  function assertFailedRetryReceipt(
    ...args: Parameters<typeof assertDurableChatWakeupReceipt>
  ) {
    try {
      assertDurableChatWakeupReceipt(...args);
    } catch {
      throw failedChatRetryDenied();
    }
  }

  /** Certify known preparation boundaries from their server-owned failure
   * contract and absence of execution evidence. Other workspace validations
   * may run after acquisition and must not inherit this exception. A saved
   * session display hint never establishes containment or resume authority. */
  async function isPreProviderChatFailure(
    tx: DbOrTransaction,
    run: typeof heartbeatRuns.$inferSelect,
    allowWorkspacePreparation = false,
  ): Promise<boolean> {
    const retryDiagnostic = "The exact failed chat request can no longer be retried safely. Check its current connection, access, and recovery state.";
    const failedRetry = run.errorCode === "chat_failed_run_retry_not_authorized" && run.error === retryDiagnostic;
    const validation = run.resultJson?.workspaceValidation as Record<string, unknown> | undefined;
    const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
    const workspacePreparation = allowWorkspacePreparation && run.errorCode === "workspace_validation_failed" &&
      validation?.reason === "isolated_task_directory_binding_mismatch" &&
      typeof validation.issueId === "string" && validation.issueId === run.contextSnapshot?.issueId &&
      (run.issueId === null || run.issueId === validation.issueId) &&
      (run.contextSnapshot?.taskId === undefined || run.contextSnapshot.taskId === validation.issueId) &&
      Object.keys(validation).every(key => ["reason", "issueId"].includes(key)) &&
      recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false &&
      Object.keys(recovery).every(key => ["kind", "providerWorkStarted"].includes(key)) &&
      run.resultJson?.stopReason === "adapter_failed" &&
      Object.keys(run.resultJson).every(key => ["executionRecovery", "workspaceValidation", "stopReason",
        "effectiveTimeoutSec", "timeoutConfigured", "timeoutFired", "timeoutSource"].includes(key));
    const diagnostic = failedRetry ? retryDiagnostic : workspacePreparation ? run.error : "reviewed_chat_execution_binding_not_authorized";
    const dispatchOnlyProfile = failedRetry || workspacePreparation;
    if (
      adapterExecutionControls.has(run.id) ||
      (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) ||
      run.runtimeMode !== "legacy" ||
      (!failedRetry && !workspacePreparation && run.errorCode !== "setup_failed") ||
      run.status !== "failed" || !run.finishedAt ||
      (failedRetry && run.sessionIdBefore !== null) ||
      (dispatchOnlyProfile && JSON.stringify(run.runnerProfileJson) !== JSON.stringify({ adapterDispatch: { adapterType: "paperclip_runner" } })) ||
      !diagnostic || run.error !== diagnostic ||
      (workspacePreparation && run.usageJson !== null &&
        Object.keys(run.usageJson).some(key => key !== "ledgerScope")) ||
      [
        run.runtimeModeResolverVersion,
        run.runtimeModeReason,
        run.runtimeModeResolvedAt,
        ...(dispatchOnlyProfile ? [] : [run.runnerProfileJson]),
        run.runnerInstanceId,
        run.nativeSessionId,
        run.nativeIssueId,
        run.nativePhase,
        run.driverKind,
        run.driverVersion,
        run.completionContractId,
        run.completionContractSha256,
        run.sessionIdAfter,
        run.externalRunId,
        run.processPid,
        run.processGroupId,
        run.processStartedAt,
        run.logStore,
        run.logRef,
        run.logBytes,
        run.logSha256,
        run.stdoutExcerpt,
        run.stderrExcerpt,
        run.lastOutputAt,
        run.lastOutputStream,
        run.lastOutputBytes,
        ...(workspacePreparation ? [] : [run.usageJson]),
        run.exitCode,
        run.signal,
      ].some((value) => value !== null) ||
      run.lastOutputSeq !== 0 ||
      run.logCompressed
    )
      return false;
    const events = await tx
      .select()
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.companyId, run.companyId),
          eq(heartbeatRunEvents.runId, run.id),
        ),
      )
      .orderBy(asc(heartbeatRunEvents.seq))
      .limit(workspacePreparation ? 4 : 3)
      .for("share", { noWait: true });
    let preparationOffset = 0;
    const warning = events[0];
    if (workspacePreparation && warning?.eventType === "agent_observability.unavailable") {
      // This known warning is written by configuration preparation, before
      // workspace allocation. It is not evidence that a provider executed.
      if (warning.seq !== 1 || warning.agentId !== run.agentId || warning.stream !== "system" || warning.level !== "warn" ||
          warning.message !== "Company observability was not applied: this harness is not supported." ||
          warning.payload?.reason !== "unsupported_harness" || (typeof warning.payload.revision !== "string" || !isUuidLike(warning.payload.revision)) ||
          Object.keys(warning.payload).some(key => !["reason", "revision"].includes(key)) ||
          warning.sourceInstanceId !== null || warning.sourceEventId !== null || warning.sourceSeq !== null ||
          warning.sourcePayloadSha256 !== null || warning.protocolSchemaVersion !== null) return false;
      preparationOffset = 1;
    }
    const event = events[preparationOffset];
    const measured = events[preparationOffset + 1];
    if (failedRetry) {
      const explicit = run.contextSnapshot?.explicitUserContinuation as Record<string, unknown> | undefined;
      const hint = run.contextSnapshot?.chatFailedRunRetry as Record<string, unknown> | undefined;
      const intentId = run.contextSnapshot?.taskRetryRequestId;
      if (typeof intentId !== "string" || !run.retryOfRunId || !run.wakeupRequestId ||
          hint?.version !== 1 || hint.actionId !== run.wakeupRequestId || hint.failedRunId !== run.retryOfRunId ||
          explicit?.previousRunId !== run.retryOfRunId || explicit.taskRetryRequestId !== intentId ||
          explicit.commentId !== run.contextSnapshot?.wakeCommentId) return false;
      const prior = await readTaskChatRetryIntent(tx as unknown as Db, { companyId: run.companyId,
        issueId: String(run.contextSnapshot?.issueId), agentId: run.agentId,
        sourceRunId: run.retryOfRunId, intentId, chatActionId: run.wakeupRequestId });
      if (!prior || prior.wake.status !== "coalesced" || prior.wake.runId !== run.id) return false;
    }
    if (failedRetry || workspacePreparation) {
      if (!measured || measured.seq !== 2 + preparationOffset || measured.agentId !== run.agentId ||
          measured.eventType !== "lifecycle" || measured.stream !== "system" ||
          measured.message !== "task.run.measured" || measured.sourceInstanceId !== null ||
          measured.sourceEventId !== null || measured.sourceSeq !== null || measured.sourcePayloadSha256 !== null ||
          measured.protocolSchemaVersion !== null || typeof measured.payload?.durationMs !== "number" ||
          !Number.isFinite(measured.payload.durationMs) || measured.payload.durationMs < 0 ||
          measured.payload?.durableSettlement !== true || measured.payload?.outcome !== "failed" ||
          measured.payload?.phase !== "task.run.measured") return false;
    }
    if (
      events.length !== (failedRetry || workspacePreparation ? 2 + preparationOffset : 1) ||
      !event ||
      event.agentId !== run.agentId ||
      event.seq !== 1 + preparationOffset ||
      event.eventType !== "error" ||
      event.stream !== "system" ||
      event.level !== "error" ||
      event.message !== diagnostic ||
      event.payload !== null ||
      event.sourceInstanceId !== null ||
      event.sourceEventId !== null ||
      event.sourceSeq !== null ||
      event.sourcePayloadSha256 !== null ||
      event.protocolSchemaVersion !== null
    )
      return false;
    const evidence = await tx.execute(sql`select 1 where
      exists (select 1 from native_run_finalizations where company_id = ${run.companyId}::uuid and run_id = ${run.id}::uuid)
      or exists (select 1 from native_run_results where company_id = ${run.companyId}::uuid and run_id = ${run.id}::uuid)
      or exists (select 1 from environment_leases where company_id = ${run.companyId}::uuid and heartbeat_run_id = ${run.id}::uuid)`);
    return evidence.length === 0;
  }

  async function failedNativeRetryCoordinator(
    tx: DbOrTransaction,
    run: typeof heartbeatRuns.$inferSelect,
    issueId: string,
  ) {
    const [coordinator] = await tx
      .select()
      .from(nativeRunFinalizations)
      .where(
        and(
          eq(nativeRunFinalizations.runId, run.id),
          eq(nativeRunFinalizations.companyId, run.companyId),
          eq(nativeRunFinalizations.issueId, issueId),
        ),
      )
      .for("share", { noWait: true });
    // A queued request can fail before its first provider event because the
    // predecessor's exact retained checkpoint has not yet been suspended.
    // A later authenticated cleanup receipt can authorize retrying that
    // request; never pretend it exhausted provider execution attempts.
    if (
      coordinator &&
      run.nativeIssueId === issueId &&
      run.status === "failed" &&
      run.errorCode === "adapter_failed" &&
      // A diagnostic reason does not change this failure category. The exact
      // checkpoint, cleanup receipt, and no-provider-work proofs below still
      // decide whether the original request can be retried.
      (run.error === "runner_state_identity_mismatch" ||
        run.error?.startsWith("runner_state_identity_mismatch: ")) &&
      run.nativePhase === "observed" &&
      coordinator.phase === "observed" &&
      coordinator.attempt === 0 &&
      !coordinator.leaseOwner &&
      !coordinator.leaseExpiresAt &&
      !coordinator.nextAttemptAt &&
      !coordinator.resultId &&
      !coordinator.assessmentId &&
      !coordinator.decisionId &&
      run.nativeSessionId &&
      run.processPid &&
      run.processGroupId === run.processPid
    ) {
      const [event] = await tx
        .select({ id: heartbeatRunEvents.id })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.companyId, run.companyId),
            eq(heartbeatRunEvents.runId, run.id),
            or(
              isNotNull(heartbeatRunEvents.sourceInstanceId),
              sql`${heartbeatRunEvents.payload}->'prpEvent' is not null`,
            ),
          ),
        )
        .limit(1);
      const [result] = await tx
        .select({ id: nativeRunResults.id })
        .from(nativeRunResults)
        .where(
          and(
            eq(nativeRunResults.companyId, run.companyId),
            eq(nativeRunResults.runId, run.id),
          ),
        )
        .limit(1);
      const checkpoint = run.runnerProfileJson?.sessionCheckpoint as
        | Record<string, unknown>
        | undefined;
      const binding = checkpoint?.identity as
        | Record<string, unknown>
        | undefined;
      if (
        !event &&
        !result &&
        binding?.companyId === run.companyId &&
        binding?.issueId === issueId &&
        binding?.agentId === run.agentId &&
        binding?.runId === run.id &&
        binding?.sessionId === run.nativeSessionId &&
        typeof checkpoint?.sessionId === "string" &&
        checkpoint.sessionId.trim().length > 0 &&
        (checkpoint.providerSessionId == null ||
          (typeof checkpoint.providerSessionId === "string" &&
            checkpoint.providerSessionId.trim().length > 0))
      ) {
        const predecessors = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, run.companyId),
              eq(heartbeatRuns.agentId, run.agentId),
              eq(heartbeatRuns.nativeIssueId, issueId),
              eq(heartbeatRuns.nativeSessionId, run.nativeSessionId),
              eq(heartbeatRuns.processPid, run.processPid),
              eq(heartbeatRuns.processGroupId, run.processGroupId),
              eq(heartbeatRuns.runtimeMode, "native"),
              eq(heartbeatRuns.status, "succeeded"),
              ne(heartbeatRuns.id, run.id),
              // Warm runs can share a PID and session. Only a durable maintenance
              // owner is a candidate; the physical check below must still prove
              // that this exact run owns the canonical suspended checkpoint.
              sql`exists (select 1 from native_run_finalizations retired
            where retired.company_id = ${heartbeatRuns.companyId}
              and retired.run_id = ${heartbeatRuns.id}
              and retired.phase = 'committed'
              and exists (select 1 from jsonb_array_elements(retired.recovery_history) receipt
                where receipt->>'kind' = 'native_cleanup_maintenance'
                  and receipt->>'phase' = 'settled' and receipt->>'version' = '1'))`,
            ),
          )
          .for("share", { noWait: true })
          .limit(2);
        if (predecessors.length === 1) {
          const predecessor = predecessors[0]!;
          const [retired] = await tx
            .select()
            .from(nativeRunFinalizations)
            .where(
              and(
                eq(nativeRunFinalizations.companyId, run.companyId),
                eq(nativeRunFinalizations.issueId, issueId),
                eq(nativeRunFinalizations.runId, predecessor.id),
              ),
            )
            .for("share", { noWait: true });
          const receipt = retired?.recoveryHistory.findLast(
            (entry) => entry.kind === "native_cleanup_maintenance",
          );
          const leases = await tx
            .select()
            .from(environmentLeases)
            .where(
              and(
                eq(environmentLeases.companyId, run.companyId),
                eq(environmentLeases.heartbeatRunId, run.id),
              ),
            )
            .for("share", { noWait: true });
          if (
            retired?.phase === "committed" &&
            retired.resultId &&
            retired.assessmentId &&
            retired.decisionId &&
            !retired.leaseOwner &&
            !retired.leaseExpiresAt &&
            !retired.nextAttemptAt &&
            receipt?.version === 1 &&
            receipt.phase === "settled" &&
            typeof receipt.requestId === "string" &&
            receipt.requestId.length > 0 &&
            receipt.nativeSessionId === run.nativeSessionId &&
            receipt.runnerInstanceId === predecessor.runnerInstanceId &&
            // The cleanup receipt identifies the provider thread. The
            // checkpoint's providerSessionId is the separate backend account.
            receipt.providerSessionId === checkpoint.sessionId &&
            typeof receipt.settledFingerprint === "string" &&
            /^[a-f0-9]{64}$/.test(receipt.settledFingerprint) &&
            typeof receipt.sourceFingerprint === "string" &&
            /^[a-f0-9]{64}$/.test(receipt.sourceFingerprint) &&
            leases.every(
              (lease) =>
                lease.provider === "local" &&
                lease.providerLeaseId === null &&
                lease.issueId === issueId &&
                ["failed", "released", "expired"].includes(lease.status) &&
                (lease.cleanupStatus === null ||
                  lease.cleanupStatus === "success") &&
                lease.releasedAt !== null,
            )
          ) {
            return {
              coordinator,
              leases,
              retiredOwner: {
                predecessor,
                receipt,
                providerSessionId: checkpoint.sessionId,
                providerBackendSessionId: checkpoint.providerSessionId ?? null,
              },
            };
          }
        }
      }
    }
    const detail = coordinator?.failureDetail;
    const ordinary = [
      "provider_process_exited",
      "provider_stdout_closed",
      "provider_process_output_closed",
      "provider_process_status_failed",
      "provider_initialize_timeout",
      "provider_initialize_protocol_error",
      "provider_request_timeout",
      "provider_request_protocol_error",
      "provider_transport_failed",
      "native_runner_process_exited",
    ];
    if (
      !coordinator ||
      run.nativeIssueId !== issueId ||
      run.nativePhase !== "terminal_failure" ||
      coordinator.phase !== "terminal_failure" ||
      coordinator.recoveryState !== "blocked" ||
      coordinator.failureCode !== "native_session_retry_exhausted" ||
      coordinator.attempt < 3 ||
      coordinator.leaseOwner ||
      coordinator.leaseExpiresAt ||
      coordinator.nextAttemptAt ||
      coordinator.resultId ||
      coordinator.assessmentId ||
      coordinator.decisionId ||
      !detail ||
      !ordinary.includes(String(detail.originalFailureCode)) ||
      !["bootstrap_retry", "exact_checkpoint_resume"].includes(
        String(detail.recoveryMode),
      ) ||
      ![
        "adapter_failed",
        "native_session_retry_exhausted",
        String(detail.originalFailureCode),
      ].includes(run.errorCode ?? "") ||
      (detail.recoveryMode === "bootstrap_retry" &&
        (detail.providerSessionEstablished !== false ||
          detail.providerEventsExist !== false ||
          detail.checkpointExists !== false)) ||
      (detail.recoveryMode === "exact_checkpoint_resume" &&
        (detail.providerSessionEstablished !== true ||
          detail.checkpointExists !== true))
    )
      throw failedChatRetryDenied();
    const evidence = await nativeProviderRecoveryEvidence({
      db: tx as unknown as Db,
      runId: run.id,
      sourceFailureCode: detail.originalFailureCode as Parameters<
        typeof nativeProviderRecoveryEvidence
      >[0]["sourceFailureCode"],
    });
    if (
      evidence.recoveryMode !== detail.recoveryMode ||
      evidence.providerSessionEstablished !==
        detail.providerSessionEstablished ||
      evidence.providerEventsExist !== detail.providerEventsExist ||
      evidence.checkpointExists !== detail.checkpointExists
    )
      throw failedChatRetryDenied();
    const leases = await tx
      .select()
      .from(environmentLeases)
      .where(
        and(
          eq(environmentLeases.companyId, run.companyId),
          eq(environmentLeases.heartbeatRunId, run.id),
        ),
      )
      .for("share", { noWait: true });
    if (
      leases.some(
        (lease) =>
          !["released", "expired", "failed"].includes(lease.status) ||
          lease.cleanupStatus !== "success" ||
          !lease.releasedAt,
      )
    )
      throw failedChatRetryDenied();
    return { coordinator, leases, retiredOwner: null };
  }

  async function assertFailedNativeRetryState(
    tx: DbOrTransaction,
    source: Pick<FailedChatRetrySource, "failedRunId" | "issueId" | "agentId" | "commentIds" | "taskRetryInput" | "requestedByActorType" | "requestedByActorId">,
    companyId: string,
    taskRetryIntentId?: string,
    allowPendingRecovery = false,
    executionRunId?: string,
  ) {
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, source.failedRunId),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, source.agentId),
        ),
      )
      .for("share", { noWait: true });
    if (!run) throw failedChatRetryDenied();
    if (taskRetryIntentId) {
      if (!await readTaskChatRetryIntent(tx as unknown as Db, { companyId, issueId: source.issueId,
        agentId: source.agentId, sourceRunId: run.id, intentId: taskRetryIntentId })) throw failedChatRetryDenied();
      const previousComments = new Set(source.taskRetryInput?.sourceActionIds.length
        ? retryCommentIds(run.contextSnapshot ?? {}, source.taskRetryInput) : []);
      const newInput = source.taskRetryInput?.sourceActionIds.length && source.requestedByActorType === "user" &&
        source.commentIds.length && source.commentIds.every(id => !previousComments.has(id));
      if (newInput) {
        // Persisting independent input may wait behind an unknown executor.
        // Promotion still requires the ordinary new-user-turn stop proof.
        if (allowPendingRecovery) return;
        if (executionRunId && await taskChatRetryAdmittedContinuationStopped(tx as unknown as Db, run, {
          issueId: source.issueId, intentId: taskRetryIntentId, successorRunId: executionRunId,
          commentId: source.commentIds.at(-1)!,
        })) return;
        if (await admitExplicitNativeContinuation({ db: tx as Db, companyId, issueId: source.issueId,
          agentId: source.agentId, actorType: "user", actorId: source.requestedByActorId,
          reason: "issue_commented", commentId: source.commentIds.at(-1)!, successorRunId: taskRetryIntentId,
          dryRun: true })) return;
      }
      if (await taskChatRetryExecutionStopped(tx as unknown as Db, run) ||
          await isPreProviderChatFailure(tx, run, true)) return;
      if (allowPendingRecovery && await taskChatRetryCanAwaitRecovery(
        tx as unknown as Db, run, source.issueId, taskRetryIntentId,
      )) return;
      // A still-live/unknown executor remains held. The exact pre-provider
      // proof below can establish a never-started native attempt.
      if (run.runtimeMode !== "native") throw failedChatRetryDenied();
    }
    if (run.runtimeMode !== "native") return;
    const { coordinator, leases, retiredOwner } =
      await failedNativeRetryCoordinator(tx, run, source.issueId);
    if (retiredOwner) {
      if (
        !nativePreProviderRetryAfterCleanupStateIsSafe({
          failedExecution: run.runnerProfileJson?.nativeExecutionInput,
          retiredExecution:
            retiredOwner.predecessor.runnerProfileJson?.nativeExecutionInput,
          companyId,
          issueId: source.issueId,
          agentId: source.agentId,
          failedRunId: run.id,
          retiredRunId: retiredOwner.predecessor.id,
          nativeSessionId: run.nativeSessionId!,
          runnerInstanceId: retiredOwner.predecessor.runnerInstanceId!,
          providerSessionId: retiredOwner.providerSessionId,
          providerBackendSessionId: retiredOwner.providerBackendSessionId,
          processPid: run.processPid!,
          processGroupId: run.processGroupId!,
          receipt: retiredOwner.receipt,
        })
      )
        throw failedChatRetryDenied();
      return;
    }
    const checkpoint = run.runnerProfileJson?.sessionCheckpoint as
      | Record<string, unknown>
      | undefined;
    if (
      !run.nativeSessionId ||
      !run.runnerInstanceId ||
      (checkpoint?.providerSessionId != null &&
        (typeof checkpoint.providerSessionId !== "string" ||
          checkpoint.providerSessionId.trim().length === 0)) ||
      !nativeFailedRunRetryStateIsSafe({
        execution: run.runnerProfileJson?.nativeExecutionInput,
        companyId,
        issueId: source.issueId,
        agentId: source.agentId,
        runId: run.id,
        nativeSessionId: run.nativeSessionId,
        runnerInstanceId: run.runnerInstanceId,
        processPid: run.processPid,
        processGroupId: run.processGroupId,
        providerSessionId:
          typeof checkpoint?.sessionId === "string"
            ? checkpoint.sessionId
            : null,
        providerBackendSessionId:
          typeof checkpoint?.providerSessionId === "string"
            ? checkpoint.providerSessionId
            : null,
        recoveryMode: coordinator.failureDetail!.recoveryMode as
          | "bootstrap_retry"
          | "exact_checkpoint_resume",
        allowVerifiedBackup: leases.length > 0,
      })
    )
      throw failedChatRetryDenied();
  }

  /** Resolve only a complete, originally admitted direct-chat batch. A retry
   * never turns caller JSON, task-description text, or a provider redelivery
   * into new input authority. Answer continuations require their own proof. */
  async function failedChatRetrySource(
    tx: DbOrTransaction,
    input: {
      companyId: string;
      issueId: string;
      agentId: string;
      failedRunId: string;
      retryActionId?: string;
      runId?: string;
      publication?: boolean;
      taskRetryIntentId?: string;
      taskRetryInput?: TaskRetryInput;
      taskRetryReauthorization?: TaskRetryWakeAuthority;
      /** Internal selector for already committed output, never retry admission. */
      committedResponse?: {
        resultId: string;
        canonicalSha256?: string;
        decisionId?: string;
        /** Internal source-proof continuation for one locked Teams transfer.
         * Never permission to repeat its card/PUT or retry a model run. */
        continuingTeamsFileTransfer?: ContinuingTeamsFileTransfer;
      };
    },
    visited = new Set<string>(),
  ): Promise<FailedChatRetrySource> {
    if (visited.has(input.failedRunId) || visited.size >= 16)
      throw failedChatRetryDenied();
    const ancestors = new Set([...visited, input.failedRunId]);
    const [issue] = await tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
        ),
      )
      .for(
        "update",
        input.publication || input.retryActionId ? { noWait: true } : undefined,
      );
    const [actor] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.companyId, input.companyId),
        ),
      )
      .for("share", { noWait: true });
    const evidence = await readChatAuthorizationRun(tx, input, Boolean(input.committedResponse));
    const failedRun = evidence.run;
    if (
      !issue ||
      issue.assigneeAgentId !== input.agentId ||
      !actor ||
      !isAgentStatusInvokable(actor.status) ||
      !failedRun ||
      !failedRun.wakeupRequestId ||
      (!input.committedResponse &&
        (!(["failed", "timed_out"].includes(failedRun.status) ||
            (input.taskRetryIntentId && failedRun.status === "cancelled")) ||
          !failedRun.finishedAt)) ||
      (!input.committedResponse && !input.taskRetryIntentId &&
        failedRun.runtimeMode !== "native" &&
        !(
          [
            "adapter_failed",
            "adapter_exit_code",
            "process_exit",
            "timeout",
          ].includes(failedRun.errorCode ?? "") ||
          (evidence.kind === "retry" && await isPreProviderChatFailure(tx, evidence.run))
        )) ||
      (!input.publication &&
        ["backlog", "done", "cancelled"].includes(issue.status))
    )
      throw failedChatRetryDenied();
    if (input.taskRetryIntentId && !await readTaskChatRetryIntent(tx as unknown as Db, {
      companyId: input.companyId, issueId: issue.id, agentId: input.agentId,
      sourceRunId: failedRun.id, intentId: input.taskRetryIntentId,
    })) throw failedChatRetryDenied();
    if (failedRun.runtimeMode === "native" && evidence.kind === "retry" && !input.taskRetryIntentId)
      await failedNativeRetryCoordinator(tx, evidence.run, issue.id);
    const context = failedRun.contextSnapshot ?? {};
    const selection = input.taskRetryInput && taskRetryInputSchema.safeParse(input.taskRetryInput);
    if (selection && !selection.success) throw failedChatRetryDenied();
    const selectedInput = selection?.success ? selection.data : undefined;
    if (input.taskRetryIntentId && !input.committedResponse && failedRun.status === "failed" &&
        failedRun.runtimeMode === "native" && failedRun.nativeIssueId === issue.id &&
        context.issueId === issue.id && context.source === "issue.tree_resume" &&
        !selectedInput?.sourceActionIds.length) {
      // An inherited requester is not permission to replay a recorded result.
      // Explain the existing refusal before raw chat-source validation hides
      // the supported new-message path. This branch grants no continuation.
      const [recorded] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
        eq(nativeRunResults.companyId, input.companyId), eq(nativeRunResults.issueId, issue.id),
        eq(nativeRunResults.runId, failedRun.id), eq(nativeRunResults.schemaStatus, "accepted"),
      )).limit(1).for("share", { noWait: true });
      if (recorded) throw failedChatRetryDenied("accepted_result_without_new_input");
    }
    const provider = CHAT_PROVIDERS.find(
      (value) => context.source === `chat:${value}`,
    );
    if (
      !provider ||
      context.issueId !== issue.id ||
      context.interactionId ||
      (context.taskKey !== issue.identifier && context.taskKey !== issue.id)
    )
      throw failedChatRetryDenied();
    if (selectedInput && (!input.taskRetryIntentId || provider !== "github")) throw failedChatRetryDenied();
    const reauthorization = input.taskRetryReauthorization ?? (selectedInput ? {
      intentId: input.taskRetryIntentId!, sourceRunId: failedRun.id, runtimeFence: selectedInput.runtimeFence,
    } : undefined);
    if (reauthorization && selectedInput?.skippedActionIds) reauthorization.skippedActionIds = selectedInput.skippedActionIds;
    const pendingSources = selectedInput?.sourceActionIds.length ? await tx.select().from(chatActions).where(and(
      eq(chatActions.companyId, input.companyId), eq(chatActions.kind, "inbound_wakeup"),
      sql`${chatActions.payload}->>'issueId' = ${issue.id}`,
      inArray(chatActions.id, selectedInput.sourceActionIds),
    )) : null;
    if (pendingSources && pendingSources.length !== selectedInput!.sourceActionIds.length) throw failedChatRetryDenied();
    const pendingById = new Map(pendingSources?.map(source => [source.id, source]));
    const commentIds = pendingSources ? selectedInput!.sourceActionIds.map(id =>
      String(pendingById.get(id)!.payload.commentId)) : retryCommentIds(context, selectedInput);
    const [accepted] = await tx
      .select()
      .from(nativeRunResults)
      .where(
        and(
          eq(nativeRunResults.companyId, input.companyId),
          eq(nativeRunResults.runId, failedRun.id),
          eq(nativeRunResults.schemaStatus, "accepted"),
          input.committedResponse
            ? eq(nativeRunResults.id, input.committedResponse.resultId)
            : undefined,
        ),
      )
      .limit(1)
      .for("share", { noWait: true });
    if (input.committedResponse) {
      const [coordinator] = await tx
        .select()
        .from(nativeRunFinalizations)
        .where(
          and(
            eq(nativeRunFinalizations.companyId, input.companyId),
            eq(nativeRunFinalizations.issueId, issue.id),
            eq(nativeRunFinalizations.runId, failedRun.id),
          ),
        )
        .for("share", { noWait: true });
      const result = accepted?.resultJson.result as
        | Record<string, unknown>
        | undefined;
      const terminal = accepted?.resultJson.terminal as
        | Record<string, unknown>
        | undefined;
      const continuation = result?.continuation as
        | Record<string, unknown>
        | undefined;
      if (
        failedRun.runtimeMode !== "native" ||
        failedRun.nativeIssueId !== issue.id ||
        !accepted ||
        accepted.id !== input.committedResponse.resultId ||
        accepted.issueId !== issue.id ||
        accepted.completionContractId !== failedRun.completionContractId ||
        coordinator?.phase !== "committed" ||
        coordinator.resultId !== accepted.id ||
        !coordinator.decisionId ||
        !coordinator.assessmentId ||
        (input.committedResponse.canonicalSha256 !== undefined &&
          input.committedResponse.canonicalSha256 !==
            accepted.canonicalSha256) ||
        (input.committedResponse.decisionId !== undefined &&
          input.committedResponse.decisionId !== coordinator.decisionId) ||
        result?.schema !== "paperclip.run_result.v1" ||
        result.reportedWorkDisposition !== "yielded" ||
        !Array.isArray(result.attentionRequests) ||
        result.attentionRequests.length !== 0 ||
        continuation?.kind !== "response_wake" ||
        terminal?.schema !== "paperclip.prp.terminal.v1" ||
        terminal.turnTerminalState !== "completed" ||
        terminal.runTerminalState !== "succeeded" ||
        terminal.reportedWorkDisposition !== "yielded"
      )
        throw failedChatRetryDenied();
    }
    let continuingUnknownPublicationId: string | undefined;
    const continuingTransfer =
      input.committedResponse?.continuingTeamsFileTransfer;
    if (continuingTransfer !== undefined) {
      continuingUnknownPublicationId = await continuingTeamsFilePublication(tx, {
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: issue.id,
        failedRunId: failedRun.id,
        provider,
        publication: input.publication,
        retryActionId: input.retryActionId,
        runId: input.runId,
        continuingTransfer,
      }, failedChatRetryDenied);
    }
    const [question] = await tx
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.sourceRunId, failedRun.id),
        ),
      )
      .limit(1);
    const [answerDelivery] = await tx
      .select({ id: issueQuestionResponseDeliveries.id })
      .from(issueQuestionResponseDeliveries)
      .where(
        and(
          eq(issueQuestionResponseDeliveries.companyId, input.companyId),
          eq(issueQuestionResponseDeliveries.targetRunId, failedRun.id),
        ),
      )
      .limit(1);
    const previousComments = new Set(pendingSources?.length ? retryCommentIds(context, selectedInput) : []);
    const independentFailedInput = input.taskRetryIntentId && pendingSources?.length &&
      pendingSources.every(action => action.payload.requestedByActorType === "user") &&
      commentIds.every(id => !previousComments.has(id)) && failedRun.status === "failed" &&
      (accepted?.resultJson.terminal as Record<string, unknown> | undefined)?.runTerminalState === "failed";
    const [resultPublication] = await tx
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, input.companyId),
          eq(chatPublications.issueId, issue.id),
          input.committedResponse
            ? eq(chatPublications.state, "delivery_unknown")
            : undefined,
          // A distinct admitted user request does not replay the failed
          // result's output. Preserve that terminal publication as history;
          // pending or uncertain delivery still owns its external effects.
          independentFailedInput ? ne(chatPublications.state, "failed") : undefined,
          continuingUnknownPublicationId
            ? ne(chatPublications.id, continuingUnknownPublicationId)
            : undefined,
          or(
            and(
              like(chatPublications.idempotencyKey, `run:${failedRun.id}:%`),
              eq(chatPublications.state, "delivery_unknown"),
            ),
            sql`exists (select 1 from issue_comments result_comment where result_comment.id = ${chatPublications.commentId}
          and result_comment.company_id = ${input.companyId}::uuid and result_comment.created_by_run_id = ${failedRun.id}::uuid
          )`,
          ),
        ),
      )
      .limit(1);
    if (!input.committedResponse && accepted && !independentFailedInput)
      throw failedChatRetryDenied(input.taskRetryIntentId ? "accepted_result_without_new_input" : undefined);
    if (resultPublication) throw failedChatRetryDenied(input.taskRetryIntentId ? "prior_result_publication" : undefined);
    if (question || answerDelivery) throw failedChatRetryDenied(input.taskRetryIntentId ? "prior_interaction" : undefined);
    if (context.chatFailedRunRetry && !pendingSources) {
      const hint = context.chatFailedRunRetry as Record<string, unknown>;
      const [priorIntent] = await tx
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.id, failedRun.wakeupRequestId),
            eq(chatActions.companyId, input.companyId),
          ),
        )
        .for("share", { noWait: true });
      const [priorReceipt] = await tx
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.id, failedRun.wakeupRequestId),
            eq(agentWakeupRequests.companyId, input.companyId),
          ),
        )
        .for("share", { noWait: true });
      if (
        !priorIntent ||
        priorIntent.kind !== "failed_run_retry" ||
        priorIntent.status !== "processed" ||
        !priorReceipt ||
        priorReceipt.runId !== failedRun.id ||
        !["failed", "completed"].includes(priorReceipt.status) ||
        typeof priorIntent.payload.failedRunId !== "string" ||
        !isUuidLike(priorIntent.payload.failedRunId) ||
        hint.version !== 1 ||
        hint.actionId !== priorIntent.id ||
        hint.failedRunId !== priorIntent.payload.failedRunId ||
        failedRun.retryOfRunId !== priorIntent.payload.failedRunId ||
        context.retryOfRunId !== failedRun.retryOfRunId
      )
        throw failedChatRetryDenied();
      const parent = await failedChatRetrySource(
        tx,
        {
          ...input,
          failedRunId: priorIntent.payload.failedRunId,
          committedResponse: undefined,
          taskRetryIntentId: typeof priorIntent.payload.taskRetryIntentId === "string"
            ? priorIntent.payload.taskRetryIntentId : undefined,
          taskRetryInput: priorIntent.payload.taskRetryInput as TaskRetryInput | undefined,
          retryActionId: priorIntent.id,
          taskRetryReauthorization: reauthorization,
        },
        ancestors,
      );
      if (
        priorIntent.payload.sourceScopeSha256 !== parent.sourceScopeSha256 ||
        priorIntent.endpointId !== parent.endpointId ||
        priorIntent.conversationId !== parent.conversationId ||
        priorIntent.principalId !== parent.principalId ||
        context.taskKey !== parent.taskKey ||
        provider !== parent.provider ||
        JSON.stringify(commentIds) !== JSON.stringify(parent.commentIds)
      )
        throw failedChatRetryDenied();
      assertFailedRetryReceipt(
        createDurableChatWakeupRequest({
          id: priorIntent.id,
          companyId: input.companyId,
          agentId: input.agentId,
          issueId: input.issueId,
          commentId: parent.commentIds.at(-1)!,
          requestedByActorType: parent.requestedByActorType,
          requestedByActorId: parent.requestedByActorId,
          requestedAt: priorIntent.createdAt,
          authorize: async () => {},
        }),
        priorReceipt,
      );
      const { sourceScopeSha256, ...parentScope } = parent;
      return hashFailedRetrySource({
        ...parentScope,
        failedRunId: failedRun.id,
        ...(selectedInput ? { taskRetryInput: { ...selectedInput, runtimeFence: reauthorization?.runtimeFence } } : {}),
        retryAncestors: [
          ...parent.retryAncestors,
          {
            actionId: priorIntent.id,
            failedRunId: parent.failedRunId,
            sourceScopeSha256,
          },
        ],
      });
    }
    // Include every receipt that fed this run, including a deferred owner's
    // coalesced children. A mutable latest-comment hint cannot drop a sibling.
    const admittedBatch =
      pendingSources ? [] : await tx.execute(sql`select source.id, source.payload->>'commentId' as comment_id
      from agent_wakeup_requests receipt join chat_actions source on source.id = receipt.id
      where receipt.company_id = ${input.companyId}::uuid and receipt.agent_id = ${input.agentId}::uuid
        and (receipt.run_id = ${failedRun.id}::uuid or receipt.id = ${failedRun.wakeupRequestId}::uuid
          or receipt.payload->>'coalescedIntoWakeupRequestId' = ${failedRun.wakeupRequestId})
        and source.company_id = ${input.companyId}::uuid and source.kind = 'inbound_wakeup'
        ${selectedInput ? sql`` : sql`limit 51`}`);
    if (
      !pendingSources && (admittedBatch.length !== commentIds.length ||
      admittedBatch.some(
        (entry) => !commentIds.includes(String(entry.comment_id)),
      ))
    )
      throw failedChatRetryDenied();
    const sources = pendingSources ?? await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, input.companyId),
          eq(chatActions.kind, "inbound_wakeup"),
          sql`${chatActions.payload}->>'issueId' = ${issue.id}`,
          inArray(
            sql<string>`${chatActions.payload}->>'commentId'`,
            commentIds,
          ),
        ),
      );
    if (sources.length !== commentIds.length) throw failedChatRetryDenied();
    const sourcesByCommentId = new Map(sources.map(source => [source.payload.commentId, source]));
    const ordered = commentIds.map(
      (id) => sourcesByCommentId.get(id)!,
    );
    const first = ordered[0]!;
    if (
      !first ||
      !first.principalId ||
      !first.conversationId ||
      sources.some(
        (action) =>
          action.endpointId !== first.endpointId ||
          action.conversationId !== first.conversationId ||
          action.principalId !== first.principalId ||
          action.payload.requestedByActorType !==
            first.payload.requestedByActorType ||
          action.payload.requestedByActorId !==
            first.payload.requestedByActorId,
      )
    )
      throw failedChatRetryDenied();
    const identity = await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`chat-identity:${input.companyId}:${first.principalId}`}, 0)) as locked`,
    );
    if (!identity[0]?.locked)
      throw new NativeChatReviewPresentationContentionError();
    const actionIds = ordered.map(action => action.id);
    const currentActions = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, input.companyId),
      inArray(chatActions.id, actionIds))).orderBy(asc(chatActions.id)).for("update", { noWait: true });
    const deliveries = await tx.select().from(chatDeliveries).where(and(eq(chatDeliveries.companyId, input.companyId),
      inArray(chatDeliveries.id, ordered.map(action => action.deliveryId!))))
      .orderBy(asc(chatDeliveries.id)).for("update", { noWait: true });
    const comments = await tx.select().from(issueComments).where(and(eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, issue.id), inArray(issueComments.id, commentIds)))
      .orderBy(asc(issueComments.id)).for("share", { noWait: true });
    const receipts = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId),
      inArray(agentWakeupRequests.id, [...actionIds, failedRun.wakeupRequestId!, ...(input.retryActionId ? [input.retryActionId] : [])])))
      .orderBy(asc(agentWakeupRequests.id)).for("share", { noWait: true });
    const actionsById = new Map(currentActions.map(action => [action.id, action]));
    const deliveriesById = new Map(deliveries.map(delivery => [delivery.id, delivery]));
    const commentsById = new Map(comments.map(comment => [comment.id, comment]));
    const receiptsById = new Map(receipts.map(receipt => [receipt.id, receipt]));
    const lifecycleRows = await tx.select({
      target: sql<string>`${chatDeliveries.normalizedEvent}->'message'->>'targetProviderEventId'`,
      context: sql<Record<string, unknown>>`${chatDeliveries.normalizedEvent}->'runtimeContext'`,
    }).from(chatDeliveries).where(and(eq(chatDeliveries.companyId, input.companyId),
      eq(chatDeliveries.endpointId, first.endpointId),
      or(isNull(chatDeliveries.conversationId), eq(chatDeliveries.conversationId, first.conversationId)),
      ne(chatDeliveries.state, "filtered"), inArray(chatDeliveries.eventKind, ["message_updated", "message_deleted", "message_restored"]),
      inArray(sql<string>`${chatDeliveries.normalizedEvent}->'message'->>'targetProviderEventId'`, deliveries.map(delivery => delivery.providerEventId))));
    const lifecycleKey = (target: string, context: Record<string, unknown> | null) =>
      JSON.stringify([target, Object.entries(context ?? {}).sort(([left], [right]) => left.localeCompare(right))]);
    const invalidated = new Set(lifecycleRows.map(row => lifecycleKey(row.target, row.context)));
    const batch = reauthorization ? await authorizeGitHubTaskRetryBatch(tx, ordered, {
      nonblocking: true, terminal: input.publication === true, taskRetry: reauthorization,
    }).catch(error => { if (isExternalActionAuthorizationChange(error)) throw failedChatRetryDenied(input.taskRetryIntentId ? "source_authorization" : undefined, safeChatWakeAuthorityReason(error)); throw error; }) : null;
    const canonicalSources: Array<Record<string, unknown>> = [];
    let destination: Awaited<ReturnType<typeof authorizeInboundWakeup>> | null =
      null;
    for (const action of ordered) {
      destination = batch?.get(action.id) ?? await authorizeInboundWakeup(tx, action, {
        nonblocking: true,
        terminal: input.publication === true,
        ...(reauthorization ? { taskRetry: reauthorization } : {}),
      }).catch((error) => {
        if (isExternalActionAuthorizationChange(error))
          throw failedChatRetryDenied(input.taskRetryIntentId ? "source_authorization" : undefined, safeChatWakeAuthorityReason(error));
        throw error;
      });
      if (reauthorization && !reauthorization.runtimeFence) reauthorization.runtimeFence = destination.retryRuntimeFence;
      const delivery = deliveriesById.get(action.deliveryId!);
      const current = actionsById.get(action.id);
      const comment = commentsById.get(String(action.payload.commentId));
      const receipt = receiptsById.get(action.id);
      const skippedInput = pendingSources && selectedInput?.skippedActionIds?.includes(action.id) &&
        receipt?.status === "skipped" && !receipt.runId &&
        ["budget.blocked", "agent.not_invokable"].includes(receipt.reason ?? "") &&
        action.payload.requestedByActorType === "user";
      if (
        !current ||
        (current.status !== "processed" && !(skippedInput && current.status === "failed")) ||
        inboundWakeScope(current) !== inboundWakeScope(action) ||
        !delivery ||
        delivery.state !== "processed" ||
        !comment ||
        comment.deletedAt ||
        comment.updatedAt.getTime() !== comment.createdAt.getTime() ||
        (!pendingSources && comment.updatedAt >
          (input.committedResponse
            ? accepted!.createdAt
            : failedRun.finishedAt!)) ||
        destination.endpoint.provider !== provider ||
        JSON.stringify(lifecycleRuntimeFence(delivery)) !==
          JSON.stringify(lifecycleRuntimeFence(destination.delivery))
      )
        throw failedChatRetryDenied();
      if (invalidated.has(lifecycleKey(delivery.providerEventId, lifecycleRuntimeFence(delivery)))) throw failedChatRetryDenied();
      if (!receipt) throw failedChatRetryDenied();
      assertFailedRetryReceipt(
        createDurableChatWakeupRequest({
          id: action.id,
          companyId: input.companyId,
          agentId: input.agentId,
          issueId: issue.id,
          commentId: comment.id,
          requestedByActorType: action.payload.requestedByActorType as
            | "user"
            | "system",
          requestedByActorId: String(action.payload.requestedByActorId),
          requestedAt: action.createdAt,
          authorize: async () => {},
        }),
        receipt,
      );
      if (pendingSources) {
        const direct = (receipt.status === "deferred_issue_execution" || skippedInput) && !receipt.runId
          && receipt.payload?.coalescedIntoWakeupRequestId === undefined;
        const owned = input.retryActionId && receipt.status === "coalesced"
          && receipt.payload?.coalescedIntoWakeupRequestId === input.retryActionId;
        if (!direct && !owned) throw failedChatRetryDenied();
        if (owned && receipt.runId) {
          const owner = receiptsById.get(input.retryActionId!);
          if (owner?.runId !== receipt.runId) throw failedChatRetryDenied();
        }
      }
      let owner = receipt;
      const seen = new Set<string>();
      for (
        let depth = 0;
        owner.payload?.coalescedIntoWakeupRequestId !== undefined;
        depth++
      ) {
        const ownerId = owner.payload.coalescedIntoWakeupRequestId;
        // The scheduler writes a direct child -> canonical owner edge. Nested
        // chains/cycles are not silently interpreted as additional authority.
        if (
          depth >= 1 ||
          owner.status !== "coalesced" ||
          typeof ownerId !== "string" ||
          !isUuidLike(ownerId) ||
          seen.has(ownerId)
        )
          throw failedChatRetryDenied();
        seen.add(ownerId);
        const next = receiptsById.get(ownerId);
        if (!next) throw failedChatRetryDenied();
        owner = next;
      }
      if (
        (!pendingSources && (owner.id !== failedRun.wakeupRequestId ||
        owner.runId !== failedRun.id ||
        owner.agentId !== input.agentId ||
        owner.requestedByActorType !== receipt.requestedByActorType ||
        owner.requestedByActorId !== receipt.requestedByActorId)) ||
        (!skippedInput && ["skipped", "cancelled"].includes(receipt.status))
      )
        throw failedChatRetryDenied();
      canonicalSources.push({
        actionId: action.id,
        deliveryId: delivery.id,
        commentId: comment.id,
        principalId: action.principalId,
        scope: inboundWakeScope(action),
        fence: lifecycleRuntimeFence(delivery),
        bodySha256: createHash("sha256").update(comment.body).digest("hex"),
        omissionReasons: action.payload.attachmentOmissionReasons ?? {},
        receiptId: receipt.id,
        ownerId: pendingSources ? action.id : owner.id,
      });
    }
    if (!destination) throw failedChatRetryDenied();
    const newestSource = ordered.reduce(
      (latest, action) =>
        action.createdAt > latest ? action.createdAt : latest,
      first.createdAt,
    );
    const [newer] = await tx
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, input.companyId),
          eq(chatActions.conversationId, first.conversationId),
          eq(chatActions.kind, "inbound_wakeup"),
          notInArray(
            chatActions.id,
            ordered.map((action) => action.id),
          ),
          gte(chatActions.createdAt, newestSource),
          sql`exists (select 1 from agent_wakeup_requests newer_admission where newer_admission.id = ${chatActions.id}
        and newer_admission.company_id = ${input.companyId}::uuid and newer_admission.status <> 'skipped')`,
        ),
      )
      .limit(1);
    if (newer && !input.publication) throw failedChatRetryDenied();
    const scope = {
      failedRunId: failedRun.id,
      sourceWakeupRequestId: failedRun.wakeupRequestId,
      issueId: issue.id,
      agentId: input.agentId,
      taskKey: context.taskKey as string,
      provider,
      commentIds,
      sources: canonicalSources,
      endpointId: first.endpointId,
      conversationId: first.conversationId,
      principalId: first.principalId,
      sessionGeneration: destination.conversation.sessionGeneration,
      requestedByActorType: first.payload.requestedByActorType as
        | "user"
        | "system",
      requestedByActorId: String(first.payload.requestedByActorId),
      retryAncestors: [],
      ...(selectedInput ? { taskRetryInput: { ...selectedInput,
        runtimeFence: selectedInput.runtimeFence ?? destination.retryRuntimeFence } } : {}),
    };
    return hashFailedRetrySource(scope);
  }

  const unregisterCommittedResponseAuthority =
    registerCommittedChatResponseAuthority(db, async (tx, input) => {
      try {
        await failedChatRetrySource(tx, {
          ...input,
          failedRunId: input.runId,
          publication: true,
          committedResponse: { resultId: input.resultId },
        });
      } catch (error) {
        if (
          error instanceof HttpError &&
          (error.details as { code?: string } | undefined)?.code ===
            "chat_failed_run_retry_not_authorized"
        ) {
          throw new CommittedChatResponseAuthorizationError();
        }
        throw error;
      }
    });

  /** A historical queue merge can consume independent board input before chat
   * dispatch rejects the changed batch. A new board Retry may restore those
   * never-delivered receipts, after certifying both their original authorities.
   * The failed run and its canonical Retry remain unchanged history. */
  async function restoreUnstartedRetryInput(tx: DbOrTransaction, input: {
    companyId: string; issueId: string; agentId: string; failedRunId: string; initiatedByUserId: string;
  }) {
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.id, input.failedRunId),
    )).for("share", { noWait: true });
    const queueIds = run?.contextSnapshot?.queuedCommentSourceWakeIds;
    if (run?.errorCode !== "chat_failed_run_retry_not_authorized" || !Array.isArray(queueIds) || !queueIds.length) return;
    if (queueIds.length > 50 || queueIds.some(id => typeof id !== "string" || !isUuidLike(id)) ||
        new Set(queueIds).size !== queueIds.length || !await isPreProviderChatFailure(tx, run)) throw failedChatRetryDenied();
    const source = await authorizeFailedChatRunRetry(tx, { ...input, retryActionId: run.wakeupRequestId!, runId: run.id });
    const sourceIds = source.taskRetryInput?.sourceActionIds;
    if (source.provider !== "github" || !sourceIds?.length || !source.intent.payload.taskRetryIntentId)
      throw failedChatRetryDenied();
    const queues = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      inArray(agentWakeupRequests.id, queueIds as string[]),
    )).for("update");
    const byId = new Map(queues.map(queue => [queue.id, queue]));
    if (queues.length !== queueIds.length) throw failedChatRetryDenied();
    const boardIds = (queueIds as string[]).flatMap(id => {
      const queue = byId.get(id)!;
      const ids = queuedCommentIdsFromWakePayload(queue.payload);
      if (queue.status !== "coalesced" || queue.runId !== run.id || queue.payload?.issueId !== input.issueId ||
          queue.requestedByActorType !== "user" || !queue.requestedByActorId ||
          !["issue_commented", "issue_reopened_via_comment"].includes(queue.reason ?? "") ||
          queue.idempotencyKey?.startsWith("chat-inbound:") || queue.payload?.queuedCommentInterrupt ||
          queue.payload?.coalescedIntoWakeupRequestId || !ids.length || ids.some(id => !isUuidLike(id)))
        throw failedChatRetryDenied();
      return ids;
    });
    if (new Set(boardIds).size !== boardIds.length || boardIds.some(id => source.commentIds.includes(id)) ||
        JSON.stringify(run.contextSnapshot?.wakeCommentIds) !== JSON.stringify([...boardIds, ...source.commentIds]) ||
        run.contextSnapshot?.wakeCommentId !== source.commentIds.at(-1)) throw failedChatRetryDenied();
    const comments = await tx.select().from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      inArray(issueComments.id, boardIds),
    )).for("share", { noWait: true });
    const commentsById = new Map(comments.map(comment => [comment.id, comment]));
    for (const queue of queues) for (const id of queuedCommentIdsFromWakePayload(queue.payload)) {
      const comment = commentsById.get(id);
      if (!comment || comment.authorType !== "user" || comment.authorUserId !== queue.requestedByActorId ||
          comment.createdByRunId || comment.deletedAt || !comment.body.trim() ||
          comment.updatedAt.getTime() !== comment.createdAt.getTime()) throw failedChatRetryDenied();
    }
    const [delivered] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), ne(heartbeatRuns.id, run.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
      sql`not (${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.startedAt} is null)`,
      // Budget-skipped source receipts remain immutable even after a later
      // Retry delivers them. Check run history for both input authorities.
      or(...[...boardIds, ...source.commentIds].map(id => or(sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${id}`,
        sql`${heartbeatRuns.contextSnapshot}->'wakeCommentIds' @> ${JSON.stringify([id])}::jsonb`))),
    )).limit(1);
    if (delivered) throw failedChatRetryDenied();
    // Source authorization above checked every external receipt and its owner.
    // Reset only this certified unstarted batch under the task's admission lock.
    const skippedIds = source.taskRetryInput?.skippedActionIds ?? [];
    await tx.update(agentWakeupRequests).set({ status: "deferred_issue_execution", runId: null, finishedAt: null,
      payload: sql`${agentWakeupRequests.payload} - 'coalescedIntoWakeupRequestId'`, updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      inArray(agentWakeupRequests.id, [...sourceIds, ...queueIds as string[]]),
      ne(agentWakeupRequests.status, "skipped")));
    await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.initiatedByUserId,
      action: "issue.retry_inputs_restored", entityType: "issue", entityId: input.issueId, runId: run.id,
      details: { sourceRetryActionId: source.intent.id, externalRequestIds: sourceIds, boardRequestIds: queueIds } });
    // The old skipped receipts stay unchanged. The certified failed attempt
    // proves this batch was never delivered even though it predates that run.
    return { sourceActionIds: sourceIds, skippedActionIds: skippedIds } satisfies TaskRetryInput;
  }

  async function prepareFailedChatRunRetry(
    tx: DbOrTransaction,
    input: {
      companyId: string;
      issueId: string;
      agentId: string;
      failedRunId: string;
      initiatedByUserId: string;
      retryIntentId?: string;
    },
  ): Promise<{ actionId: string; issueId: string }> {
    let taskRetryInput = input.retryIntentId ? await selectTaskRetryInput(tx, input) : undefined;
    if (input.retryIntentId && taskRetryInput && !taskRetryInput.sourceActionIds.length)
      taskRetryInput = await restoreUnstartedRetryInput(tx, input) ?? taskRetryInput;
    const source = await failedChatRetrySource(tx, { ...input, taskRetryIntentId: input.retryIntentId, taskRetryInput });
    const providerActionId = input.retryIntentId
      ? `task-retry:${input.retryIntentId}` : `failed-run-retry:${source.failedRunId}`;
    const [existing] = await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, source.endpointId),
          eq(chatActions.providerActionId, providerActionId),
        ),
      )
      .for("update", { noWait: true });
    if (existing) {
      if (
        existing.kind !== "failed_run_retry" ||
        existing.companyId !== input.companyId ||
        existing.payload.sourceScopeSha256 !== source.sourceScopeSha256
      )
        throw failedChatRetryDenied();
      return { actionId: existing.id, issueId: input.issueId };
    }
    if (!input.retryIntentId) await assertFailedNativeRetryState(tx, source, input.companyId);
    const [busy] = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          inArray(heartbeatRuns.status, [
            "queued",
            "running",
            "scheduled_retry",
          ]),
          sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${input.issueId}`,
        ),
      )
      .limit(1);
    if (busy || !input.initiatedByUserId) throw failedChatRetryDenied();
    const now = new Date();
    await notifyChatActionWork(tx, "failed_run_retry");
    const [intent] = await tx
      .insert(chatActions)
      .values({
        companyId: input.companyId,
        endpointId: source.endpointId,
        conversationId: source.conversationId,
        principalId: source.principalId,
        kind: "failed_run_retry",
        providerActionId,
        payload: {
          version: 1,
          ...source,
          initiatedByUserId: input.initiatedByUserId,
          ...(input.retryIntentId ? { taskRetryIntentId: input.retryIntentId } : {}),
        },
        status: "issued",
        result: { code: "failed_chat_retry_queued", attemptCount: 0 },
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await logActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.initiatedByUserId,
      action: "chat.failed_run_retry_requested",
      entityType: "heartbeat_run",
      entityId: input.failedRunId,
      details: {
        retryActionId: intent.id,
        issueId: input.issueId,
        commentCount: source.commentIds.length,
      },
    });
    return { actionId: intent.id, issueId: input.issueId };
  }

  async function authorizeFailedChatRunRetry(
    tx: DbOrTransaction,
    input: {
      companyId: string;
      issueId: string;
      agentId: string;
      retryActionId: string;
      runId?: string;
      publication?: boolean;
    },
  ) {
    const [snapshot] = await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, input.retryActionId),
          eq(chatActions.companyId, input.companyId),
        ),
      );
    if (
      !snapshot ||
      snapshot.kind !== "failed_run_retry" ||
      typeof snapshot.payload.failedRunId !== "string" ||
      snapshot.payload.issueId !== input.issueId ||
      snapshot.payload.agentId !== input.agentId
    )
      throw failedChatRetryDenied();
    const source = await failedChatRetrySource(tx, {
      ...input,
      failedRunId: snapshot.payload.failedRunId,
      taskRetryIntentId: typeof snapshot.payload.taskRetryIntentId === "string"
        ? snapshot.payload.taskRetryIntentId : undefined,
      taskRetryInput: snapshot.payload.taskRetryInput as TaskRetryInput | undefined,
    });
    if (typeof snapshot.payload.taskRetryIntentId === "string" && !await readTaskChatRetryIntent(tx as unknown as Db, {
      companyId: input.companyId, issueId: input.issueId, agentId: input.agentId,
      sourceRunId: source.failedRunId, intentId: snapshot.payload.taskRetryIntentId, chatActionId: snapshot.id,
    })) throw failedChatRetryDenied();
    const [intent] = await tx
      .select()
      .from(chatActions)
      .where(eq(chatActions.id, snapshot.id))
      .for("update", { noWait: true });
    if (
      !intent ||
      !(
        input.publication
          ? ["issued", "processing", "processed", "failed", "cancelled"]
          : ["issued", "processing", "processed"]
      ).includes(intent.status) ||
      intent.payload.version !== 1 ||
      intent.endpointId !== source.endpointId ||
      intent.conversationId !== source.conversationId ||
      intent.principalId !== source.principalId ||
      intent.payload.sourceScopeSha256 !== source.sourceScopeSha256 ||
      JSON.stringify(intent.payload) !== JSON.stringify(snapshot.payload)
    )
      throw failedChatRetryDenied();
    const [receipt] = await tx
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, intent.id))
      .for("share", { noWait: true });
    if (receipt) {
      assertFailedRetryReceipt(
        createDurableChatWakeupRequest({
          id: intent.id,
          companyId: input.companyId,
          agentId: input.agentId,
          issueId: input.issueId,
          commentId: source.commentIds.at(-1)!,
          requestedByActorType: source.requestedByActorType,
          requestedByActorId: source.requestedByActorId,
          requestedAt: intent.createdAt,
          authorize: async () => {},
        }),
        receipt,
      );
      if (
        (!input.publication &&
          ["skipped", "cancelled"].includes(receipt.status)) ||
        (input.runId && receipt.runId !== input.runId)
      )
        throw failedChatRetryDenied();
    } else if (input.runId) throw failedChatRetryDenied();
    if (input.runId) {
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, input.runId),
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.agentId, input.agentId),
          ),
        )
        .for("share", { noWait: true });
      if (
        !run ||
        run.wakeupRequestId !== intent.id ||
        run.retryOfRunId !== source.failedRunId
      )
        throw failedChatRetryDenied();
    }
    return { ...source, intent };
  }

  const unregisterFailedRetryAuthority = registerFailedChatRunRetryAuthority(
    db,
    async (tx, input) => {
      const source = await authorizeFailedChatRunRetry(tx, {
        ...input,
        retryActionId: input.wakeupRequestId,
      });
      await assertFailedNativeRetryState(tx, source, input.companyId,
        typeof source.intent.payload.taskRetryIntentId === "string" ? source.intent.payload.taskRetryIntentId : undefined,
        input.phase === "admission", input.phase === "execution" ? input.runId : undefined);
      const context = input.contextSnapshot;
      const hint = context.chatFailedRunRetry as
        | Record<string, unknown>
        | undefined;
      if (
        context.issueId !== source.issueId ||
        context.source !== `chat:${source.provider}` ||
        context.taskKey !== source.taskKey ||
        context.retryOfRunId !== source.failedRunId ||
        JSON.stringify(retryCommentIds(context, source.taskRetryInput)) !==
          JSON.stringify(source.commentIds) ||
        hint?.version !== 1 ||
        hint.actionId !== source.intent.id ||
        hint.failedRunId !== source.failedRunId ||
        (typeof source.intent.payload.taskRetryIntentId === "string" &&
          (context.taskRetryRequestId !== source.intent.payload.taskRetryIntentId || context.forceFreshSession !== true)) ||
        !Array.isArray(context.externalAttachmentOmissions) ||
        JSON.stringify(
          context.externalAttachmentOmissions.map((entry) =>
            entry && typeof entry === "object"
              ? [entry.commentId, entry.reasons]
              : null,
          ),
        ) !==
          JSON.stringify(
            source.sources.map((entry) => [
              entry.commentId,
              entry.omissionReasons,
            ]),
          )
      )
        throw failedChatRetryDenied();
    },
  );

  async function failedChatRetryReceipt(
    action: typeof chatActions.$inferSelect,
  ) {
    const [receipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.id, action.id),
          eq(agentWakeupRequests.companyId, action.companyId),
        ),
      );
    const [run] = receipt?.runId
      ? await db
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, receipt.runId),
              eq(heartbeatRuns.companyId, action.companyId),
            ),
          )
      : [];
    const status = ["succeeded", "failed", "cancelled"].includes(
      run?.status ?? "",
    )
      ? (run!.status as "succeeded" | "failed" | "cancelled")
      : run?.status === "timed_out"
        ? "failed"
        : run?.status === "running"
          ? "running"
          : receipt?.status === "deferred_issue_execution"
            ? "deferred"
            : ["failed", "cancelled"].includes(action.status)
              ? (action.status as "failed" | "cancelled")
              : ["skipped", "failed", "cancelled"].includes(
                    receipt?.status ?? "",
                  )
                ? "failed"
                : "queued";
    return {
      actionId: action.id,
      issueId: String(action.payload.issueId),
      runId: run?.id ?? null,
      status,
    };
  }

  async function reconcileFailedTaskRetry(action: typeof chatActions.$inferSelect) {
    if (!["failed", "cancelled"].includes(action.status) || !action.payload.taskRetryIntentId ||
        action.result?.taskRetryInputReconciled === true) return action;
    await releaseUnadmittedTaskRetryInput(db, { companyId: action.companyId, retryActionId: action.id });
    const [settled] = await db.update(chatActions).set({
      result: sql`coalesce(${chatActions.result}, '{}'::jsonb) || '{"taskRetryInputReconciled":true}'::jsonb`,
    }).where(and(eq(chatActions.companyId, action.companyId), eq(chatActions.id, action.id),
      inArray(chatActions.status, ["failed", "cancelled"]))).returning();
    return settled ?? action;
  }

  async function claimFailedChatRunRetry(actionId: string) {
    const [snapshot] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "failed_run_retry"),
        ),
      );
    if (!snapshot) throw notFound("Chat retry request not found");
    // Reconcile once at settlement; a crash before the marker is safely
    // retried here. Status projection itself performs no writes or row locks.
    const candidate = await reconcileFailedTaskRetry(snapshot);
    const now = new Date();
    if (
      isShuttingDown() ||
      !["issued", "processing"].includes(candidate.status) ||
      (candidate.status === "processing" &&
        candidate.updatedAt.getTime() >
          now.getTime() - FAILED_RUN_RETRY_STALE_MS) ||
      (typeof candidate.result?.retryAt === "string" &&
        Date.parse(candidate.result.retryAt) > now.getTime())
    )
      return failedChatRetryReceipt(candidate);
    const [claimed] = await db.transaction(async (tx) => {
      await notifyChatActionWork(tx, "failed_run_retry");
      return tx
        .update(chatActions)
        .set({ status: "processing", updatedAt: now })
        .where(
          and(
            eq(chatActions.id, candidate.id),
            eq(chatActions.status, candidate.status),
            eq(chatActions.updatedAt, candidate.updatedAt),
          ),
        )
        .returning();
    });
    if (!claimed) return failedChatRetryReceipt(candidate);
    const attemptCount = Number(candidate.result?.attemptCount ?? 0) + 1;
    const settle = async (status: string, result: Record<string, unknown>) => {
      const [current] = await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "failed_run_retry");
        return tx
          .update(chatActions)
          .set({ status, result, updatedAt: new Date() })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
              eq(chatActions.updatedAt, now),
            ),
          )
          .returning();
      });
      return failedChatRetryReceipt(await reconcileFailedTaskRetry(current ?? claimed));
    };
    try {
      const scope = {
        companyId: claimed.companyId,
        issueId: String(claimed.payload.issueId),
        agentId: String(claimed.payload.agentId),
        retryActionId: claimed.id,
      };
      const source = await db.transaction((tx) =>
        authorizeFailedChatRunRetry(tx, scope),
      );
      const existing = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, claimed.id));
      const resumeTaskRetry = typeof claimed.payload.taskRetryIntentId === "string" &&
        existing[0]?.status === "deferred_issue_execution" && !existing[0].runId &&
        existing[0].payload?.taskRetryRequestId === claimed.payload.taskRetryIntentId;
      if (!existing.length || resumeTaskRetry) {
        const context = {
          issueId: source.issueId,
          ...(typeof claimed.payload.taskRetryIntentId === "string" ? {
            taskRetryRequestId: claimed.payload.taskRetryIntentId, forceFreshSession: true,
            previousRunId: source.failedRunId,
          } : {}),
          taskKey: source.taskKey,
          source: `chat:${source.provider}`,
          [CHAT_CONVERSATION_ID_KEY]: source.conversationId,
          wakeCommentId: source.commentIds.at(-1)!,
          wakeCommentIds: source.commentIds,
          retryOfRunId: source.failedRunId,
          chatFailedRunRetry: {
            version: 1,
            actionId: claimed.id,
            failedRunId: source.failedRunId,
          },
          externalAttachmentOmissions: source.sources.map((entry) => ({
            commentId: entry.commentId,
            reasons: entry.omissionReasons,
          })),
        };
        await wakeup(source.agentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "retry_failed_run",
          payload: context,
          contextSnapshot: context,
          allowRunCoalescing: false,
          ...(typeof claimed.payload.taskRetryIntentId === "string"
            ? { taskRetryRequestId: claimed.payload.taskRetryIntentId } : {}),
          requestedByActorType: source.requestedByActorType,
          requestedByActorId: source.requestedByActorId,
          durableChatRequest: createDurableChatWakeupRequest({
            id: claimed.id,
            companyId: claimed.companyId,
            agentId: source.agentId,
            issueId: source.issueId,
            commentId: source.commentIds.at(-1)!,
            requestedByActorType: source.requestedByActorType,
            requestedByActorId: source.requestedByActorId,
            requestedAt: claimed.createdAt,
            failedRunRetry: { failedRunId: source.failedRunId },
            authorize: async (tx) => {
              const current = await authorizeFailedChatRunRetry(tx, scope);
              await assertFailedNativeRetryState(
                tx,
                current,
                claimed.companyId,
                typeof claimed.payload.taskRetryIntentId === "string" ? claimed.payload.taskRetryIntentId : undefined,
                true, // The durable wake callback validates admission; later phases recheck containment.
              );
            },
            onAdmitted: async (tx, receipt) => {
              if (!source.taskRetryInput) return;
              await claimTaskRetryInput(tx, { companyId: claimed.companyId,
                retryActionId: claimed.id, sourceActionIds: source.taskRetryInput.sourceActionIds });
              await settleTaskRetryInput(tx, { companyId: claimed.companyId, retryActionId: claimed.id, runId: receipt.runId });
            },
          }),
        });
      }
      const [receipt] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, claimed.id));
      if (!receipt) throw new Error("chat_retry_receipt_not_committed");
      await settleTaskRetryInput(db, { companyId: claimed.companyId, retryActionId: claimed.id, runId: receipt.runId });
      return settle(
        ["skipped", "failed", "cancelled"].includes(receipt.status)
          ? "failed"
          : "processed",
        { code: "failed_chat_retry_durable", attemptCount },
      );
    } catch (error) {
      const [receipt] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, claimed.id));
      const denied =
        error &&
        typeof error === "object" &&
        "details" in error &&
        error.details &&
        typeof error.details === "object" &&
        "code" in error.details &&
        [
          "chat_failed_run_retry_not_authorized",
          "chat_action_authorization_changed",
        ].includes(String(error.details.code));
      if (receipt) {
        if (denied && typeof claimed.payload.taskRetryIntentId === "string" &&
            receipt.status === "deferred_issue_execution" && !receipt.runId &&
            receipt.payload?.taskRetryRequestId === claimed.payload.taskRetryIntentId) {
          // Receipt existence proves the earlier wait, not current authority.
          // Retire only this unadmitted wake; an admitted run keeps its history.
          await db.update(agentWakeupRequests).set({
            status: "failed", error: "chat_failed_run_retry_not_authorized",
            finishedAt: new Date(), updatedAt: new Date(),
          }).where(and(eq(agentWakeupRequests.id, receipt.id),
            eq(agentWakeupRequests.companyId, claimed.companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId)));
          return settle("failed", { code: "failed_chat_retry_not_authorized", attemptCount });
        }
        return settle(["skipped", "failed", "cancelled"].includes(receipt.status) ? "failed" : "processed", {
          code: "failed_chat_retry_durable", attemptCount,
        });
      }
      const retryable = !denied && attemptCount < 8;
      return settle(retryable ? "issued" : "failed", {
        code: retryable
          ? "failed_chat_retry_contended"
          : "failed_chat_retry_not_authorized",
        attemptCount,
        ...(retryable
          ? {
              retryAt: new Date(
                Date.now() + Math.min(5_000, attemptCount * 250),
              ).toISOString(),
            }
          : {}),
      });
    }
  }

  const failedRetryTasks = new Map<
    string,
    ReturnType<typeof claimFailedChatRunRetry>
  >();
  function processFailedChatRunRetry(actionId: string) {
    const existing = failedRetryTasks.get(actionId);
    if (existing) return existing;
    const task = claimFailedChatRunRetry(actionId);
    failedRetryTasks.set(actionId, task);
    void task.then(
      () => failedRetryTasks.delete(actionId),
      () => failedRetryTasks.delete(actionId),
    );
    return task;
  }

  async function processFailedChatRunRetries(limit = 20) {
    if (isShuttingDown()) return 0;
    const candidates = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(dueChatAction("failed_run_retry"))
      .orderBy(asc(chatActions.createdAt), asc(chatActions.id))
      .limit(Math.max(1, Math.min(50, limit)));
    for (const candidate of candidates)
      await processFailedChatRunRetry(candidate.id);
    return candidates.length;
  }

  let failedRetryNoticeCursor: { createdAt: Date; id: string } | null = null;
  async function enqueueFailedChatRetryPublications(
    limit: number,
  ): Promise<number> {
    const cursor = failedRetryNoticeCursor;
    const batchSize = Math.max(1, Math.min(50, limit));
    const candidates = await db
      .select({ action: chatActions, receipt: agentWakeupRequests })
      .from(chatActions)
      .innerJoin(
        agentWakeupRequests,
        and(
          eq(agentWakeupRequests.id, chatActions.id),
          eq(agentWakeupRequests.companyId, chatActions.companyId),
        ),
      )
      .where(
        and(
          eq(chatActions.kind, "failed_run_retry"),
          isNull(agentWakeupRequests.runId),
          cursor
            ? sql`(${chatActions.createdAt}, ${chatActions.id}) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
          inArray(agentWakeupRequests.status, [
            "deferred_issue_execution",
            "cancelled",
            "failed",
            "skipped",
          ]),
          sql`not exists (select 1 from chat_publications retry_notice where retry_notice.company_id = ${chatActions.companyId}
          and retry_notice.idempotency_key = 'wake:' || ${chatActions.id}::text || ':' ||
          case when ${agentWakeupRequests.status} = 'deferred_issue_execution' then 'queued' else 'not_started' end || ':' ||
          ${chatActions.endpointId}::text || ':' || ${chatActions.conversationId}::text)`,
        ),
      )
      .orderBy(asc(chatActions.createdAt), asc(chatActions.id))
      .limit(batchSize);
    const last = candidates.at(-1)?.action;
    failedRetryNoticeCursor =
      candidates.length >= batchSize && last
        ? { createdAt: last.createdAt, id: last.id }
        : null;
    let inserted = 0;
    for (const { action, receipt } of candidates) {
      try {
        inserted += await db.transaction(async (tx) => {
          const source = await authorizeFailedChatRunRetry(tx, {
            companyId: action.companyId,
            issueId: String(action.payload.issueId),
            agentId: String(action.payload.agentId),
            retryActionId: action.id,
            publication: true,
          });
          const [current] = await tx
            .select()
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, receipt.id))
            .for("update", { noWait: true });
          if (!current || current.runId || current.status !== receipt.status)
            return 0;
          const state =
            current.status === "deferred_issue_execution"
              ? "queued"
              : "not_started";
          await notifyChatPublicationWork(tx);
          return (
            await tx
              .insert(chatPublications)
              .values({
                companyId: action.companyId,
                endpointId: source.endpointId,
                conversationId: source.conversationId,
                issueId: source.issueId,
                commentId: source.commentIds.at(-1)!,
                idempotencyKey: inboundWakePublicationKey(
                  action.id,
                  state,
                  source.endpointId,
                  source.conversationId,
                ),
                payload: projectSafeChatPublication({
                  classification: "external",
                  source: "safe_milestone",
                  text:
                    state === "queued"
                      ? "Your retry is queued."
                      : "This retry was not started. Open the task in Paperclip for details.",
                  progressState: state === "queued" ? "queued" : "failed",
                }),
                state: "pending",
              })
              .onConflictDoNothing()
              .returning({ id: chatPublications.id })
          ).length;
        });
      } catch (error) {
        if (
          isExternalChatWaitAuthorizationContention(error) ||
          error instanceof NativeChatReviewPresentationContentionError ||
          isExternalActionAuthorizationChange(error) ||
          (error &&
            typeof error === "object" &&
            "status" in error &&
            error.status === 409)
        )
          continue;
        throw error;
      }
    }
    return inserted;
  }

  return {
    retryCommentIds,
    assertFailedRetryReceipt,
    FailedChatRetryPublicationReadError,
    failedChatRetrySource,
    unregisterCommittedResponseAuthority,
    prepareFailedChatRunRetry,
    authorizeFailedChatRunRetry,
    unregisterFailedRetryAuthority,
    processFailedChatRunRetry,
    processFailedChatRunRetries,
    enqueueFailedChatRetryPublications,
    pendingFailedRetries: () => [...failedRetryTasks.values()],
  };
}
