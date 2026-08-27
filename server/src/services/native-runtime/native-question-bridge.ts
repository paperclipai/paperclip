import { and, eq } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueThreadInteractions } from "@paperclipai/db";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  AskUserQuestionsQuestionOption,
  PaperclipQuestionSetPayload,
  RespondIssueThreadInteraction,
} from "@paperclipai/shared";

import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import {
  parsePaperclipQuestionResponse,
  parsePaperclipQuestionSet,
  type PaperclipQuestionResponse,
  type PaperclipQuestionSet,
} from "../../vendor/paperclip-runner/index.js";
import { logger } from "../../middleware/logger.js";
import { unprocessable } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../question-response-delivery.js";
import type { NativeRunStoreBinding } from "./native-run-coordinator-store.js";

const QUESTION_KEY_PREFIX = "paperclip-runner-question:";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TEXT_ANSWER_OPTION_ID = "paperclip_text_answer";
const CUSTOM_ANSWER_OPTION_ID = "paperclip_custom_answer";

type QueueCommand = (
  type: string,
  payload?: Record<string, unknown>,
  commandId?: string,
) => { readonly commandId: string; readonly controllerSeq: number };

interface NativeQuestionCommandTarget {
  binding: Pick<NativeRunStoreBinding, "companyId" | "issueId" | "runId" | "agentId">;
  queueCommand: QueueCommand;
}

const activeTargets = new Map<string, NativeQuestionCommandTarget>();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestIdForInteraction(
  interaction: Pick<AskUserQuestionsInteraction, "idempotencyKey" | "sourceRunId" | "payload">,
): string | null {
  if (!interaction.sourceRunId || !interaction.payload.questionSet) return null;
  const key = interaction.idempotencyKey;
  const expectedPrefix = `${QUESTION_KEY_PREFIX}${interaction.sourceRunId}:`;
  if (!key?.startsWith(expectedPrefix)) return null;
  const requestId = key.slice(expectedPrefix.length);
  if (!REQUEST_ID_PATTERN.test(requestId)) return null;
  return interaction.payload.runtimeRequestId && interaction.payload.runtimeRequestId !== requestId
    ? null
    : requestId;
}

function uniqueSyntheticOptionId(existing: readonly string[], preferred: string): string {
  const ids = new Set(existing);
  if (!ids.has(preferred)) return preferred;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${preferred}_${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error("native_question_synthetic_option_exhausted");
}

function toInteractionPayload(questionSet: PaperclipQuestionSet, runtimeRequestId: string) {
  return {
    version: 1 as const,
    ...(questionSet.title ? { title: questionSet.title.slice(0, 240) } : {}),
    ...(questionSet.submitLabel ? { submitLabel: questionSet.submitLabel.slice(0, 120) } : {}),
    questions: questionSet.questions.map((question) => {
      const canonicalOptions = question.options ?? [];
      const options: AskUserQuestionsQuestionOption[] = canonicalOptions.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      }));
      if (question.answerMode === "text") {
        options.push({
          id: uniqueSyntheticOptionId([], TEXT_ANSWER_OPTION_ID),
          label: question.header ?? "Type an answer",
          ...(question.textValidation?.inputType
            ? { description: `Expected ${question.textValidation.inputType} input` }
            : {}),
          freeText: true,
        });
      } else if (question.customAnswer?.enabled) {
        options.push({
          id: uniqueSyntheticOptionId(canonicalOptions.map((option) => option.id), CUSTOM_ANSWER_OPTION_ID),
          label: question.customAnswer.label ?? "Other",
          ...(question.customAnswer.placeholder ? { description: question.customAnswer.placeholder } : {}),
          freeText: true,
        });
      }
      return {
        id: question.id,
        prompt: question.prompt,
        ...((question.helpText || question.header)
          ? { helpText: question.helpText ?? question.header }
          : {}),
        selectionMode: question.answerMode === "multi_select" ? "multi" as const : "single" as const,
        required: question.required,
        allowOther: question.answerMode === "text" || question.customAnswer?.enabled === true,
        options,
      };
    }),
    questionSet: questionSet as PaperclipQuestionSetPayload,
    runtimeRequestId,
    // A generic task comment cannot satisfy this provider request. Keep the
    // card actionable until a validated answer or an explicit terminal action.
    supersedeOnUserComment: false,
  };
}

function canonicalResponse(
  questionSet: PaperclipQuestionSetPayload,
  answers: readonly AskUserQuestionsAnswer[],
): PaperclipQuestionResponse {
  const answerByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const response: PaperclipQuestionResponse = {
    schema: "paperclip.question_response.v1",
    answers: {},
  };
  for (const question of questionSet.questions) {
    const answer = answerByQuestionId.get(question.id);
    if (!answer) continue;
    if (question.answerMode === "text") {
      response.answers[question.id] = {
        ...(answer.otherText !== undefined && answer.otherText !== null
          ? { text: answer.otherText }
          : {}),
      };
    } else {
      const customOptionId = question.customAnswer?.enabled
        ? uniqueSyntheticOptionId(
            (question.options ?? []).map((option) => option.id),
            CUSTOM_ANSWER_OPTION_ID,
          )
        : null;
      response.answers[question.id] = {
        selectedOptionIds: answer.optionIds.filter((optionId) => optionId !== customOptionId),
        ...(answer.otherText !== undefined && answer.otherText !== null
          ? { customText: answer.otherText }
          : {}),
      };
    }
  }
  return parsePaperclipQuestionResponse(questionSet, response);
}

async function authorizedNativeRun(
  db: Db,
  interaction: Pick<AskUserQuestionsInteraction, "companyId" | "issueId" | "sourceRunId" | "payload" | "idempotencyKey">,
) {
  const requestId = requestIdForInteraction(interaction);
  if (!requestId || !interaction.sourceRunId) return null;
  const run = await db.select({
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    issueId: heartbeatRuns.nativeIssueId,
    agentId: heartbeatRuns.agentId,
    runtimeMode: heartbeatRuns.runtimeMode,
    status: heartbeatRuns.status,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, interaction.sourceRunId),
    eq(heartbeatRuns.companyId, interaction.companyId),
    eq(heartbeatRuns.nativeIssueId, interaction.issueId),
    eq(heartbeatRuns.runtimeMode, "native"),
  )).limit(1).then((rows) => rows[0] ?? null);
  return run ? { ...run, requestId } : null;
}

/** Materialize a canonical runtime input request as the existing task-thread card. */
export async function projectNativeRuntimeRequest(input: {
  db: Db;
  binding: NativeRunStoreBinding;
  event: PrpEvent;
}): Promise<AskUserQuestionsInteraction | null> {
  if (input.event.eventType !== "runtime_request.created") return null;
  if (
    input.event.runId !== input.binding.runId
    || input.event.normalizedSessionId !== input.binding.normalizedSessionId
    || input.event.sourceInstanceId !== input.binding.runnerSourceInstanceId
  ) {
    throw new Error("native_runtime_request_binding_mismatch");
  }
  const request = record(record(input.event.payload)?.request);
  if (
    !request
    || request.schema !== "paperclip.runtime_request.v2"
    || request.requestKind !== "runtime"
    || request.type !== "input"
    || request.status !== "pending"
    || typeof request.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new Error("native_runtime_request_invalid");
  }
  const questionSet = parsePaperclipQuestionSet(request.input);
  if (questionSet.questions.some((question) => question.textValidation?.pattern !== undefined)) {
    // JavaScript regular expressions have no execution budget. Provider-authored
    // patterns therefore stay fail-closed until the runner contract supplies a
    // bounded regex dialect rather than exposing the server to catastrophic backtracking.
    throw new Error("native_runtime_question_pattern_unsupported");
  }
  const idempotencyKey = `${QUESTION_KEY_PREFIX}${input.binding.runId}:${request.requestId}`;
  const existing = await input.db.select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, input.binding.companyId),
      eq(issueThreadInteractions.issueId, input.binding.issueId),
      eq(issueThreadInteractions.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const interaction = await issueThreadInteractionService(input.db).create(
    { id: input.binding.issueId, companyId: input.binding.companyId },
    {
      kind: "ask_user_questions",
      idempotencyKey,
      sourceRunId: input.binding.runId,
      resolverPolicy: "human_only",
      continuationPolicy: "none",
      ...(questionSet.title ? { title: questionSet.title.slice(0, 240) } : {}),
      ...(typeof request.prompt === "string" ? { summary: request.prompt.slice(0, 1000) } : {}),
      payload: toInteractionPayload(questionSet, request.requestId),
    },
    { agentId: input.binding.agentId, runId: input.binding.runId },
    { supersedePendingSiblingInteractions: false },
  ) as AskUserQuestionsInteraction;
  if (!existing) {
    await logActivity(input.db, {
      companyId: input.binding.companyId,
      actorType: "agent",
      actorId: input.binding.agentId,
      agentId: input.binding.agentId,
      runId: input.binding.runId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: input.binding.issueId,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        runtimeMode: "native",
      },
    });
  }
  if (interaction.status === "answered") {
    await deliverNativeQuestionResponseDurably(input.db, interaction);
  }
  return interaction;
}

/** Validate untrusted board input before the existing interaction service persists it. */
export function validateNativeQuestionResponseInput(
  interaction: AskUserQuestionsInteraction,
  input: RespondIssueThreadInteraction,
): void {
  if (!requestIdForInteraction(interaction) || !interaction.payload.questionSet) return;
  try {
    canonicalResponse(interaction.payload.questionSet, input.answers);
  } catch (error) {
    throw unprocessable(
      error instanceof Error ? error.message : "Invalid native question response",
      { code: "invalid_question_response" },
    );
  }
}

/** Queue an answered interaction into the active durable PRP command stream. */
export async function deliverNativeQuestionResponse(
  db: Db,
  interaction: AskUserQuestionsInteraction,
): Promise<"not_native" | "pending" | "queued"> {
  if (interaction.status !== "answered" || !interaction.result || !interaction.payload.questionSet) {
    return "not_native";
  }
  const run = await authorizedNativeRun(db, interaction);
  if (!run) return "not_native";
  const response = canonicalResponse(interaction.payload.questionSet, interaction.result.answers);
  const target = activeTargets.get(run.id);
  if (
    !target
    || target.binding.companyId !== run.companyId
    || target.binding.issueId !== run.issueId
    || target.binding.agentId !== run.agentId
  ) {
    return "pending";
  }
  try {
    target.queueCommand(
      "request.resolve",
      { requestId: run.requestId, response: response as unknown as Record<string, unknown> },
      `question_${interaction.id}`,
    );
    return "queued";
  } catch (error) {
    logger.warn(
      { err: error, runId: run.id, interactionId: interaction.id },
      "native question response remains durable for session recovery",
    );
    return "pending";
  }
}

async function deliverNativeQuestionResponseDurably(
  db: Db,
  interaction: AskUserQuestionsInteraction,
): Promise<void> {
  await questionResponseDeliveryService(db, {
    heartbeat: {
      wakeup: async () => {
        throw new Error("native_question_wake_unreachable");
      },
    } as never,
    resolveNativeQuestion: (candidate) => deliverNativeQuestionResponse(db, candidate),
  }).deliver(interaction.id);
}

export async function flushNativeQuestionResponses(
  db: Db,
  runId: string,
): Promise<void> {
  const target = activeTargets.get(runId);
  if (!target) return;
  const interactions = await issueThreadInteractionService(db).listForIssue(target.binding.issueId);
  for (const interaction of interactions) {
    if (
      interaction.kind === "ask_user_questions"
      && interaction.sourceRunId === runId
      && interaction.status === "answered"
    ) {
      await deliverNativeQuestionResponseDurably(db, interaction);
    }
  }
}

export function registerNativeQuestionCommandTarget(target: NativeQuestionCommandTarget): () => void {
  const existing = activeTargets.get(target.binding.runId);
  if (existing) throw new Error("native_question_command_target_conflict");
  activeTargets.set(target.binding.runId, target);
  return () => {
    if (activeTargets.get(target.binding.runId) === target) {
      activeTargets.delete(target.binding.runId);
    }
  };
}

export async function nativeQuestionRunToCancel(
  db: Db,
  interaction: AskUserQuestionsInteraction,
): Promise<string | null> {
  const run = await authorizedNativeRun(db, interaction);
  return run && ["queued", "running"].includes(run.status) ? run.id : null;
}

/** Find active native runs whose question cards became terminal with no answer. */
export async function nativeQuestionRunIdsToCancelForIssue(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<string[]> {
  const interactions = await issueThreadInteractionService(db).listForIssue(issue.id);
  const runIds = new Set<string>();
  for (const interaction of interactions) {
    if (
      interaction.companyId !== issue.companyId
      || interaction.kind !== "ask_user_questions"
      || !["cancelled", "expired"].includes(interaction.status)
    ) continue;
    const runId = await nativeQuestionRunToCancel(db, interaction);
    if (runId) runIds.add(runId);
  }
  return [...runIds];
}

export const nativeQuestionBridgeInternals = {
  resetForTests: () => activeTargets.clear(),
};
