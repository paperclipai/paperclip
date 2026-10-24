import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { encodePaperclipWakeData } from "@paperclipai/adapter-utils/server-utils";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { sanitizeQuarantinedCommentForHigherTrust } from "./source-trust.js";
import { hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { childReviewOutcomes } from "./native-runtime/child-review-outcomes.js";
import { isCompletedOnboardingHandoffWake } from "./chat-completion-delivery.js";
import { githubRecoveryReceipts } from "./chat-channels/github/recovery-receipts.js";

const EXECUTION_CONTINUATION_LIMITS = {
  maxComments: 40,
  maxCommentBodyChars: 4_000,
  maxCommentBodyEncodedBytes: 24_000,
  maxObjectiveEncodedBytes: 16_000,
  maxCompletedWorkEncodedBytes: 32_768,
} as const;

const encodedContinuationTextBytes = (value: string): number =>
  Buffer.byteLength(encodePaperclipWakeData(value).slice(1, -1));

const truncateToContinuationTextBytes = (value: string, budget: number): string => {
  if (encodedContinuationTextBytes(value) <= budget) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodedContinuationTextBytes(value.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
};

export class StaleExecutionContinuationError extends Error {
  constructor(readonly code: "continuation_task_ownership_changed") {
    super(code);
    this.name = "StaleExecutionContinuationError";
  }
}

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const string = (v: unknown) =>
  typeof v === "string" && v.length > 0 ? v : null;
export function continuationOriginCommentIds(context: unknown): string[] {
  const c = object(context);
  const prior = object(c.executionContinuation);
  return [
    ...new Set(
      [
        c.commentId,
        c.latestCommentId,
        ...(Array.isArray(c.commentIds) ? c.commentIds : []),
        ...(Array.isArray(c.wakeCommentIds) ? c.wakeCommentIds : []),
        ...(Array.isArray(prior.originCommentIds)
          ? prior.originCommentIds
          : []),
      ].filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
}

/**
 * Return the comment IDs explicitly represented in a delivered continuation.
 * An absent list is intentionally different from an empty list: historical or
 * third-party snapshots cannot prove what the provider received.
 */
export function deliveredContinuationCommentIds(context: unknown): {
  known: boolean;
  ids: Set<string>;
} {
  const c = object(context);
  const wake = object(c.paperclipWake);
  const continuation = object(c.executionContinuation);
  const ids = new Set<string>();
  let known = false;
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    known = true;
    for (const item of value) {
      const id = typeof item === "string" ? item : string(object(item).id);
      if (id) ids.add(id);
    }
  };
  collect(wake.comments);
  collect(continuation.messages);
  return { known, ids };
}

/** Keep service/tool results and generated summaries out of human authority. */
export function projectHumanInteractionResponse(row: {
  id: string; kind: string; status: string; result: unknown;
  resolvedByUserId: string | null; resolvedByAgentId: string | null;
  resolvedByRunId: string | null; resolvedAt: Date | null;
}): NonNullable<ExecutionContinuationEnvelope["humanResponses"]>[number] | null {
  if (!row.resolvedByUserId || row.resolvedByAgentId || row.resolvedByRunId || !row.resolvedAt) return null;
  const result = object(row.result);
  let response: Record<string, unknown>;
  if (row.kind === "ask_user_questions" && row.status === "answered" && Array.isArray(result.answers)) {
    response = { answers: result.answers.map(value => {
      const answer = object(value);
      return { questionId: answer.questionId, optionIds: answer.optionIds, otherText: answer.otherText };
    }) };
  } else if (["request_confirmation", "request_checkbox_confirmation"].includes(row.kind)
    && ["accepted", "rejected"].includes(row.status) && result.outcome === row.status) {
    response = { outcome: result.outcome, reason: result.reason,
      ...(Array.isArray(result.selectedOptionIds) ? { selectedOptionIds: result.selectedOptionIds } : {}) };
  } else return null;
  return { id: row.id, kind: row.kind, status: row.status, resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt.toISOString(), result: response };
}

/** Also retain user direction delivered after the source run's initial wake. */
export async function currentContinuationOrigins(
  db: Db,
  companyId: string,
  issueId: string,
  context: unknown,
): Promise<string[]> {
  const candidates = continuationOriginCommentIds(context);
  // A run may create an interaction on another task. Its own comments do not
  // become authority on that task. Keep unknown references for dispatch to
  // reject, rather than silently claiming complete context.
  const foreignComments = candidates.length
    ? await db.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, companyId),
        sql`${issueComments.issueId} != ${issueId}`,
        inArray(sql<string>`${issueComments.id}::text`, candidates),
      ))
    : [];
  const foreignIds = new Set(foreignComments.map(row => row.id));
  const [latest] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNotNull(issueComments.authorUserId),
        isNull(issueComments.createdByRunId),
        isNull(issueComments.authorAgentId),
        isNull(issueComments.deletedAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1);
  return [
    ...new Set([
      ...candidates.filter(id => !foreignIds.has(id)),
      ...(latest ? [latest.id] : []),
    ]),
  ];
}

/** Re-read task scope at dispatch, including messages already delivered to an earlier provider session. */
export async function buildExecutionContinuation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  context: Record<string, unknown>;
  previousContextRunId?: string | null;
  /** Server-owned current run identity when validating dispatch authority. */
  runId?: string;
  summary: string | null;
  exposeLowTrustRaw: boolean;
}): Promise<ExecutionContinuationEnvelope> {
  const { db, companyId, issueId } = input;
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (
    !issue ||
    issue.assigneeAgentId !== input.agentId ||
    issue.status === "cancelled" ||
    (issue.status === "done" && !await isCompletedOnboardingHandoffWake(db, {
      companyId, issueId, agentId: input.agentId,
      reason: string(input.context.wakeReason), contextSnapshot: input.context,
    }))
  )
    throw new StaleExecutionContinuationError("continuation_task_ownership_changed");
  const interactions = await db
    .select()
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
      ),
    )
    .orderBy(
      asc(issueThreadInteractions.createdAt),
      asc(issueThreadInteractions.id),
    );
  const triggerInteraction = interactions.find(
    (row) => row.id === input.context.interactionId,
  );
  const explicitContinuation = object(input.context.explicitUserContinuation);
  const explicitUserSource = string(explicitContinuation.previousRunId);
  const resumeSourceRunId =
    explicitUserSource ??
    string(input.context.retryOfRunId) ??
    string(input.context.previousRunId) ??
    string(input.context.interruptedRunId);
  const producerRunId = triggerInteraction?.sourceRunId ?? null;
  const sourceRunId = resumeSourceRunId ?? producerRunId;
  const loadRun = async (id: string) => (await db
    .select({ context: heartbeatRuns.contextSnapshot, result: heartbeatRuns.resultJson })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, id)))
  )[0];
  const candidate = sourceRunId ? await loadRun(sourceRunId) : null;
  // An interaction producer is provenance. Explicit resume history must still
  // belong to this task, and only task-scoped content can enter the envelope.
  const sourceRun = object(candidate?.context).issueId === issueId ? candidate : null;
  if ((sourceRunId && !candidate) || (resumeSourceRunId && !sourceRun))
    throw new Error(explicitUserSource ? "continuation_user_authorization_missing" : "continuation_source_context_missing");
  const producer = producerRunId === sourceRunId ? candidate
    : producerRunId ? await loadRun(producerRunId) : null;
  if (producerRunId && !producer) throw new Error("continuation_source_context_missing");
  const producerIssueId = string(object(producer?.context).issueId);
  const producerOrigins = new Set(continuationOriginCommentIds(producer?.context));
  const recordedOrigins = triggerInteraction?.originCommentIds ?? [];
  const inheritedOrigins = recordedOrigins.filter(id => producerOrigins.has(id));
  // Older interactions copied the producer's origins without task scope.
  // Ignore only references proven to be comments on that producer's other
  // task. Missing rows, unrelated references, and explicit wake origins keep
  // the existing fail-closed check below.
  const inheritedForeignComments = producerIssueId && producerIssueId !== issueId && inheritedOrigins.length
    ? await db.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, companyId),
        sql`${issueComments.issueId}::text = ${producerIssueId}`,
        inArray(sql<string>`${issueComments.id}::text`, inheritedOrigins),
      ))
    : [];
  const inheritedForeignIds = new Set(inheritedForeignComments.map(row => row.id));
  const candidateOriginCommentIds = [
    ...new Set([
      ...continuationOriginCommentIds(input.context),
      ...continuationOriginCommentIds(sourceRun?.context),
      ...recordedOrigins.filter(id => !inheritedForeignIds.has(id)),
      ...(triggerInteraction?.sourceCommentId
        ? [triggerInteraction.sourceCommentId]
        : []),
    ]),
  ];
  const explicitContinuationCommentId = string(explicitContinuation.commentId);
  const candidateRequiredCommentIds = [
    ...new Set([
      ...candidateOriginCommentIds,
      ...(explicitContinuationCommentId ? [explicitContinuationCommentId] : []),
    ]),
  ];
  const candidateRows = candidateRequiredCommentIds.length
    ? await db
        .select({ id: issueComments.id, createdAt: issueComments.createdAt })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            inArray(issueComments.id, candidateRequiredCommentIds),
          ),
        )
    : [];
  const candidateCreatedAt = new Map(
    candidateRows.map((row) => [row.id, row.createdAt]),
  );
  if (candidateOriginCommentIds.some((id) => !candidateCreatedAt.has(id)))
    throw new Error("continuation_source_context_missing");
  const originCapacity = Math.max(
    1,
    EXECUTION_CONTINUATION_LIMITS.maxComments -
      (explicitContinuationCommentId ? 1 : 0),
  );
  const originCommentIds = candidateOriginCommentIds
    .filter((id) => candidateCreatedAt.has(id))
    .sort((left, right) => {
      const createdAtDiff =
        candidateCreatedAt.get(right)!.getTime() -
        candidateCreatedAt.get(left)!.getTime();
      if (createdAtDiff !== 0) return createdAtDiff;
      return left < right ? 1 : left > right ? -1 : 0;
    })
    .slice(0, originCapacity)
    .sort(
      (left, right) =>
        candidateOriginCommentIds.indexOf(left) -
        candidateOriginCommentIds.indexOf(right),
    );
  const requiredCommentIds = [
    ...new Set([
      ...originCommentIds,
      ...(explicitContinuationCommentId ? [explicitContinuationCommentId] : []),
    ]),
  ];
  const recentRows = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(EXECUTION_CONTINUATION_LIMITS.maxComments);
  const recentRowIds = new Set(recentRows.map((row) => row.id));
  const missingRequiredIds = requiredCommentIds.filter(
    (id) => !recentRowIds.has(id),
  );
  const requiredRows = missingRequiredIds.length
    ? await db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            inArray(issueComments.id, missingRequiredIds),
          ),
        )
    : [];
  const windowRows = [...recentRows];
  let displaced = requiredRows.length;
  for (
    let index = windowRows.length - 1;
    index >= 0 && displaced > 0;
    index -= 1
  ) {
    if (requiredCommentIds.includes(windowRows[index]!.id)) continue;
    windowRows.splice(index, 1);
    displaced -= 1;
  }
  const rows = [...windowRows, ...requiredRows].sort((left, right) => {
    const createdAtDiff = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdAtDiff !== 0) return createdAtDiff;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  // Missing source rows cannot silently become a claim of complete context.
  if (originCommentIds.some((id) => !rows.some((row) => row.id === id)))
    throw new Error("continuation_source_context_missing");
  const preparedRows = rows.map((row) => ({
    row,
    safe: input.exposeLowTrustRaw
      ? row
      : sanitizeQuarantinedCommentForHigherTrust(row),
  }));
  const requiredRowIds = new Set(
    requiredCommentIds.filter((id) => rows.some((row) => row.id === id)),
  );
  const bodyAllowances = new Map<string, number>();
  let remainingBodyBytes: number =
    EXECUTION_CONTINUATION_LIMITS.maxCommentBodyEncodedBytes;
  const allocateBodyBytes = (entries: typeof preparedRows) => {
    for (const { row, safe } of entries) {
      const body = row.deletedAt ? "" : safe.body;
      const allowed = Math.min(
        EXECUTION_CONTINUATION_LIMITS.maxCommentBodyChars,
        body.length,
        truncateToContinuationTextBytes(body, remainingBodyBytes).length,
      );
      bodyAllowances.set(row.id, allowed);
      remainingBodyBytes = Math.max(
        0,
        remainingBodyBytes - encodedContinuationTextBytes(body.slice(0, allowed)),
      );
    }
  };
  allocateBodyBytes(
    preparedRows.filter(({ row }) => requiredRowIds.has(row.id)).reverse(),
  );
  allocateBodyBytes(
    preparedRows.filter(({ row }) => !requiredRowIds.has(row.id)).reverse(),
  );
  const messages = preparedRows.map(({ row, safe }) => ({
    id: row.id,
    authorType:
      row.authorType ??
      (row.authorUserId ? "user" : row.authorAgentId ? "agent" : "system"),
    authorId: row.authorUserId ?? row.authorAgentId,
    createdByRunId: row.createdByRunId,
    body: row.deletedAt
      ? ""
      : safe.body.slice(0, bodyAllowances.get(row.id) ?? 0),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deleted: row.deletedAt !== null,
    sourceTrust: row.sourceTrust,
  }));
  const previousRun = input.previousContextRunId
    ? (
        await db
          .select({ context: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.agentId, input.agentId),
              eq(heartbeatRuns.id, input.previousContextRunId),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            ),
          )
      )[0]
    : null;
  const priorEnvelope = object(previousRun?.context?.executionContinuation);
  const deliveredMessages = Array.isArray(priorEnvelope.messages)
    ? priorEnvelope.messages.map(object)
    : null;
  const resumeDelta =
    deliveredMessages && input.previousContextRunId
      ? {
          baseRunId: input.previousContextRunId,
          messages: messages.filter(
            (message) =>
              originCommentIds.includes(message.id) ||
              !deliveredMessages.some(
                (prior) =>
                  prior.id === message.id &&
                  prior.updatedAt === message.updatedAt &&
                  prior.body === message.body &&
                  prior.deleted === message.deleted &&
                  prior.authorId === message.authorId &&
                  (prior.createdByRunId ?? null) === message.createdByRunId &&
                  JSON.stringify(prior.sourceTrust) ===
                    JSON.stringify(message.sourceTrust),
              ),
          ),
        }
      : undefined;
  const [latestRequestRow] = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        sql`(${issueComments.authorType} = 'user' or (${issueComments.authorType} is null and ${issueComments.authorUserId} is not null))`,
        isNull(issueComments.createdByRunId),
        isNull(issueComments.deletedAt),
        sql`length(trim(${issueComments.body})) > 0`,
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1);
  const latestRequest = latestRequestRow
    ? input.exposeLowTrustRaw
      ? latestRequestRow
      : sanitizeQuarantinedCommentForHigherTrust(latestRequestRow)
    : null;
  const hashObjectiveSource = (value: string) => createHash("sha256").update(value.trim()).digest("hex");
  const objectiveSource = latestRequest
    ? { kind: "comment" as const, id: latestRequest.id, revision: latestRequest.updatedAt.toISOString() }
    : issue.description !== null && issue.description !== undefined
      ? { kind: "description" as const, id: issue.id, revision: hashObjectiveSource(issue.description) }
      : { kind: "title" as const, id: issue.id, revision: hashObjectiveSource(issue.title) };
  const objective = latestRequest
    ? truncateToContinuationTextBytes(
        latestRequest.body,
        EXECUTION_CONTINUATION_LIMITS.maxObjectiveEncodedBytes,
      )
    : issue.description ?? issue.title;
  const completedWorkSummary =
    input.summary ??
    string(object(object(sourceRun?.result).nativeResult).summary) ??
    string(object(sourceRun?.result).summary) ??
    null;
  const completedWorkText = completedWorkSummary === null
    ? null
    : truncateToContinuationTextBytes(
        completedWorkSummary,
        EXECUTION_CONTINUATION_LIMITS.maxCompletedWorkEncodedBytes,
      );
  const priorRuns = await db
    .select({ id: heartbeatRuns.id, result: heartbeatRuns.resultJson, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, runtimeMode: heartbeatRuns.runtimeMode, retryOfRunId: heartbeatRuns.retryOfRunId })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        or(eq(heartbeatRuns.agentId, input.agentId),
          sourceRunId ? eq(heartbeatRuns.id, sourceRunId) : undefined),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  const completedActions = priorRuns.flatMap((run) =>
    Object.entries(object(object(run.result).apiToolReceipts)).flatMap(
      ([receiptId, receipt]) => {
        const value = object(receipt);
        return value.state === "completed" &&
          typeof value.operationId === "string"
          ? [
              {
                runId: run.id,
                receiptId,
                operationId: value.operationId,
                result: value.result,
              },
            ]
          : [];
      },
    ),
  );
  completedActions.push(...await githubRecoveryReceipts(db, companyId, issueId));
  const reconciliations = await db
    .select({
      id: issueRecoveryActions.id,
      evidence: issueRecoveryActions.evidence,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.status, "resolved"),
      ),
    );
  const lastTerminal = priorRuns.findLast((run) =>
    ["succeeded", "failed", "timed_out", "interrupted", "cancelled"].includes(run.status) &&
    !(run.status === "cancelled" && run.errorCode === "execution_reconciliation_required"),
  );
  if (explicitUserSource) {
    const predecessor = priorRuns.find(run => run.id === explicitUserSource &&
      ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status));
    const failedRunId = string(explicitContinuation.failedRunId);
    const retryWakes = failedRunId ? await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.reason, "retry_failed_run"), eq(agentWakeupRequests.requestedByActorType, "user"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )) : [];
    // Admission records the board operator's authority separately from the
    // message author. At dispatch, prove that exact queue was adopted by this
    // run; caller-supplied continuation context cannot grant this authority.
    const continuationAuthorizations = reconciliations.map(row => object(row.evidence.explicitUserContinuation))
      .filter(value => value.previousRunId === explicitUserSource &&
        (!input.runId || value.runId === input.runId) &&
        value.commentId === explicitContinuation.commentId &&
        priorRuns.some(run => run.id === value.runId));
    const interruptQueueIds = [...new Set(continuationAuthorizations.flatMap(value => {
      const parsed = z.string().guid().safeParse(value.queuedCommentInterruptId);
      return parsed.success ? [parsed.data] : [];
    }))];
    const interruptQueues = interruptQueueIds.length
      ? await db.select().from(agentWakeupRequests).where(and(
        inArray(agentWakeupRequests.id, interruptQueueIds),
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.status, "coalesced"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
        input.runId ? eq(agentWakeupRequests.runId, input.runId) : undefined,
      )) : [];
    const taskRetryId = string(explicitContinuation.taskRetryRequestId);
    const [taskRetryWake] = taskRetryId && z.string().guid().safeParse(taskRetryId).success
      ? await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, taskRetryId),
        eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.reason, "task_retry"),
        eq(agentWakeupRequests.requestedByActorType, "user"), eq(agentWakeupRequests.status, "coalesced"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
        input.runId ? eq(agentWakeupRequests.runId, input.runId) : undefined,
      )) : [];
    const authorization = continuationAuthorizations.find(value => taskRetryId
          ? value.taskRetryRequestId === taskRetryId && taskRetryWake?.runId === value.runId &&
            taskRetryWake.requestedByActorId === value.actorId &&
            object(taskRetryWake.payload?.taskRetry).sourceRunId === value.previousRunId
          : failedRunId
          ? value.failedRunId === failedRunId && retryWakes.some(wake =>
              wake.runId === value.runId && wake.requestedByActorId === value.actorId &&
              priorRuns.some(run => run.id === wake.runId && run.retryOfRunId === failedRunId))
          : rows.some(comment => comment.id === value.commentId &&
              comment.authorType === "user" &&
              (!("commentUpdatedAt" in value || "commentBodyHash" in value || value.automaticRetry) || (
                value.commentUpdatedAt === comment.updatedAt.toISOString() &&
                value.commentBodyHash === createHash("sha256").update(comment.body).digest("hex")
              )) &&
              (!value.automaticRetry || (
                object(value.automaticRetry).sourceRunId === explicitUserSource &&
                comment.body.trim().length > 0 && issue.executionRunId === input.runId &&
                priorRuns.some(run => run.id === value.runId && run.retryOfRunId === explicitUserSource)
              )) &&
              (value.queuedCommentInterruptId
                ? interruptQueues.some(queue => queue.id === value.queuedCommentInterruptId &&
                    queue.runId === value.runId &&
                    object(object(queue.payload).queuedCommentInterrupt).actorId === value.actorId &&
                    queuedCommentIdsFromWakePayload(queue.payload).includes(comment.id))
                : comment.authorUserId === value.actorId) &&
              !comment.createdByRunId && !comment.deletedAt));
    if (!predecessor || !authorization || explicitUserSource !== sourceRunId)
      throw new Error("continuation_user_authorization_missing");
  }
  const interruptedRunId = explicitUserSource ?? string(input.context.interruptedRunId) ?? (lastTerminal && lastTerminal.status !== "succeeded" &&
    (hasConversationContinuationPolicy(lastTerminal.result) ||
      lastTerminal.status === "interrupted" || lastTerminal.errorCode === "process_lost")
    ? lastTerminal.id : undefined);
  return {
    ...(interruptedRunId ? { interruptedRunId } : {}),
    ...(resumeDelta ? { resumeDelta } : {}),
    recoveryOutcomes: reconciliations
      .filter((row) => row.evidence.executionReconciliation)
      .map((row) => ({
        recoveryActionId: row.id,
        decision: row.evidence.executionReconciliation,
      })),
    version: 1,
    companyId,
    issueId,
    trigger: {
      reason: string(input.context.wakeReason) ?? "task_execution",
      interactionId: triggerInteraction?.id ?? null,
      sourceRunId,
    },
    originCommentIds,
    objective,
    objectiveSource,
    messages,
    humanResponses: interactions.flatMap(row => {
      const response = projectHumanInteractionResponse(row);
      return response ? [response] : [];
    }),
    interactionOutcomes: [...interactions
      .filter((row) => row.status !== "pending")
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        result: row.result,
      })), ...await childReviewOutcomes(db, companyId, issueId, { type: "agent", agentId: input.agentId, companyId, onBehalfOfUserId: issue.responsibleUserId })],
    // Low-trust evidence only: renderPaperclipWakePrompt removes completedWork
    // from requestContext and encodes it in the fenced, non-authoritative
    // continuation-evidence section. It cannot supply objective or authority.
    completedWork: completedWorkText,
    completedActions,
    unresolvedInteractionIds: interactions
      .filter((row) => row.status === "pending")
      .map((row) => row.id),
    coverage: {
      kind: "full_task_history",
      throughCommentId: messages.at(-1)?.id ?? null,
      summaryThroughCommentId: null,
    },
  };
}
