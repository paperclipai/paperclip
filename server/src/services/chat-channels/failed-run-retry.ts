import { notifyChatPublicationWork } from "../chat-work-notifications.js";

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
  lte,
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
  assets,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatPublications,
  chatTeamsFileTransfers,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeRunFinalizations,
  nativeRunResults,
  environmentLeases,
  issueComments,
  issueAttachments,
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
} from "../activity-log.js";
import {
  type IssueAssignmentWakeupDeps,
} from "../issue-assignment-wakeup.js";

import {
  NativeChatReviewPresentationContentionError,
} from "../native-runtime/native-chat-review-presentation.js";
import { isExternalChatWaitAuthorizationContention } from "../native-runtime/chat-attachment-reuse.js";
import { projectSafeChatPublication } from "../chat-publication-projection.js";

import {
  inboundWakePublicationKey,
} from "../chat-inbound-wakeup-publications.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type DeliveryRow = typeof chatDeliveries.$inferSelect;
type RetryRuntimeFence = { credentialFingerprint: string; generation: number };
export type ChatFailedRetrySource = Awaited<ReturnType<ReturnType<typeof createChatFailedRunRetry>["failedChatRetrySource"]>>;

type ChatFailedRunRetryOptions = {
  authorizeInboundWakeup: (
    database: DbOrTransaction,
    action: typeof chatActions.$inferSelect,
    notice?: { nonblocking: true; terminal: boolean },
  ) => Promise<{
    conversation: Pick<typeof chatConversations.$inferSelect, "sessionGeneration">;
    endpoint: Pick<typeof chatEndpoints.$inferSelect, "provider">;
    delivery: DeliveryRow;
  }>;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  inboundWakeScope: (action: typeof chatActions.$inferSelect) => string;
  lifecycleRuntimeFence: (delivery: DeliveryRow) => RetryRuntimeFence | null;
  isShuttingDown: () => boolean;
  wakeup: IssueAssignmentWakeupDeps["wakeup"];
  staleProcessingMs: number;
};

export function createChatFailedRunRetry(db: Db, options: ChatFailedRunRetryOptions) {
  const {
    authorizeInboundWakeup,
    isExternalActionAuthorizationChange,
    inboundWakeScope,
    lifecycleRuntimeFence,
    isShuttingDown,
    wakeup,
    staleProcessingMs: DELIVERY_PROCESSING_STALE_MS,
  } = options;


  const failedChatRetryDenied = () =>
    conflict(
      "The exact failed chat request can no longer be retried safely. Check its current connection, access, and recovery state.",
      { code: "chat_failed_run_retry_not_authorized" },
    );
  class FailedChatRetryPublicationReadError extends Error {
    constructor() {
      super("Chat retry publication authorization is temporarily unavailable");
    }
  }

  function retryCommentIds(context: Record<string, unknown>): string[] {
    const ids =
      context.wakeCommentIds ??
      (context.wakeCommentId ? [context.wakeCommentId] : []);
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 50 ||
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

  /** The reviewed-chat ownership check runs before runtime/profile resolution
   * or provider startup. Recognize only that exact persisted failure together
   * with its sole system diagnostic and absence of execution evidence. A
   * generic setup error (or a prior-session display hint) is not this proof. */
  async function isPreProviderReviewedChatFailure(
    tx: DbOrTransaction,
    run: typeof heartbeatRuns.$inferSelect,
  ): Promise<boolean> {
    const diagnostic = "reviewed_chat_execution_binding_not_authorized";
    if (
      run.runtimeMode !== "legacy" ||
      run.errorCode !== "setup_failed" ||
      run.error !== diagnostic ||
      [
        run.runtimeModeResolverVersion,
        run.runtimeModeReason,
        run.runtimeModeResolvedAt,
        run.runnerProfileJson,
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
        run.usageJson,
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
      .limit(2)
      .for("share", { noWait: true });
    const event = events[0];
    if (
      events.length !== 1 ||
      !event ||
      event.agentId !== run.agentId ||
      event.seq !== 1 ||
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
    source: Pick<FailedChatRetrySource, "failedRunId" | "issueId" | "agentId">,
    companyId: string,
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
      /** Internal selector for already committed output, never retry admission. */
      committedResponse?: {
        resultId: string;
        canonicalSha256?: string;
        decisionId?: string;
        /** Internal source-proof continuation for one locked Teams transfer.
         * Never permission to repeat its card/PUT or retry a model run. */
        continuingTeamsFileTransfer?: {
          transferId: string;
          publicationId: string;
          version: number;
          phase: "consent_unknown" | "file_info_unknown";
        };
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
    const [failedRun] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.failedRunId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
        ),
      )
      .for("share", { noWait: true });
    if (
      !issue ||
      issue.assigneeAgentId !== input.agentId ||
      !actor ||
      !isAgentStatusInvokable(actor.status) ||
      !failedRun ||
      !failedRun.wakeupRequestId ||
      (!input.committedResponse &&
        (!["failed", "timed_out"].includes(failedRun.status) ||
          !failedRun.finishedAt)) ||
      (!input.committedResponse &&
        failedRun.runtimeMode !== "native" &&
        !(
          [
            "adapter_failed",
            "adapter_exit_code",
            "process_exit",
            "timeout",
          ].includes(failedRun.errorCode ?? "") ||
          (await isPreProviderReviewedChatFailure(tx, failedRun))
        )) ||
      (!input.publication &&
        ["backlog", "done", "cancelled"].includes(issue.status))
    )
      throw failedChatRetryDenied();
    if (failedRun.runtimeMode === "native" && !input.committedResponse)
      await failedNativeRetryCoordinator(tx, failedRun, issue.id);
    const context = failedRun.contextSnapshot ?? {};
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
    const commentIds = retryCommentIds(context);
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
      if (
        input.publication !== true ||
        input.retryActionId !== undefined ||
        input.runId !== undefined ||
        provider !== "microsoft-teams" ||
        !continuingTransfer ||
        !isUuidLike(continuingTransfer.transferId) ||
        !isUuidLike(continuingTransfer.publicationId) ||
        !Number.isSafeInteger(continuingTransfer.version) ||
        continuingTransfer.version < 1 ||
        !["consent_unknown", "file_info_unknown"].includes(
          continuingTransfer.phase,
        )
      )
        throw failedChatRetryDenied();
      // The caller supplies a selector only. Independently prove the exact
      // unknown publication is this native run's own selected file, not a
      // sibling effect or another actor/generation. All ordinary source and
      // committed-result authorization below still runs unchanged.
      const [continuing] = await tx
        .select({
          publicationId: chatPublications.id,
          attemptId: chatTeamsFileTransfers.attemptId,
          attemptExpiresAt: chatTeamsFileTransfers.attemptExpiresAt,
        })
        .from(chatTeamsFileTransfers)
        .innerJoin(
          chatPublications,
          and(
            eq(chatPublications.id, chatTeamsFileTransfers.publicationId),
            eq(chatPublications.companyId, chatTeamsFileTransfers.companyId),
            eq(chatPublications.endpointId, chatTeamsFileTransfers.endpointId),
            eq(
              chatPublications.conversationId,
              chatTeamsFileTransfers.conversationId,
            ),
            eq(chatPublications.issueId, chatTeamsFileTransfers.issueId),
            eq(chatPublications.commentId, chatTeamsFileTransfers.commentId),
            eq(chatPublications.state, "delivery_unknown"),
            sql`${chatPublications.payload}->'attachmentIds' = jsonb_build_array(${chatTeamsFileTransfers.attachmentId}::text)`,
          ),
        )
        .innerJoin(
          chatEndpoints,
          and(
            eq(chatEndpoints.id, chatTeamsFileTransfers.endpointId),
            eq(chatEndpoints.companyId, input.companyId),
            eq(chatEndpoints.provider, "microsoft-teams"),
          ),
        )
        .innerJoin(
          chatConversations,
          and(
            eq(chatConversations.id, chatTeamsFileTransfers.conversationId),
            eq(chatConversations.companyId, input.companyId),
            eq(chatConversations.endpointId, chatTeamsFileTransfers.endpointId),
            eq(chatConversations.issueId, issue.id),
            eq(
              chatConversations.sessionGeneration,
              chatTeamsFileTransfers.conversationGeneration,
            ),
          ),
        )
        .innerJoin(
          issueComments,
          and(
            eq(issueComments.id, chatTeamsFileTransfers.commentId),
            eq(issueComments.companyId, input.companyId),
            eq(issueComments.issueId, issue.id),
            eq(issueComments.createdByRunId, failedRun.id),
            eq(issueComments.authorAgentId, input.agentId),
            isNull(issueComments.deletedAt),
          ),
        )
        .innerJoin(
          issueAttachments,
          and(
            eq(issueAttachments.id, chatTeamsFileTransfers.attachmentId),
            eq(issueAttachments.companyId, input.companyId),
            eq(issueAttachments.issueId, issue.id),
            eq(issueAttachments.issueCommentId, issueComments.id),
            eq(issueAttachments.originatingRunId, failedRun.id),
          ),
        )
        .innerJoin(
          assets,
          and(
            eq(assets.id, issueAttachments.assetId),
            eq(assets.companyId, input.companyId),
            eq(assets.sha256, chatTeamsFileTransfers.sha256),
            eq(assets.byteSize, chatTeamsFileTransfers.byteSize),
          ),
        )
        .where(
          and(
            eq(chatTeamsFileTransfers.companyId, input.companyId),
            eq(chatTeamsFileTransfers.issueId, issue.id),
            eq(chatTeamsFileTransfers.id, continuingTransfer.transferId),
            eq(
              chatTeamsFileTransfers.publicationId,
              continuingTransfer.publicationId,
            ),
            eq(chatTeamsFileTransfers.version, continuingTransfer.version),
            eq(chatTeamsFileTransfers.phase, continuingTransfer.phase),
          ),
        )
        .for("share", { noWait: true });
      if (
        !continuing ||
        (continuing.attemptId &&
          (!continuing.attemptExpiresAt ||
            continuing.attemptExpiresAt > new Date()))
      )
        throw failedChatRetryDenied();
      continuingUnknownPublicationId = continuing.publicationId;
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
    if (
      (!input.committedResponse && accepted) ||
      resultPublication ||
      question ||
      answerDelivery
    )
      throw failedChatRetryDenied();
    if (context.chatFailedRunRetry) {
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
      await tx.execute(sql`select source.id, source.payload->>'commentId' as comment_id
      from agent_wakeup_requests receipt join chat_actions source on source.id = receipt.id
      where receipt.company_id = ${input.companyId}::uuid and receipt.agent_id = ${input.agentId}::uuid
        and (receipt.run_id = ${failedRun.id}::uuid or receipt.id = ${failedRun.wakeupRequestId}::uuid
          or receipt.payload->>'coalescedIntoWakeupRequestId' = ${failedRun.wakeupRequestId})
        and source.company_id = ${input.companyId}::uuid and source.kind = 'inbound_wakeup' limit 51`);
    if (
      admittedBatch.length !== commentIds.length ||
      admittedBatch.some(
        (entry) => !commentIds.includes(String(entry.comment_id)),
      )
    )
      throw failedChatRetryDenied();
    const sources = await tx
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
    const ordered = commentIds.map(
      (id) => sources.find((action) => action.payload.commentId === id)!,
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
    const canonicalSources: Array<Record<string, unknown>> = [];
    let destination: Awaited<ReturnType<typeof authorizeInboundWakeup>> | null =
      null;
    for (const action of ordered) {
      destination = await authorizeInboundWakeup(tx, action, {
        nonblocking: true,
        terminal: input.publication === true,
      }).catch((error) => {
        if (isExternalActionAuthorizationChange(error))
          throw failedChatRetryDenied();
        throw error;
      });
      const [delivery] = await tx
        .select()
        .from(chatDeliveries)
        .where(eq(chatDeliveries.id, action.deliveryId!))
        .for("update", { noWait: true });
      const [current] = await tx
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .for("update", { noWait: true });
      const [comment] = await tx
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.id, String(action.payload.commentId)),
            eq(issueComments.companyId, input.companyId),
            eq(issueComments.issueId, issue.id),
          ),
        )
        .for("share", { noWait: true });
      if (
        !current ||
        current.status !== "processed" ||
        inboundWakeScope(current) !== inboundWakeScope(action) ||
        !delivery ||
        delivery.state !== "processed" ||
        !comment ||
        comment.deletedAt ||
        comment.updatedAt.getTime() !== comment.createdAt.getTime() ||
        comment.updatedAt >
          (input.committedResponse
            ? accepted!.createdAt
            : failedRun.finishedAt!) ||
        destination.endpoint.provider !== provider ||
        JSON.stringify(lifecycleRuntimeFence(delivery)) !==
          JSON.stringify(lifecycleRuntimeFence(destination.delivery))
      )
        throw failedChatRetryDenied();
      const [lifecycle] = await tx
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.companyId, input.companyId),
            eq(chatDeliveries.endpointId, first.endpointId),
            or(
              isNull(chatDeliveries.conversationId),
              eq(chatDeliveries.conversationId, first.conversationId),
            ),
            ne(chatDeliveries.state, "filtered"),
            sql`${chatDeliveries.normalizedEvent}->'runtimeContext' = ${JSON.stringify(lifecycleRuntimeFence(delivery))}::jsonb`,
            inArray(chatDeliveries.eventKind, [
              "message_updated",
              "message_deleted",
              "message_restored",
            ]),
            sql`${chatDeliveries.normalizedEvent}->'message'->>'targetProviderEventId' = ${delivery.providerEventId}`,
          ),
        )
        .limit(1);
      if (lifecycle) throw failedChatRetryDenied();
      const [receipt] = await tx
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, action.id))
        .for("share", { noWait: true });
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
        const [next] = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.id, ownerId),
              eq(agentWakeupRequests.companyId, input.companyId),
            ),
          )
          .for("share", { noWait: true });
        if (!next) throw failedChatRetryDenied();
        owner = next;
      }
      if (
        owner.id !== failedRun.wakeupRequestId ||
        owner.runId !== failedRun.id ||
        owner.agentId !== input.agentId ||
        owner.requestedByActorType !== receipt.requestedByActorType ||
        owner.requestedByActorId !== receipt.requestedByActorId ||
        ["skipped", "cancelled"].includes(receipt.status)
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
        ownerId: owner.id,
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

  async function prepareFailedChatRunRetry(
    tx: DbOrTransaction,
    input: {
      companyId: string;
      issueId: string;
      agentId: string;
      failedRunId: string;
      initiatedByUserId: string;
    },
  ): Promise<{ actionId: string; issueId: string }> {
    const source = await failedChatRetrySource(tx, input);
    const providerActionId = `failed-run-retry:${source.failedRunId}`;
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
    await assertFailedNativeRetryState(tx, source, input.companyId);
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
    });
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
      await assertFailedNativeRetryState(tx, source, input.companyId);
      const context = input.contextSnapshot;
      const hint = context.chatFailedRunRetry as
        | Record<string, unknown>
        | undefined;
      if (
        context.issueId !== source.issueId ||
        context.source !== `chat:${source.provider}` ||
        context.taskKey !== source.taskKey ||
        context.retryOfRunId !== source.failedRunId ||
        JSON.stringify(retryCommentIds(context)) !==
          JSON.stringify(source.commentIds) ||
        hint?.version !== 1 ||
        hint.actionId !== source.intent.id ||
        hint.failedRunId !== source.failedRunId ||
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

  async function claimFailedChatRunRetry(actionId: string) {
    const [candidate] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "failed_run_retry"),
        ),
      );
    if (!candidate) throw notFound("Chat retry request not found");
    const now = new Date();
    if (
      isShuttingDown() ||
      !["issued", "processing"].includes(candidate.status) ||
      (candidate.status === "processing" &&
        candidate.updatedAt.getTime() >
          now.getTime() - DELIVERY_PROCESSING_STALE_MS) ||
      (typeof candidate.result?.retryAt === "string" &&
        Date.parse(candidate.result.retryAt) > now.getTime())
    )
      return failedChatRetryReceipt(candidate);
    const [claimed] = await db
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
    if (!claimed) return failedChatRetryReceipt(candidate);
    const attemptCount = Number(candidate.result?.attemptCount ?? 0) + 1;
    const settle = async (status: string, result: Record<string, unknown>) => {
      const [current] = await db
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
      return failedChatRetryReceipt(current ?? claimed);
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
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, claimed.id));
      if (!existing.length) {
        const context = {
          issueId: source.issueId,
          taskKey: source.taskKey,
          source: `chat:${source.provider}`,
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
              );
            },
          }),
        });
      }
      const [receipt] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, claimed.id));
      if (!receipt) throw new Error("chat_retry_receipt_not_committed");
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
      if (receipt)
        return settle("processed", {
          code: "failed_chat_retry_durable",
          attemptCount,
        });
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
    const now = new Date();
    const candidates = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "failed_run_retry"),
          or(
            eq(chatActions.status, "issued"),
            and(
              eq(chatActions.status, "processing"),
              lte(
                chatActions.updatedAt,
                new Date(now.getTime() - DELIVERY_PROCESSING_STALE_MS),
              ),
            ),
          ),
          sql`(${chatActions.result}->>'retryAt' is null or (${chatActions.result}->>'retryAt')::timestamptz <= ${now.toISOString()}::timestamptz)`,
        ),
      )
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
