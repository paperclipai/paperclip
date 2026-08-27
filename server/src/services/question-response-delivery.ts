import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
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
import { getTelemetryClient } from "../telemetry.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";
import { nativeSha256 } from "./native-runtime/canonical.js";

const DELIVERY_CLAIM_STALE_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_CORRELATION_PREFIX = "question-response:";

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
        && current.lastAttemptAt.getTime() > claimAt.getTime() - DELIVERY_CLAIM_STALE_MS
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

  async function releaseForRetry(delivery: DeliveryRow, errorCode: string) {
    const at = now();
    const exhausted = delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS;
    if (!exhausted) {
      await db.update(issueQuestionResponseDeliveries).set({
        status: "pending",
        lastErrorCode: errorCode,
        updatedAt: at,
      }).where(and(
        eq(issueQuestionResponseDeliveries.id, delivery.id),
        eq(issueQuestionResponseDeliveries.status, "delivering"),
      ));
    }
    return exhausted;
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

    const liveRuns = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, interaction.companyId),
      eq(heartbeatRuns.agentId, issue.assigneeAgentId),
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
        const acknowledgement = await steer({
          runId: successorRunning.id,
          message: formatQuestionResponseSteeringMessage(envelope),
          correlationId: claimed.correlationId,
        });
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
        steeringErrorCode = readSteeringErrorCode(error);
      }
    } else if (successorRunning) {
      steeringErrorCode = "steering_unsupported";
    }

    const actor = actorForInteraction(interaction);
    try {
      const wakeRun = await options.heartbeat.wakeup(issue.assigneeAgentId, {
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
        idempotencyKey: `interaction:${interaction.id}:${interaction.status}`,
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
      });
      const coalesced = Boolean(queuedSuccessor && wakeRun?.id === queuedSuccessor.id);
      return recordTerminal({
        delivery: claimed,
        interaction,
        status: coalesced ? "delivered" : "fallback_queued",
        mode: coalesced ? "coalesced" : "wake_fallback",
        targetRunId: wakeRun?.id ?? queuedSuccessor?.id ?? null,
        adapter: wakeRun?.driverKind ?? adapter,
        errorCode: steeringErrorCode,
      });
    } catch (error) {
      const errorCode = error instanceof Error && compactLine(error.message)
        ? compactLine(error.message)!.slice(0, 160)
        : "question_response_wake_failed";
      const exhausted = await releaseForRetry(claimed, errorCode);
      logger.warn({
        err: error,
        deliveryId: claimed.id,
        interactionId,
        attemptCount: claimed.attemptCount,
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
    const staleAt = new Date(sweepAt.getTime() - DELIVERY_CLAIM_STALE_MS);
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
