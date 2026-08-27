import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issueQuestionResponseDeliveries,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import type {
  AskUserQuestionsInteraction,
  PaperclipQuestionSetPayload,
} from "@paperclipai/shared";
import type {
  PaperclipQuestionResponse,
} from "../vendor/paperclip-runner/index.js";
import { isUniqueViolation } from "../db-errors.js";
import { getTelemetryClient } from "../telemetry.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";
import { nativeSha256 } from "./native-runtime/canonical.js";

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
type DeliveryRow = typeof issueQuestionResponseDeliveries.$inferSelect;
type Heartbeat = Pick<ReturnType<typeof heartbeatService>, "wakeup">;
type QuestionResponseSteer = (input: {
  runId: string;
  message: string;
  correlationId: string;
}) => Promise<{ turnId?: string | null }>;

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
  /** Optional native steering seam. Direct adapters use the durable wake fallback. */
  steer?: QuestionResponseSteer;
  now?: () => Date;
  /** Test-only lease timings. Production callers use the bounded defaults. */
  claimStaleMs?: number;
  claimRefreshMs?: number;
}

function readSteeringErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "steering_rejected";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function canonicalQuestionSet(interaction: Pick<AskUserQuestionsInteraction, "title" | "payload">): PaperclipQuestionSetPayload {
  if (interaction.payload.questionSet) return structuredClone(interaction.payload.questionSet);
  return {
    schema: "paperclip.question_set.v1",
    ...(interaction.title ? { title: interaction.title } : {}),
    ...(interaction.payload.submitLabel ? { submitLabel: interaction.payload.submitLabel } : {}),
    questions: interaction.payload.questions.map((question) => {
      const customOption = question.options.find((option) => option.freeText === true);
      return {
        id: question.id,
        prompt: question.prompt,
        ...(question.helpText ? { helpText: question.helpText } : {}),
        required: question.required === true,
        answerMode: question.selectionMode === "multi" ? "multi_select" as const : "single_select" as const,
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
                ...(customOption.description ? { placeholder: customOption.description } : {}),
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
  if (interaction.status !== "answered" || !interaction.result || interaction.result.cancelled === true) {
    throw new Error("question_response_interaction_not_answered");
  }
  const questionSet = canonicalQuestionSet(interaction);
  const questionById = new Map(questionSet.questions.map((question) => [question.id, question]));
  const response: PaperclipQuestionResponse = {
    schema: "paperclip.question_response.v1",
    answers: Object.fromEntries(interaction.result.answers.map((answer) => {
      const question = questionById.get(answer.questionId);
      return [answer.questionId, question?.answerMode === "text"
        ? { ...(answer.otherText ? { text: answer.otherText } : {}) }
        : {
            selectedOptionIds: answer.optionIds,
            ...(answer.otherText ? { customText: answer.otherText } : {}),
          }];
    })),
  };
  return {
    schema: "paperclip.question_response_delivery.v1",
    interactionId: interaction.id,
    sourceRunId: interaction.sourceRunId ?? null,
    questionSet,
    response,
  };
}

function questionAnswerLines(envelope: QuestionResponseDeliveryEnvelope): string[] {
  const lines: string[] = [];
  for (const question of envelope.questionSet.questions) {
    const answer = envelope.response.answers[question.id];
    if (!answer) continue;
    const optionLabelById = new Map((question.options ?? []).map((option) => [option.id, option.label]));
    const values = (answer.selectedOptionIds ?? []).map((optionId) => optionLabelById.get(optionId) ?? optionId);
    const text = compactLine(answer.text);
    const customText = compactLine(answer.customText);
    if (text) values.push(text);
    if (customText) values.push(customText);
    const header = compactLine(question.header);
    const prompt = compactLine(question.prompt);
    const label = header && prompt && header !== prompt
      ? `${header} — ${prompt}`
      : header ?? prompt ?? question.id;
    lines.push(`- ${label}: ${values.join(", ") || "No answer"}`);
  }
  return lines;
}

export function formatQuestionResponseSummary(envelope: QuestionResponseDeliveryEnvelope): string {
  const lines = questionAnswerLines(envelope);
  return lines.length > 0
    ? ["Resolved questions and answers:", ...lines].join("\n")
    : "Resolved questions and answers.";
}

export function formatDurableQuestionResponseSummary(interaction: AskUserQuestionsInteraction): string {
  const existing = compactLine(interaction.result?.summaryMarkdown);
  return existing ?? formatQuestionResponseSummary(buildQuestionResponseDeliveryEnvelope(interaction));
}

export function formatQuestionResponseSteeringMessage(envelope: QuestionResponseDeliveryEnvelope): string {
  const lines = questionAnswerLines(envelope);
  return lines.length > 0
    ? ["Answered questions", "", ...lines].join("\n")
    : "Answered questions";
}

function hydrateQuestionInteraction(row: QuestionInteractionRow): AskUserQuestionsInteraction {
  return {
    ...row,
    kind: "ask_user_questions",
    status: row.status as AskUserQuestionsInteraction["status"],
    continuationPolicy: row.continuationPolicy as AskUserQuestionsInteraction["continuationPolicy"],
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

export function questionResponseDeliveryValues(interaction: AskUserQuestionsInteraction) {
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

function issueIdFromRun(run: Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot">) {
  const context = record(run.contextSnapshot);
  return compactLine(context.issueId) ?? compactLine(context.taskId);
}

function actorForInteraction(interaction: QuestionInteractionRow) {
  if (interaction.resolvedByUserId) {
    return { actorType: "user" as const, actorId: interaction.resolvedByUserId };
  }
  if (interaction.resolvedByAgentId) {
    return { actorType: "agent" as const, actorId: interaction.resolvedByAgentId };
  }
  return { actorType: "system" as const, actorId: "question-response-outbox" };
}

export function questionResponseDeliveryService(
  db: Db,
  options: QuestionResponseDeliveryServiceOptions,
) {
  const steer = options.steer;
  const now = options.now ?? (() => new Date());
  const claimStaleMs = Math.max(2, options.claimStaleMs ?? DELIVERY_CLAIM_STALE_MS);
  const claimRefreshMs = Math.max(
    1,
    Math.min(options.claimRefreshMs ?? DELIVERY_CLAIM_REFRESH_MS, Math.floor(claimStaleMs / 2)),
  );

  async function claim(interactionId: string): Promise<DeliveryRow | null> {
    const claimAt = now();
    return db.transaction(async (tx) => {
      const current = await tx.select()
        .from(issueQuestionResponseDeliveries)
        .where(eq(issueQuestionResponseDeliveries.interactionId, interactionId))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!current || ["delivered", "fallback_queued", "failed"].includes(current.status)) return null;
      if (
        current.status === "delivering"
        && current.lastAttemptAt
        && current.lastAttemptAt.getTime() > claimAt.getTime() - claimStaleMs
      ) return null;
      return tx.update(issueQuestionResponseDeliveries).set({
        status: "delivering",
        attemptCount: sql`${issueQuestionResponseDeliveries.attemptCount} + 1`,
        lastAttemptAt: claimAt,
        updatedAt: claimAt,
      }).where(eq(issueQuestionResponseDeliveries.id, current.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
  }

  async function terminalOutcome(interactionId: string): Promise<QuestionResponseDeliveryOutcome | null> {
    const row = await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, interactionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row || !["delivered", "fallback_queued", "failed"].includes(row.status)) return null;
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
      const row = await tx.update(issueQuestionResponseDeliveries).set({
        status: input.status,
        deliveryMode: input.mode,
        targetRunId: input.targetRunId,
        targetTurnId: input.targetTurnId ?? null,
        acknowledgedAt: input.status === "failed" ? null : at,
        lastErrorCode: input.errorCode ?? null,
        updatedAt: at,
      }).where(and(
        eq(issueQuestionResponseDeliveries.id, input.delivery.id),
        eq(issueQuestionResponseDeliveries.status, "delivering"),
        eq(issueQuestionResponseDeliveries.attemptCount, input.delivery.attemptCount),
      )).returning().then((rows) => rows[0] ?? null);
      if (!row) return null;
      await logActivity(tx as unknown as Db, {
        companyId: input.interaction.companyId,
        actorType: "system",
        actorId: "question-response-delivery",
        agentId: input.interaction.resolvedByAgentId,
        runId: input.targetRunId,
        action: input.status === "failed"
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

    const persisted = updated ?? await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.id, input.delivery.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
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
    const exhausted = options.bounded && nextErrorCount >= MAX_DELIVERY_ATTEMPTS;
    await db.update(issueQuestionResponseDeliveries).set({
      // Keep an exhausted claim owned until recordTerminal commits its outcome.
      status: exhausted ? "delivering" : "pending",
      ...(options.bounded ? { errorCount: nextErrorCount } : {}),
      lastErrorCode: errorCode,
      updatedAt: at,
    }).where(and(
      eq(issueQuestionResponseDeliveries.id, delivery.id),
      eq(issueQuestionResponseDeliveries.status, "delivering"),
      eq(issueQuestionResponseDeliveries.attemptCount, delivery.attemptCount),
    ));
    return exhausted;
  }

  async function withClaimLease<T>(delivery: DeliveryRow, operation: () => Promise<T>): Promise<T> {
    let stopped = false;
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal.then(async () => {
        if (stopped) return;
        const renewedAt = now();
        const renewed = await db.update(issueQuestionResponseDeliveries).set({
          lastAttemptAt: renewedAt,
          updatedAt: renewedAt,
        }).where(and(
          eq(issueQuestionResponseDeliveries.id, delivery.id),
          eq(issueQuestionResponseDeliveries.status, "delivering"),
          eq(issueQuestionResponseDeliveries.attemptCount, delivery.attemptCount),
        )).returning({ id: issueQuestionResponseDeliveries.id });
        if (renewed.length === 0) stopped = true;
      }).catch((error) => {
        logger.warn({ err: error, deliveryId: delivery.id }, "question response claim lease renewal failed");
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
      ownsClaim = await db.select({ id: issueQuestionResponseDeliveries.id })
        .from(issueQuestionResponseDeliveries)
        .where(and(
          eq(issueQuestionResponseDeliveries.id, delivery.id),
          eq(issueQuestionResponseDeliveries.status, "delivering"),
          eq(issueQuestionResponseDeliveries.attemptCount, delivery.attemptCount),
        ))
        .limit(1)
        .then((rows) => rows.length === 1);
    } catch (error) {
      logger.warn({ err: error, deliveryId: delivery.id }, "question response claim ownership check failed");
      throw new DeliveryClaimUnavailableError();
    }
    if (!ownsClaim) throw new DeliveryClaimUnavailableError();
    if (operationError !== undefined) throw operationError;
    return result as T;
  }

  async function findDurableWakeRequest(input: {
    companyId: string;
    agentId: string;
    idempotencyKey: string;
  }) {
    const request = await db.select({
      id: agentWakeupRequests.id,
      runId: agentWakeupRequests.runId,
      status: agentWakeupRequests.status,
    }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
      inArray(agentWakeupRequests.status, [...DURABLE_WAKE_REQUEST_STATUSES]),
    )).orderBy(desc(agentWakeupRequests.createdAt)).limit(1)
      .then((rows) => rows[0] ?? null);
    if (!request?.runId) return request ? { request, run: null } : null;
    const run = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, request.runId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
    )).limit(1).then((rows) => rows[0] ?? null);
    return { request, run };
  }

  async function deliver(interactionId: string): Promise<QuestionResponseDeliveryOutcome | null> {
    const claimed = await claim(interactionId);
    if (!claimed) return terminalOutcome(interactionId);

    const interaction = await db.select().from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.id, interactionId),
        eq(issueThreadInteractions.companyId, claimed.companyId),
        eq(issueThreadInteractions.issueId, claimed.issueId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!interaction || interaction.kind !== "ask_user_questions" || interaction.status !== "answered") {
      return recordTerminal({
        delivery: claimed,
        interaction: interaction ?? ({
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

    const [issue, agent] = await Promise.all([
      db.select().from(issues).where(and(
        eq(issues.id, interaction.issueId),
        eq(issues.companyId, interaction.companyId),
      )).limit(1).then((rows) => rows[0] ?? null),
      interaction.createdByAgentId
        ? db.select({ adapterType: agents.adapterType }).from(agents)
          .where(and(eq(agents.id, interaction.createdByAgentId), eq(agents.companyId, interaction.companyId)))
          .limit(1).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    const adapter = agent?.adapterType ?? "unknown";
    if (!issue || !issue.assigneeAgentId || issue.status === "done" || issue.status === "cancelled") {
      return recordTerminal({
        delivery: claimed,
        interaction,
        status: "failed",
        mode: null,
        targetRunId: null,
        adapter,
        errorCode: !issue ? "question_response_issue_missing" : "question_response_target_unavailable",
      });
    }
    const assigneeAgentId = issue.assigneeAgentId;

    const liveRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, interaction.companyId),
      eq(heartbeatRuns.agentId, assigneeAgentId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    )).orderBy(asc(heartbeatRuns.createdAt));
    const issueRuns = liveRuns.filter((run) => issueIdFromRun(run) === interaction.issueId);
    // `executionRunId` is the issue's authoritative active-run pointer. Fall
    // back to the newest matching running row only for legacy/racy rows where
    // the pointer has not been populated yet; choosing the oldest stale row
    // could steer an answer into the wrong provider turn.
    const successorRunning = (
      issue.executionRunId
        ? issueRuns.find((run) =>
            run.id === issue.executionRunId &&
            run.status === "running" &&
            run.id !== interaction.sourceRunId,
          )
        : null
    ) ?? [...issueRuns].reverse().find((run) =>
      run.status === "running" && run.id !== interaction.sourceRunId,
    ) ?? null;
    const queuedSuccessor = issueRuns.find((run) =>
      (run.status === "queued" || run.status === "scheduled_retry") && run.id !== interaction.sourceRunId,
    ) ?? null;
    const envelope = buildQuestionResponseDeliveryEnvelope(hydrateQuestionInteraction(interaction));
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

    let steeringErrorCode: string | null = null;
    if (successorRunning?.runtimeMode === "native" && steer) {
      try {
        const acknowledgement = await withClaimLease(claimed, () => steer({
          runId: successorRunning.id,
          message: formatQuestionResponseSteeringMessage(envelope),
          correlationId: claimed.correlationId,
        }));
        return recordTerminal({
          delivery: claimed,
          interaction,
          status: "delivered",
          mode: "steered",
          targetRunId: successorRunning.id,
          targetTurnId: acknowledgement.turnId,
          adapter: successorRunning.driverKind ?? adapter,
        });
      } catch (error) {
        if (error instanceof DeliveryClaimUnavailableError) return terminalOutcome(interactionId);
        steeringErrorCode = readSteeringErrorCode(error);
      }
    } else if (successorRunning) {
      steeringErrorCode = "steering_unsupported";
    }

    const actor = actorForInteraction(interaction);
    // This is a new, migration-fenced namespace. The partial unique index on
    // agent_wakeup_requests makes the wake transaction itself idempotent, so a
    // reclaimed stale worker cannot create a second continuation run.
    const wakeIdempotencyKey = `question-response:${interaction.id}`;
    try {
      const existingWake = await findDurableWakeRequest({
        companyId: interaction.companyId,
        agentId: assigneeAgentId,
        idempotencyKey: wakeIdempotencyKey,
      });
      const wakeRun = existingWake?.run ?? (existingWake ? null : await withClaimLease(
        claimed,
        () => options.heartbeat.wakeup(assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: {
            issueId: issue.id,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            interactionStatus: interaction.status,
            sourceCommentId: interaction.sourceCommentId,
            sourceRunId: interaction.sourceRunId,
            mutation: "interaction",
          },
          idempotencyKey: wakeIdempotencyKey,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            interactionStatus: interaction.status,
            sourceCommentId: interaction.sourceCommentId,
            sourceRunId: interaction.sourceRunId,
            wakeReason: "issue_commented",
            source: "issue.interaction.respond",
          },
        }),
      ));
      const durableWake = existingWake ?? (wakeRun ? null : await findDurableWakeRequest({
        companyId: interaction.companyId,
        agentId: assigneeAgentId,
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
      const targetRun = wakeRun ?? durableWake?.run ?? queuedSuccessor ?? null;
      const coalesced = Boolean(queuedSuccessor && targetRun?.id === queuedSuccessor.id);
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
      if (error instanceof DeliveryClaimUnavailableError) return terminalOutcome(interactionId);
      if (isUniqueViolation(error, QUESTION_RESPONSE_WAKE_IDEMPOTENCY_CONSTRAINT)) {
        // A concurrent claimant won the transactional wake fence after our
        // preflight lookup. Reuse its committed receipt instead of consuming
        // an error retry or issuing another continuation.
        const durableWake = await findDurableWakeRequest({
          companyId: interaction.companyId,
          agentId: assigneeAgentId,
          idempotencyKey: wakeIdempotencyKey,
        });
        if (durableWake) {
          const targetRun = durableWake.run ?? queuedSuccessor ?? null;
          const coalesced = Boolean(queuedSuccessor && targetRun?.id === queuedSuccessor.id);
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
      const errorCode = error instanceof Error && compactLine(error.message)
        ? compactLine(error.message)!.slice(0, 160)
        : "question_response_wake_failed";
      const exhausted = await releaseForRetry(claimed, errorCode);
      logger.warn({
        err: error,
        deliveryId: claimed.id,
        interactionId,
        attemptCount: claimed.attemptCount,
        errorCount: claimed.errorCount + 1,
        exhausted,
      }, "question response delivery will retry after wake failure");
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
    await db.update(issueQuestionResponseDeliveries).set({
      status: "pending",
      updatedAt: sweepAt,
    }).where(and(
      eq(issueQuestionResponseDeliveries.status, "delivering"),
      or(
        isNull(issueQuestionResponseDeliveries.lastAttemptAt),
        lte(issueQuestionResponseDeliveries.lastAttemptAt, staleAt),
      ),
    ));
    const ids = await db.select({ interactionId: issueQuestionResponseDeliveries.interactionId })
      .from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.status, "pending"))
      .orderBy(asc(issueQuestionResponseDeliveries.createdAt))
      .limit(limit)
      .then((rows) => rows.map((row) => row.interactionId));
    const counts = { scanned: ids.length, steered: 0, coalesced: 0, wakeFallback: 0, failed: 0 };
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
