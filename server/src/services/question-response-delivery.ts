import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  activityLog,
  chatPublications,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueQuestionResponseDeliveries,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import type {
  AskUserQuestionsInteraction,
  PaperclipQuestionSetPayload,
} from "@paperclipai/shared";
import type { PaperclipQuestionResponse } from "../vendor/paperclip-runner/index.js";
import { isUniqueViolation } from "../db-errors.js";
import { getTelemetryClient } from "../telemetry.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";

const DELIVERY_CLAIM_STALE_MS = 30_000;
const DELIVERY_CLAIM_REFRESH_MS = 10_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_CORRELATION_PREFIX = "question-response:";
const QUESTION_RESPONSE_WAKE_IDEMPOTENCY_CONSTRAINT =
  "agent_wakeup_requests_question_response_delivery_idempotency_uq";

class DeliveryClaimUnavailableError extends Error {
  constructor() {
    super("question_response_delivery_claim_unavailable");
    this.name = "DeliveryClaimUnavailableError";
  }
}
const DURABLE_WAKE_REQUEST_STATUSES = [
  "queued",
  "claimed",
  "running",
  "succeeded",
  "completed",
  "coalesced",
  "deferred_issue_execution",
  "retrying",
  "scheduled_retry",
] as const;

type QuestionInteractionRow = typeof issueThreadInteractions.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

/**
 * Who hears an answer. An agent that asks a question and then reports `in_review` on an
 * issue with a review stage leaves the issue with its human (`assigneeUserId`), no agent
 * assignee, and itself as the review stage's `returnAssignee`. Delivering only to
 * `assigneeAgentId` dropped every such answer (`question_response_target_unavailable`).
 *
 *   - `assignee`: the issue has an agent assignee; that agent is woken, as before.
 *   - `hand_back`: no agent assignee; the asker (or, failing that, the stage's return
 *     assignee) takes the issue back before the wake, because a resolved-interaction
 *     continuation run is cancelled `issue_assignee_changed` at claim unless its agent is
 *     the assignee (`run-dispatch/domain/policy.ts`, `decideQueuedRunStaleness`).
 *     `review_stage` returns a pending review stage the way the reviewer's own "request
 *     changes" does, and only when the answerer IS that stage's current participant.
 *     `unstaged` hands back only when no human holds the issue, or the human who holds
 *     it is the one who answered.
 *   - `held`: someone else holds the issue (a review stage waiting on another person, or
 *     a human assignee who did not answer). Nothing moves; the saved answer stays pending
 *     and is retried, so it reaches the agent once that person gives the issue back.
 *   - `unavailable`: no agent can be woken at all; the delivery fails.
 */
type AnswerTarget =
  | { kind: "assignee"; agentId: string }
  | { kind: "hand_back"; agentId: string; via: "review_stage" | "unstaged" }
  | { kind: "held"; errorCode: string }
  | { kind: "unavailable"; errorCode: string };
type DeliveryRow = typeof issueQuestionResponseDeliveries.$inferSelect;
type Heartbeat = Pick<
  ReturnType<typeof heartbeatService>,
  "wakeup" | "cancelRun"
>;
type QuestionResponseSteer = (input: {
  runId: string;
  message: string;
  correlationId: string;
}) => Promise<{ turnId?: string | null }>;
type NativeQuestionResponseResolver = (
  interaction: AskUserQuestionsInteraction,
) => Promise<"not_native" | "pending" | "queued">;

export interface QuestionResponseDeliveryEnvelope {
  schema: "paperclip.question_response_delivery.v1";
  interactionId: string;
  sourceRunId: string | null;
  questionSet: PaperclipQuestionSetPayload;
  response: PaperclipQuestionResponse;
}

export interface QuestionResponseDeliveryOutcome {
  deliveryId: string;
  status: DeliveryRow["status"];
  mode: DeliveryRow["deliveryMode"];
  targetRunId: string | null;
  targetTurnId: string | null;
  duplicate: boolean;
}

export interface QuestionResponseDeliveryServiceOptions {
  heartbeat: Heartbeat;
  /** Kept for caller compatibility. Answers never implicitly steer an active turn. */
  steer?: QuestionResponseSteer;
  /** Resolve the original in-flight native input request before considering a continuation run. */
  resolveNativeQuestion?: NativeQuestionResponseResolver;
  now?: () => Date;
  /** Test-only lease timings. Production callers use the bounded defaults. */
  claimStaleMs?: number;
  claimRefreshMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function canonicalQuestionSet(
  interaction: Pick<AskUserQuestionsInteraction, "title" | "payload">,
): PaperclipQuestionSetPayload {
  if (interaction.payload.questionSet)
    return structuredClone(interaction.payload.questionSet);
  return {
    schema: "paperclip.question_set.v1",
    ...(interaction.title ? { title: interaction.title } : {}),
    ...(interaction.payload.submitLabel
      ? { submitLabel: interaction.payload.submitLabel }
      : {}),
    questions: interaction.payload.questions.map((question) => {
      const customOption = question.options.find(
        (option) => option.freeText === true,
      );
      return {
        id: question.id,
        prompt: question.prompt,
        ...(question.helpText ? { helpText: question.helpText } : {}),
        required: question.required === true,
        answerMode:
          question.selectionMode === "multi"
            ? ("multi_select" as const)
            : ("single_select" as const),
        options: question.options
          .filter((option) => option.freeText !== true)
          .map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        ...(customOption
          ? {
              customAnswer: {
                enabled: true as const,
                label: customOption.label,
                ...(customOption.description
                  ? { placeholder: customOption.description }
                  : {}),
              },
            }
          : {}),
      };
    }),
  };
}

export function buildQuestionResponseDeliveryEnvelope(
  interaction: AskUserQuestionsInteraction,
): QuestionResponseDeliveryEnvelope {
  if (
    interaction.status !== "answered" ||
    !interaction.result ||
    interaction.result.cancelled === true
  ) {
    throw new Error("question_response_interaction_not_answered");
  }
  const questionSet = canonicalQuestionSet(interaction);
  const questionById = new Map(
    questionSet.questions.map((question) => [question.id, question]),
  );
  const response: PaperclipQuestionResponse = {
    schema: "paperclip.question_response.v1",
    answers: Object.fromEntries(
      interaction.result.answers.map((answer) => {
        const question = questionById.get(answer.questionId);
        return [
          answer.questionId,
          question?.answerMode === "text"
            ? { ...(answer.otherText ? { text: answer.otherText } : {}) }
            : {
                selectedOptionIds: answer.optionIds,
                ...(answer.otherText ? { customText: answer.otherText } : {}),
              },
        ];
      }),
    ),
  };
  return {
    schema: "paperclip.question_response_delivery.v1",
    interactionId: interaction.id,
    sourceRunId: interaction.sourceRunId ?? null,
    questionSet,
    response,
  };
}

function questionAnswerLines(
  envelope: QuestionResponseDeliveryEnvelope,
): string[] {
  const lines: string[] = [];
  for (const question of envelope.questionSet.questions) {
    const answer = envelope.response.answers[question.id];
    if (!answer) continue;
    const optionLabelById = new Map(
      (question.options ?? []).map((option) => [option.id, option.label]),
    );
    const values = (answer.selectedOptionIds ?? []).map(
      (optionId) => optionLabelById.get(optionId) ?? optionId,
    );
    const text = compactLine(answer.text);
    const customText = compactLine(answer.customText);
    if (text) values.push(text);
    if (customText) values.push(customText);
    const header = compactLine(question.header);
    const prompt = compactLine(question.prompt);
    const label =
      header && prompt && header !== prompt
        ? `${header} — ${prompt}`
        : (header ?? prompt ?? question.id);
    lines.push(`- ${label}: ${values.join(", ") || "No answer"}`);
  }
  return lines;
}

export function formatQuestionResponseSummary(
  envelope: QuestionResponseDeliveryEnvelope,
): string {
  const lines = questionAnswerLines(envelope);
  return lines.length > 0
    ? ["Resolved questions and answers:", ...lines].join("\n")
    : "Resolved questions and answers.";
}

export function formatDurableQuestionResponseSummary(
  interaction: AskUserQuestionsInteraction,
): string {
  const existing = compactLine(interaction.result?.summaryMarkdown);
  return (
    existing ??
    formatQuestionResponseSummary(
      buildQuestionResponseDeliveryEnvelope(interaction),
    )
  );
}

export function formatQuestionResponseSteeringMessage(
  envelope: QuestionResponseDeliveryEnvelope,
): string {
  const lines = questionAnswerLines(envelope);
  return lines.length > 0
    ? ["Answered questions", "", ...lines].join("\n")
    : "Answered questions";
}

function hydrateQuestionInteraction(
  row: QuestionInteractionRow,
): AskUserQuestionsInteraction {
  return {
    ...row,
    kind: "ask_user_questions",
    status: row.status as AskUserQuestionsInteraction["status"],
    continuationPolicy:
      row.continuationPolicy as AskUserQuestionsInteraction["continuationPolicy"],
    resolverPolicy: row.effectiveResolverPolicy,
    requestedResolverPolicy: row.requestedResolverPolicy,
    effectiveResolverPolicy: row.effectiveResolverPolicy,
    resolverPolicyProvenance: row.resolverPolicyProvenance,
    effectiveResolverPolicySource: row.effectiveResolverPolicySource,
    legacyResolverPolicyAliases: { requested: null, effective: null },
    payload: row.payload as AskUserQuestionsInteraction["payload"],
    result: row.result as AskUserQuestionsInteraction["result"],
  };
}

export function questionResponseDeliveryValues(
  interaction: AskUserQuestionsInteraction,
) {
  const envelope = buildQuestionResponseDeliveryEnvelope(interaction);
  return {
    companyId: interaction.companyId,
    issueId: interaction.issueId,
    interactionId: interaction.id,
    sourceRunId: interaction.sourceRunId ?? null,
    correlationId: `${DELIVERY_CORRELATION_PREFIX}${interaction.id}`,
    payloadSha256: nativeSha256(envelope),
  };
}

/**
 * An intentional retired question source is not a failed execution incident.
 * This is only a stop classification: the dedicated answer wake still needs
 * its own fresh source/principal attestation before it can execute. Call while
 * holding the task lock; no provider operation or successor is started here.
 */
export async function isRetiredExternalChatQuestionSource(
  database: Db,
  scope: { companyId: string; issueId: string; agentId: string; runId: string },
): Promise<boolean> {
  const source = await database.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, scope.runId),
    eq(heartbeatRuns.companyId, scope.companyId),
    eq(heartbeatRuns.agentId, scope.agentId),
    eq(heartbeatRuns.nativeIssueId, scope.issueId),
    eq(heartbeatRuns.runtimeMode, "native"),
    eq(heartbeatRuns.status, "cancelled"),
    eq(heartbeatRuns.errorCode, "external_chat_continuation"),
  )).limit(1).then(rows => rows[0] ?? null);
  if (!source) return false;
  const result = record(source.resultJson);
  const cancellation = record(result.nativeCancellation);
  const interactionId = result.interactionId;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    result.externalChatContinuation !== true ||
    typeof interactionId !== "string" || !uuid.test(interactionId) ||
    cancellation.schema !== "paperclip.native-cancellation.v1" ||
    cancellation.companyId !== scope.companyId ||
    cancellation.runId !== scope.runId ||
    cancellation.issueId !== scope.issueId ||
    cancellation.scope !== "run" ||
    cancellation.dispatchState !== "acknowledged" ||
    typeof cancellation.intentId !== "string" ||
    typeof cancellation.intentAuditId !== "string" || !uuid.test(cancellation.intentAuditId) ||
    typeof cancellation.acknowledgementAuditId !== "string" || !uuid.test(cancellation.acknowledgementAuditId)
  ) return false;
  const interaction = await database.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId),
    eq(issueThreadInteractions.companyId, scope.companyId),
    eq(issueThreadInteractions.issueId, scope.issueId),
    eq(issueThreadInteractions.createdByAgentId, scope.agentId),
    eq(issueThreadInteractions.sourceRunId, scope.runId),
    eq(issueThreadInteractions.kind, "ask_user_questions"),
    eq(issueThreadInteractions.status, "answered"),
  )).limit(1).then(rows => rows[0] ?? null);
  if (!interaction) return false;
  let expected: ReturnType<typeof questionResponseDeliveryValues>;
  try {
    expected = questionResponseDeliveryValues(hydrateQuestionInteraction(interaction));
  } catch {
    return false;
  }
  const delivery = await database.select({ id: issueQuestionResponseDeliveries.id }).from(issueQuestionResponseDeliveries).where(and(
    eq(issueQuestionResponseDeliveries.companyId, scope.companyId),
    eq(issueQuestionResponseDeliveries.issueId, scope.issueId),
    eq(issueQuestionResponseDeliveries.interactionId, interactionId),
    eq(issueQuestionResponseDeliveries.sourceRunId, scope.runId),
    eq(issueQuestionResponseDeliveries.correlationId, expected.correlationId),
    eq(issueQuestionResponseDeliveries.payloadSha256, expected.payloadSha256),
  )).limit(1);
  if (!delivery.length) return false;
  const audits = await database.select().from(activityLog).where(and(
    eq(activityLog.companyId, scope.companyId),
    eq(activityLog.agentId, scope.agentId),
    eq(activityLog.runId, scope.runId),
    eq(activityLog.entityType, "heartbeat_run"),
    eq(activityLog.entityId, scope.runId),
    eq(activityLog.actorType, "system"),
    eq(activityLog.actorId, "native-session-cancellation"),
    inArray(activityLog.id, [cancellation.intentAuditId, cancellation.acknowledgementAuditId]),
  ));
  return audits.some(audit => audit.id === cancellation.intentAuditId &&
    audit.action === "native.cancellation_intent_recorded" &&
    record(audit.details).intentId === cancellation.intentId &&
    record(audit.details).scope === "run") &&
    audits.some(audit => audit.id === cancellation.acknowledgementAuditId &&
      audit.action === "native.cancellation_dispatch_acknowledged" &&
      record(audit.details).intentId === cancellation.intentId &&
      record(audit.details).intentAuditId === cancellation.intentAuditId &&
      record(audit.details).scope === "run");
}

function issueIdFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot">,
) {
  const context = record(run.contextSnapshot);
  return compactLine(context.issueId) ?? compactLine(context.taskId);
}

function sourceCommentIdFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot"> | null,
) {
  const context = record(run?.contextSnapshot);
  const batched = Array.isArray(context.wakeCommentIds)
    ? context.wakeCommentIds
        .map((value) => compactLine(value))
        .filter((value): value is string => Boolean(value))
    : [];
  return (
    batched.at(-1) ??
    compactLine(context.wakeCommentId) ??
    compactLine(context.commentId)
  );
}

function hasExternalChatOrigin(
  run: Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot"> | null,
) {
  const source = compactLine(record(run?.contextSnapshot).source);
  return (
    source?.startsWith("chat:") === true ||
    source === "external_chat.interaction.resolve"
  );
}

function actorForInteraction(interaction: QuestionInteractionRow) {
  if (interaction.resolvedByUserId) {
    return {
      actorType: "user" as const,
      actorId: interaction.resolvedByUserId,
    };
  }
  if (interaction.resolvedByAgentId) {
    return {
      actorType: "agent" as const,
      actorId: interaction.resolvedByAgentId,
    };
  }
  return { actorType: "system" as const, actorId: "question-response-outbox" };
}

export function questionResponseDeliveryService(
  db: Db,
  options: QuestionResponseDeliveryServiceOptions,
) {
  const resolveNativeQuestion = options.resolveNativeQuestion;
  const now = options.now ?? (() => new Date());
  const claimStaleMs = Math.max(
    2,
    options.claimStaleMs ?? DELIVERY_CLAIM_STALE_MS,
  );
  const claimRefreshMs = Math.max(
    1,
    Math.min(
      options.claimRefreshMs ?? DELIVERY_CLAIM_REFRESH_MS,
      Math.floor(claimStaleMs / 2),
    ),
  );

  async function claim(interactionId: string): Promise<DeliveryRow | null> {
    const claimAt = now();
    return db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(eq(issueQuestionResponseDeliveries.interactionId, interactionId))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !current ||
        ["delivered", "fallback_queued", "failed"].includes(current.status)
      )
        return null;
      if (
        current.status === "delivering" &&
        current.lastAttemptAt &&
        current.lastAttemptAt.getTime() > claimAt.getTime() - claimStaleMs
      )
        return null;
      return tx
        .update(issueQuestionResponseDeliveries)
        .set({
          status: "delivering",
          attemptCount: sql`${issueQuestionResponseDeliveries.attemptCount} + 1`,
          lastAttemptAt: claimAt,
          updatedAt: claimAt,
        })
        .where(eq(issueQuestionResponseDeliveries.id, current.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
  }

  async function terminalOutcome(
    interactionId: string,
  ): Promise<QuestionResponseDeliveryOutcome | null> {
    const row = await db
      .select()
      .from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, interactionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !row ||
      !["delivered", "fallback_queued", "failed"].includes(row.status)
    )
      return null;
    return {
      deliveryId: row.id,
      status: row.status,
      mode: row.deliveryMode,
      targetRunId: row.targetRunId,
      targetTurnId: row.targetTurnId,
      duplicate: true,
    };
  }

  async function recordTerminal(input: {
    delivery: DeliveryRow;
    interaction: QuestionInteractionRow;
    status: "delivered" | "fallback_queued" | "failed";
    mode: "steered" | "coalesced" | "wake_fallback" | null;
    targetRunId: string | null;
    targetTurnId?: string | null;
    adapter: string;
    errorCode?: string | null;
  }): Promise<QuestionResponseDeliveryOutcome> {
    const at = now();
    const updated = await db.transaction(async (tx) => {
      const row = await tx
        .update(issueQuestionResponseDeliveries)
        .set({
          status: input.status,
          deliveryMode: input.mode,
          targetRunId: input.targetRunId,
          targetTurnId: input.targetTurnId ?? null,
          acknowledgedAt: input.status === "failed" ? null : at,
          lastErrorCode: input.errorCode ?? null,
          updatedAt: at,
        })
        .where(
          and(
            eq(issueQuestionResponseDeliveries.id, input.delivery.id),
            eq(issueQuestionResponseDeliveries.status, "delivering"),
            eq(
              issueQuestionResponseDeliveries.attemptCount,
              input.delivery.attemptCount,
            ),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      await logActivity(tx as unknown as Db, {
        companyId: input.interaction.companyId,
        actorType: "system",
        actorId: "question-response-delivery",
        agentId: input.interaction.resolvedByAgentId,
        runId: input.targetRunId,
        action:
          input.status === "failed"
            ? "issue.question_response_delivery_failed"
            : "issue.question_response_delivered",
        entityType: "issue",
        entityId: input.interaction.issueId,
        details: {
          deliveryId: row.id,
          interactionId: input.interaction.id,
          sourceRunId: input.interaction.sourceRunId,
          targetRunId: input.targetRunId,
          targetTurnId: input.targetTurnId ?? null,
          correlationId: row.correlationId,
          payloadSha256: row.payloadSha256,
          deliveryStatus: input.status,
          deliveryMode: input.mode,
          adapter: input.adapter,
          errorCode: input.errorCode ?? null,
        },
      });
      return row;
    });

    const persisted =
      updated ??
      (await db
        .select()
        .from(issueQuestionResponseDeliveries)
        .where(eq(issueQuestionResponseDeliveries.id, input.delivery.id))
        .limit(1)
        .then((rows) => rows[0] ?? null));
    const result: DeliveryRow = persisted ?? input.delivery;
    if (updated) {
      getTelemetryClient()?.trackDynamic("question_response.delivery", {
        adapter: input.adapter,
        outcome: input.mode ?? "failed",
      });
    }
    return {
      deliveryId: result.id,
      status: result.status,
      mode: result.deliveryMode,
      targetRunId: result.targetRunId,
      targetTurnId: result.targetTurnId,
      duplicate: !updated,
    };
  }

  async function releaseForRetry(
    delivery: DeliveryRow,
    errorCode: string,
    options: { bounded: boolean } = { bounded: true },
  ) {
    const at = now();
    const nextErrorCount = delivery.errorCount + (options.bounded ? 1 : 0);
    const exhausted =
      options.bounded && nextErrorCount >= MAX_DELIVERY_ATTEMPTS;
    await db
      .update(issueQuestionResponseDeliveries)
      .set({
        // Keep an exhausted claim owned until recordTerminal commits its outcome.
        status: exhausted ? "delivering" : "pending",
        ...(options.bounded ? { errorCount: nextErrorCount } : {}),
        lastErrorCode: errorCode,
        updatedAt: at,
      })
      .where(
        and(
          eq(issueQuestionResponseDeliveries.id, delivery.id),
          eq(issueQuestionResponseDeliveries.status, "delivering"),
          eq(
            issueQuestionResponseDeliveries.attemptCount,
            delivery.attemptCount,
          ),
        ),
      );
    return exhausted;
  }

  async function withClaimLease<T>(
    delivery: DeliveryRow,
    operation: () => Promise<T>,
  ): Promise<T> {
    let stopped = false;
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal
        .then(async () => {
          if (stopped) return;
          const renewedAt = now();
          const renewed = await db
            .update(issueQuestionResponseDeliveries)
            .set({
              lastAttemptAt: renewedAt,
              updatedAt: renewedAt,
            })
            .where(
              and(
                eq(issueQuestionResponseDeliveries.id, delivery.id),
                eq(issueQuestionResponseDeliveries.status, "delivering"),
                eq(
                  issueQuestionResponseDeliveries.attemptCount,
                  delivery.attemptCount,
                ),
              ),
            )
            .returning({ id: issueQuestionResponseDeliveries.id });
          if (renewed.length === 0) stopped = true;
        })
        .catch((error) => {
          logger.warn(
            { err: error, deliveryId: delivery.id },
            "question response claim lease renewal failed",
          );
        });
    }, claimRefreshMs);
    timer.unref?.();
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    } finally {
      stopped = true;
      clearInterval(timer);
      await renewal;
    }

    // `attemptCount` is the claim generation. A stale worker must not continue
    // after a sweep has reclaimed the row for a newer attempt, even if its
    // external side effect eventually resolves. Confirm ownership after the
    // side effect so a rejected native steer cannot fall through to a second
    // wake after losing its claim.
    let ownsClaim = false;
    try {
      ownsClaim = await db
        .select({ id: issueQuestionResponseDeliveries.id })
        .from(issueQuestionResponseDeliveries)
        .where(
          and(
            eq(issueQuestionResponseDeliveries.id, delivery.id),
            eq(issueQuestionResponseDeliveries.status, "delivering"),
            eq(
              issueQuestionResponseDeliveries.attemptCount,
              delivery.attemptCount,
            ),
          ),
        )
        .limit(1)
        .then((rows) => rows.length === 1);
    } catch (error) {
      logger.warn(
        { err: error, deliveryId: delivery.id },
        "question response claim ownership check failed",
      );
      throw new DeliveryClaimUnavailableError();
    }
    if (!ownsClaim) throw new DeliveryClaimUnavailableError();
    if (operationError !== undefined) throw operationError;
    return result as T;
  }

  async function findDurableWakeRequest(input: {
    companyId: string;
    idempotencyKey: string;
  }) {
    const request = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        id: agentWakeupRequests.id,
        runId: agentWakeupRequests.runId,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
          inArray(agentWakeupRequests.status, [
            ...DURABLE_WAKE_REQUEST_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(agentWakeupRequests.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!request?.runId) return request ? { request, run: null } : null;
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, request.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, request.agentId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return { request, run };
  }

  async function sameCompanyAgent(
    reader: Db,
    companyId: string,
    agentId: string | null | undefined,
  ): Promise<string | null> {
    if (!agentId) return null;
    const row = await reader
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row && row.status !== "terminated" ? row.id : null;
  }

  async function resolveAnswerTarget(
    reader: Db,
    issue: IssueRow,
    interaction: QuestionInteractionRow,
  ): Promise<AnswerTarget> {
    if (issue.assigneeAgentId)
      return { kind: "assignee", agentId: issue.assigneeAgentId };
    const unavailable = (errorCode: string): AnswerTarget => ({
      kind: "unavailable",
      errorCode,
    });
    if (issue.status !== "in_review" && issue.status !== "in_progress")
      return unavailable("question_response_target_unavailable");
    const state = parseIssueExecutionState(issue.executionState);
    const asker = await sameCompanyAgent(
      reader,
      interaction.companyId,
      interaction.createdByAgentId,
    );
    const returnAgent = await sameCompanyAgent(
      reader,
      interaction.companyId,
      state?.returnAssignee?.type === "agent"
        ? state.returnAssignee.agentId
        : null,
    );
    const agentId = asker ?? returnAgent;
    if (!agentId) return unavailable("question_response_target_unavailable");
    if (state?.status !== "pending" || !state.currentStageId) {
      // A human who holds the issue and did not answer keeps it; another user's
      // answer must not take the work from the person doing it.
      if (
        issue.assigneeUserId &&
        issue.assigneeUserId !== interaction.resolvedByUserId
      )
        return { kind: "held", errorCode: "question_response_assignee_pending" };
      return { kind: "hand_back", agentId, via: "unstaged" };
    }

    // A pending review or approval stage. It is the question's own disposition only
    // when (a) the stage would hand back to the asker and (b) the person answering is
    // the person the stage waits on. Any other stage is a real review; the answer must
    // not skip it.
    const participant = state.currentParticipant;
    if (
      agentId !== returnAgent ||
      !interaction.resolvedByUserId ||
      participant?.type !== "user" ||
      participant.userId !== interaction.resolvedByUserId
    )
      return { kind: "held", errorCode: "question_response_review_pending" };
    return { kind: "hand_back", agentId, via: "review_stage" };
  }

  /**
   * Gives the issue back to the agent that asked, under the row lock, re-checking the
   * target against the locked row. `review_stage` records the answerer's
   * `changes_requested` decision through the execution policy's own transition (so the stage is
   * returned, not wiped); `unstaged` is the assignment a harness checkout would make.
   */
  async function handBackToAsker(
    issueId: string,
    interaction: QuestionInteractionRow,
    target: Extract<AnswerTarget, { kind: "hand_back" }>,
  ): Promise<boolean> {
    const { issueService } = await import("./issues.js");
    return db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(issues)
        .where(
          and(eq(issues.id, issueId), eq(issues.companyId, interaction.companyId)),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!locked) return false;
      const again = await resolveAnswerTarget(
        tx as unknown as Db,
        locked,
        interaction,
      );
      if (again.kind === "assignee") return again.agentId === target.agentId;
      if (
        again.kind !== "hand_back" ||
        again.agentId !== target.agentId ||
        again.via !== target.via
      )
        return false;

      let patch: Record<string, unknown>;
      if (target.via === "review_stage") {
        const policy = normalizeIssueExecutionPolicy(
          locked.executionPolicy ?? null,
        );
        const body = interaction.title
          ? `Answered the question card "${interaction.title}"; the work goes back to the agent that asked.`
          : "Answered the question card; the work goes back to the agent that asked.";
        const transition = applyIssueExecutionPolicyTransition({
          issue: locked,
          policy,
          previousPolicy: policy,
          requestedStatus: "in_progress",
          requestedAssigneePatch: {},
          actor: { agentId: null, userId: interaction.resolvedByUserId },
          commentBody: body,
        });
        if (
          !transition.decision ||
          transition.patch.assigneeAgentId !== target.agentId
        )
          return false;
        const decisionId = randomUUID();
        patch = {
          ...transition.patch,
          executionState: {
            ...(transition.patch.executionState as Record<string, unknown>),
            lastDecisionId: decisionId,
          },
        };
        await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: locked.companyId,
          issueId: locked.id,
          stageId: transition.decision.stageId,
          stageType: transition.decision.stageType,
          actorAgentId: null,
          actorUserId: interaction.resolvedByUserId,
          outcome: transition.decision.outcome,
          body: transition.decision.body,
          createdByRunId: null,
        });
      } else {
        patch = {
          status: "in_progress",
          assigneeAgentId: target.agentId,
          assigneeUserId: null,
        };
      }
      await issueService(tx as unknown as Db).update(
        locked.id,
        {
          ...patch,
          actorAgentId: null,
          actorUserId: interaction.resolvedByUserId ?? null,
          companyGuard: locked.companyId,
        },
        tx,
      );
      await logActivity(tx as unknown as Db, {
        companyId: locked.companyId,
        actorType: "system",
        actorId: "question-response-delivery",
        agentId: target.agentId,
        action: "issue.question_response_handed_back",
        entityType: "issue",
        entityId: locked.id,
        details: {
          interactionId: interaction.id,
          agentId: target.agentId,
          via: target.via,
          fromUserId: locked.assigneeUserId,
        },
      });
      return true;
    });
  }

  /**
   * Whether an earlier attempt gave the issue back for this answer. A retry sees the
   * asker as the plain assignee, so the hand back's own activity row, written in the
   * same transaction as the reassignment, is the durable record of it.
   */
  async function wasHandedBack(interaction: QuestionInteractionRow) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, interaction.companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, interaction.issueId),
          eq(activityLog.action, "issue.question_response_handed_back"),
          sql`${activityLog.details}->>'interactionId' = ${interaction.id}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function deliver(
    interactionId: string,
  ): Promise<QuestionResponseDeliveryOutcome | null> {
    const claimed = await claim(interactionId);
    if (!claimed) return terminalOutcome(interactionId);

    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.companyId, claimed.companyId),
          eq(issueThreadInteractions.issueId, claimed.issueId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !interaction ||
      interaction.kind !== "ask_user_questions" ||
      interaction.status !== "answered"
    ) {
      return recordTerminal({
        delivery: claimed,
        interaction:
          interaction ??
          ({
            id: interactionId,
            companyId: claimed.companyId,
            issueId: claimed.issueId,
            sourceRunId: claimed.sourceRunId,
            resolvedByAgentId: null,
          } as QuestionInteractionRow),
        status: "failed",
        mode: null,
        targetRunId: null,
        adapter: "unknown",
        errorCode: "question_response_interaction_invalid",
      });
    }

    const [issue, agent, sourceRun, externalInteractionPublication] =
      await Promise.all([
        db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, interaction.issueId),
              eq(issues.companyId, interaction.companyId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null),
        interaction.createdByAgentId
          ? db
              .select({ adapterType: agents.adapterType })
              .from(agents)
              .where(
                and(
                  eq(agents.id, interaction.createdByAgentId),
                  eq(agents.companyId, interaction.companyId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
        interaction.sourceRunId
          ? db
              .select()
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.id, interaction.sourceRunId),
                  eq(heartbeatRuns.companyId, interaction.companyId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
        db
          .select({ id: chatPublications.id })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, interaction.companyId),
              eq(chatPublications.issueId, interaction.issueId),
              eq(
                sql<string>`${chatPublications.payload}->>'interactionId'`,
                interaction.id,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);
    const adapter = agent?.adapterType ?? "unknown";
    const answerTarget =
      issue && issue.status !== "done" && issue.status !== "cancelled"
        ? await resolveAnswerTarget(db, issue, interaction)
        : null;
    if (!issue || !answerTarget || answerTarget.kind === "unavailable") {
      return recordTerminal({
        delivery: claimed,
        interaction,
        status: "failed",
        mode: null,
        targetRunId: null,
        adapter,
        errorCode: !issue
          ? "question_response_issue_missing"
          : answerTarget?.kind === "unavailable"
            ? answerTarget.errorCode
            : "question_response_target_unavailable",
      });
    }
    if (answerTarget.kind === "held") {
      // Someone else holds the issue. Keep the saved answer pending, unbounded like
      // the other availability states, so the sweep delivers it once they let go.
      await releaseForRetry(claimed, answerTarget.errorCode, { bounded: false });
      return null;
    }
    const assigneeAgentId = answerTarget.agentId;
    const inferredSourceCommentId =
      sourceRun && issueIdFromRun(sourceRun) === interaction.issueId
        ? sourceCommentIdFromRun(sourceRun)
        : null;
    const sourceCommentCandidate =
      interaction.sourceCommentId ?? inferredSourceCommentId;
    const continuationSourceCommentId = sourceCommentCandidate
      ? await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.id, sourceCommentCandidate),
              eq(issueComments.companyId, interaction.companyId),
              eq(issueComments.issueId, interaction.issueId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]?.id ?? null)
      : null;

    const liveRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, interaction.companyId),
          eq(heartbeatRuns.agentId, assigneeAgentId),
          inArray(heartbeatRuns.status, [
            "queued",
            "running",
            "scheduled_retry",
          ]),
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt));
    const issueRuns = liveRuns.filter(
      (run) => issueIdFromRun(run) === interaction.issueId,
    );
    const issueRunIds = issueRuns.map((run) => run.id);
    const interactionIdsFromRunContext = issueRuns
      .map((run) => compactLine(record(run.contextSnapshot).interactionId))
      .filter((value): value is string => Boolean(value));
    const deliveryDerivedRuns =
      issueRunIds.length > 0
        ? await db
            .select({
              interactionId: issueQuestionResponseDeliveries.interactionId,
              targetRunId: issueQuestionResponseDeliveries.targetRunId,
            })
            .from(issueQuestionResponseDeliveries)
            .where(
              and(
                eq(
                  issueQuestionResponseDeliveries.companyId,
                  interaction.companyId,
                ),
                inArray(
                  issueQuestionResponseDeliveries.targetRunId,
                  issueRunIds,
                ),
                inArray(issueQuestionResponseDeliveries.status, [
                  "delivering",
                  "delivered",
                  "fallback_queued",
                ]),
              ),
            )
        : [];
    const derivedInteractionIds = [
      ...new Set([
        ...interactionIdsFromRunContext,
        ...deliveryDerivedRuns.map((row) => row.interactionId),
      ]),
    ];
    const externallyPublishedInteractions =
      derivedInteractionIds.length > 0
        ? await db
            .select({
              interactionId: sql<string>`${chatPublications.payload}->>'interactionId'`,
            })
            .from(chatPublications)
            .where(
              and(
                eq(chatPublications.companyId, interaction.companyId),
                eq(chatPublications.issueId, interaction.issueId),
                inArray(chatPublications.state, [
                  "published",
                  "streaming",
                  "delivery_unknown",
                ]),
                inArray(
                  sql<string>`${chatPublications.payload}->>'interactionId'`,
                  derivedInteractionIds,
                ),
              ),
            )
        : [];
    const externalInteractionIds = new Set(
      externallyPublishedInteractions.map((row) => row.interactionId),
    );
    const externallyDerivedRunIds = new Set([
      ...issueRuns
        .filter((run) => {
          const interactionId = compactLine(
            record(run.contextSnapshot).interactionId,
          );
          return Boolean(
            interactionId && externalInteractionIds.has(interactionId),
          );
        })
        .map((run) => run.id),
      ...deliveryDerivedRuns
        .filter((row) => externalInteractionIds.has(row.interactionId))
        .map((row) => row.targetRunId)
        .filter((runId): runId is string => Boolean(runId)),
    ]);
    // A run already carrying any external-chat turn is not a safe target for
    // another interaction's answer. Without per-output causality, steering or
    // coalescing would mix both turns and could disclose one provider's work
    // through another provider bot. Use a dedicated continuation instead.
    const externalChatBoundary =
      Boolean(externalInteractionPublication) ||
      hasExternalChatOrigin(sourceRun) ||
      issueRuns.some(hasExternalChatOrigin) ||
      externallyDerivedRunIds.size > 0;
    // `executionRunId` is the issue's authoritative active-run pointer. Fall
    // back to the newest matching running row only for legacy/racy rows where
    // the pointer has not been populated yet; choosing the oldest stale row
    // could steer an answer into the wrong provider turn.
    const successorRunning =
      (issue.executionRunId
        ? issueRuns.find(
            (run) =>
              run.id === issue.executionRunId &&
              run.status === "running" &&
              run.id !== interaction.sourceRunId,
          )
        : null) ??
      [...issueRuns]
        .reverse()
        .find(
          (run) =>
            run.status === "running" && run.id !== interaction.sourceRunId,
        ) ??
      null;
    const queuedSuccessor =
      issueRuns.find(
        (run) =>
          (run.status === "queued" || run.status === "scheduled_retry") &&
          run.id !== interaction.sourceRunId,
      ) ?? null;
    const hydratedInteraction = hydrateQuestionInteraction(interaction);
    const envelope = buildQuestionResponseDeliveryEnvelope(hydratedInteraction);
    if (nativeSha256(envelope) !== claimed.payloadSha256) {
      return recordTerminal({
        delivery: claimed,
        interaction,
        status: "failed",
        mode: null,
        targetRunId: null,
        adapter,
        errorCode: "question_response_payload_digest_mismatch",
      });
    }

    // Give the issue back before any delivery path can take the answer. A live native
    // question session marks the answer delivered on its own, so a hand back that runs
    // after it would never run, and the issue would stay with the human.
    if (answerTarget.kind === "hand_back") {
      let handedBack: boolean;
      try {
        handedBack = await withClaimLease(claimed, () =>
          handBackToAsker(issue.id, interaction, answerTarget),
        );
      } catch (error) {
        if (error instanceof DeliveryClaimUnavailableError)
          return terminalOutcome(interactionId);
        throw error;
      }
      if (!handedBack) {
        // The issue moved under us (someone else took it or decided the stage).
        // Re-read it on the next attempt rather than deliver against a stale picture.
        await releaseForRetry(claimed, "question_response_target_changed");
        return null;
      }
    }

    // A provider input request can keep its source process alive while it waits
    // for an answer in either runtime mode. External chat answers intentionally
    // continue in a fresh run so output from overlapping provider turns cannot
    // be mixed. The old process must therefore release both the per-agent
    // runner slot and the issue execution lock before the isolated continuation
    // is enqueued. In particular, ACPX-backed local adapters may still persist
    // as `legacy` runs even though their interaction is provider-native.
    if (
      externalChatBoundary &&
      sourceRun?.id === interaction.sourceRunId &&
      (sourceRun.status === "queued" || sourceRun.status === "running")
    ) {
      try {
        await withClaimLease(claimed, () =>
          options.heartbeat.cancelRun(
            sourceRun.id,
            "Superseded by a dedicated external-chat answer continuation",
            {
              errorCode: "external_chat_continuation",
              resultJson: {
                interactionId: interaction.id,
                externalChatContinuation: true,
              },
              eventMessage:
                "source run cancelled for isolated external-chat answer continuation",
              eventPayload: { interactionId: interaction.id },
              terminationGraceMs: 2_000,
              suppressImmediateRecovery: true,
            },
          ),
        );
      } catch (error) {
        if (error instanceof DeliveryClaimUnavailableError)
          return terminalOutcome(interactionId);
        const errorCode =
          error instanceof Error && compactLine(error.message)
            ? compactLine(error.message)!.slice(0, 160)
            : "external_chat_source_run_cancellation_failed";
        const exhausted = await releaseForRetry(claimed, errorCode);
        logger.warn(
          {
            err: error,
            deliveryId: claimed.id,
            interactionId,
            sourceRunId: sourceRun.id,
            attemptCount: claimed.attemptCount,
            errorCount: claimed.errorCount + 1,
            exhausted,
          },
          "external-chat answer continuation will retry after source run cancellation failure",
        );
        if (!exhausted) return null;
        return recordTerminal({
          delivery: claimed,
          interaction,
          status: "failed",
          mode: null,
          targetRunId: sourceRun.id,
          adapter,
          errorCode,
        });
      }
    }

    if (resolveNativeQuestion && !externalChatBoundary) {
      try {
        const nativeDisposition = await withClaimLease(claimed, () =>
          resolveNativeQuestion(hydratedInteraction),
        );
        if (nativeDisposition === "queued") {
          return recordTerminal({
            delivery: claimed,
            interaction,
            status: "delivered",
            mode: "steered",
            targetRunId: interaction.sourceRunId,
            adapter,
          });
        }
        if (nativeDisposition === "pending") {
          await releaseForRetry(
            claimed,
            "native_question_session_unavailable",
            { bounded: false },
          );
          return null;
        }
      } catch (error) {
        if (error instanceof DeliveryClaimUnavailableError)
          return terminalOutcome(interactionId);
        const errorCode =
          error instanceof Error && compactLine(error.message)
            ? compactLine(error.message)!.slice(0, 160)
            : "native_question_delivery_failed";
        const exhausted = await releaseForRetry(claimed, errorCode);
        logger.warn(
          {
            err: error,
            deliveryId: claimed.id,
            interactionId,
            attemptCount: claimed.attemptCount,
            errorCount: claimed.errorCount + 1,
            exhausted,
          },
          "native question response delivery will retry",
        );
        if (!exhausted) return null;
        // An issue this answer already handed back is the agent's now; failing here
        // would leave the human's issue with an agent that never heard the answer.
        // Let the continuation wake below carry it instead.
        if (
          answerTarget.kind !== "hand_back" &&
          !(await wasHandedBack(interaction))
        ) {
          return recordTerminal({
            delivery: claimed,
            interaction,
            status: "failed",
            mode: null,
            targetRunId: interaction.sourceRunId,
            adapter,
            errorCode,
          });
        }
      }
    }

    // An answer to an older question is new input, not implicit permission to
    // steer another active turn. Only the queue's explicit Steer action delivers it.
    const steeringErrorCode = successorRunning && externalChatBoundary
      ? "steering_external_chat_context_incompatible" : null;

    const actor = actorForInteraction(interaction);
    // This is a new, migration-fenced namespace. The partial unique index on
    // agent_wakeup_requests makes the wake transaction itself idempotent, so a
    // reclaimed stale worker cannot create a second continuation run.
    const wakeIdempotencyKey = `question-response:${interaction.id}`;
    try {
      const existingWake = await findDurableWakeRequest({
        companyId: interaction.companyId,
        idempotencyKey: wakeIdempotencyKey,
      });
      const wakeRun =
        existingWake?.run ??
        (existingWake
          ? null
          : await withClaimLease(claimed, () =>
              options.heartbeat.wakeup(assigneeAgentId, {
                source: "automation",
                triggerDetail: "system",
                reason: "issue_commented",
                payload: {
                  issueId: issue.id,
                  interactionId: interaction.id,
                  interactionKind: interaction.kind,
                  interactionStatus: interaction.status,
                  sourceCommentId: continuationSourceCommentId,
                  sourceRunId: interaction.sourceRunId,
                  externalChatContinuation: externalChatBoundary,
                  ...(continuationSourceCommentId
                    ? {
                        wakeCommentId: continuationSourceCommentId,
                        wakeCommentIds: [continuationSourceCommentId],
                      }
                    : {}),
                  mutation: "interaction",
                },
                idempotencyKey: wakeIdempotencyKey,
                allowRunCoalescing: !externalChatBoundary,
                requestedByActorType: actor.actorType,
                requestedByActorId: actor.actorId,
                contextSnapshot: {
                  issueId: issue.id,
                  taskId: issue.id,
                  interactionId: interaction.id,
                  interactionKind: interaction.kind,
                  interactionStatus: interaction.status,
                  sourceCommentId: continuationSourceCommentId,
                  sourceRunId: interaction.sourceRunId,
                  externalChatContinuation: externalChatBoundary,
                  ...(continuationSourceCommentId
                    ? {
                        wakeCommentId: continuationSourceCommentId,
                        wakeCommentIds: [continuationSourceCommentId],
                      }
                    : {}),
                  wakeReason: "issue_commented",
                  source: "issue.interaction.respond",
                },
              }),
            ));
      const durableWake =
        existingWake ??
        (wakeRun
          ? null
          : await findDurableWakeRequest({
              companyId: interaction.companyId,
              idempotencyKey: wakeIdempotencyKey,
            }));
      if (!wakeRun && !durableWake) {
        const errorCode = "question_response_wake_skipped";
        // Scheduling suppression is an availability state, not a delivery
        // failure. Keep the durable receipt retryable until the suppression is
        // lifted; the bounded limit remains reserved for actual wake errors.
        await releaseForRetry(claimed, errorCode, { bounded: false });
        return null;
      }
      const eligibleQueuedSuccessor = externalChatBoundary
        ? null
        : queuedSuccessor;
      const targetRun =
        wakeRun ?? durableWake?.run ?? eligibleQueuedSuccessor ?? null;
      const coalesced = Boolean(
        eligibleQueuedSuccessor && targetRun?.id === eligibleQueuedSuccessor.id,
      );
      return recordTerminal({
        delivery: claimed,
        interaction,
        status: coalesced ? "delivered" : "fallback_queued",
        mode: coalesced ? "coalesced" : "wake_fallback",
        targetRunId: targetRun?.id ?? null,
        adapter: targetRun?.driverKind ?? adapter,
        errorCode: steeringErrorCode,
      });
    } catch (error) {
      if (error instanceof DeliveryClaimUnavailableError)
        return terminalOutcome(interactionId);
      if (
        isUniqueViolation(error, QUESTION_RESPONSE_WAKE_IDEMPOTENCY_CONSTRAINT)
      ) {
        // A concurrent claimant won the transactional wake fence after our
        // preflight lookup. Reuse its committed receipt instead of consuming
        // an error retry or issuing another continuation.
        const durableWake = await findDurableWakeRequest({
          companyId: interaction.companyId,
          idempotencyKey: wakeIdempotencyKey,
        });
        if (durableWake) {
          const eligibleQueuedSuccessor = externalChatBoundary
            ? null
            : queuedSuccessor;
          const targetRun = durableWake.run ?? eligibleQueuedSuccessor ?? null;
          const coalesced = Boolean(
            eligibleQueuedSuccessor &&
            targetRun?.id === eligibleQueuedSuccessor.id,
          );
          return recordTerminal({
            delivery: claimed,
            interaction,
            status: coalesced ? "delivered" : "fallback_queued",
            mode: coalesced ? "coalesced" : "wake_fallback",
            targetRunId: targetRun?.id ?? null,
            adapter: targetRun?.driverKind ?? adapter,
            errorCode: steeringErrorCode,
          });
        }
      }
      const errorCode =
        error instanceof Error && compactLine(error.message)
          ? compactLine(error.message)!.slice(0, 160)
          : "question_response_wake_failed";
      const exhausted = await releaseForRetry(claimed, errorCode);
      logger.warn(
        {
          err: error,
          deliveryId: claimed.id,
          interactionId,
          attemptCount: claimed.attemptCount,
          errorCount: claimed.errorCount + 1,
          exhausted,
        },
        "question response delivery will retry after wake failure",
      );
      if (!exhausted) return null;
      return recordTerminal({
        delivery: claimed,
        interaction,
        status: "failed",
        mode: null,
        targetRunId: null,
        adapter,
        errorCode,
      });
    }
  }

  async function sweepPending(limit = 50) {
    const sweepAt = now();
    const staleAt = new Date(sweepAt.getTime() - claimStaleMs);
    await db
      .update(issueQuestionResponseDeliveries)
      .set({
        status: "pending",
        updatedAt: sweepAt,
      })
      .where(
        and(
          eq(issueQuestionResponseDeliveries.status, "delivering"),
          or(
            isNull(issueQuestionResponseDeliveries.lastAttemptAt),
            lte(issueQuestionResponseDeliveries.lastAttemptAt, staleAt),
          ),
        ),
      );
    const ids = await db
      .select({ interactionId: issueQuestionResponseDeliveries.interactionId })
      .from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.status, "pending"))
      // Least recently attempted first. A held answer stays pending for as long as its
      // person keeps the issue; ordering by age alone would let a full page of them
      // take every sweep and starve newer answers that are ready now.
      .orderBy(
        sql`${issueQuestionResponseDeliveries.lastAttemptAt} asc nulls first`,
        asc(issueQuestionResponseDeliveries.createdAt),
      )
      .limit(limit)
      .then((rows) => rows.map((row) => row.interactionId));
    const counts = {
      scanned: ids.length,
      steered: 0,
      coalesced: 0,
      wakeFallback: 0,
      failed: 0,
    };
    for (const id of ids) {
      const outcome = await deliver(id);
      if (outcome?.mode === "steered") counts.steered += 1;
      else if (outcome?.mode === "coalesced") counts.coalesced += 1;
      else if (outcome?.mode === "wake_fallback") counts.wakeFallback += 1;
      else if (outcome?.status === "failed") counts.failed += 1;
    }
    return counts;
  }

  return { deliver, sweepPending };
}
