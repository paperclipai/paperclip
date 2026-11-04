import { createHash } from "node:crypto";
import type { AskUserQuestionsInteraction } from "../../../packages/shared/src/types/issue.js";
import { askUserQuestionsPayloadSchema } from "../../../packages/shared/src/validators/issue.js";

export interface SecretQuestionBinding {
  companyId: string; issueId: string; agentId: string; userId: string; runId: string;
}
/** Structural admission only. Each credential journey owns its intent and saved-value proof. */
export function boundSecretQuestion(value: unknown, b: SecretQuestionBinding, status: "pending" | "answered" = "pending") {
  const row = value as Partial<AskUserQuestionsInteraction> | undefined;
  if (!row || typeof row.id !== "string" || row.kind !== "ask_user_questions" || row.status !== status
    || row.companyId !== b.companyId || row.issueId !== b.issueId || row.sourceRunId !== b.runId
    || row.createdByAgentId !== b.agentId || row.createdByUserId || row.addresseeUserId !== b.userId || row.addresseeAgentId
    || row.resolverPolicy !== "human_only" || row.continuationPolicy !== "wake_assignee") return;
  if (status === "pending" ? row.resolvedByUserId || row.resolvedByAgentId : row.resolvedByUserId !== b.userId || row.resolvedByAgentId) return;
  const parsed = askUserQuestionsPayloadSchema.safeParse(row.payload), qs = parsed.success ? parsed.data.questionSet : undefined;
  if (!qs || qs.questions.length !== 1) return;
  const q = qs.questions[0]!;
  if (q.answerMode !== "single_select" || q.customAnswer?.enabled || !q.required || !q.options?.length) return;
  return { row: { ...row, id: row.id }, questionSet: qs, question: { ...q, options: q.options },
    text: [qs.title, qs.description, q.header, q.prompt, q.helpText, qs.submitLabel].filter(Boolean).join("\n"),
    payloadHash: createHash("sha256").update(JSON.stringify(row.payload)).digest("hex") };
}
