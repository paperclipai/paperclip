import { createHash } from "node:crypto";
import { chatCatalogHumanQuestionPolicies } from "../chat-catalog-contract.js";
import type { AskUserQuestionsInteraction } from "../../../packages/shared/src/types/issue.js";
import { askUserQuestionsPayloadSchema } from "../../../packages/shared/src/validators/issue.js";

export interface SecretQuestionBinding {
  companyId: string; issueId: string; agentId: string; userId: string; runId: string;
}
export function boundSecretQuestion(value: unknown, b: SecretQuestionBinding, status: "pending" | "answered" = "pending", mode?: "company-environment-name" | "company-saved-secret-name") {
  const row = value as Partial<AskUserQuestionsInteraction> | undefined;
  if (!row || typeof row.id !== "string" || row.kind !== "ask_user_questions" || row.status !== status
    || row.companyId !== b.companyId || row.issueId !== b.issueId || row.sourceRunId !== b.runId
    || row.createdByAgentId !== b.agentId || row.createdByUserId || row.addresseeUserId !== b.userId || row.addresseeAgentId
    || !chatCatalogHumanQuestionPolicies(row) || row.continuationPolicy !== "wake_assignee") return;
  if (status === "pending" ? row.resolvedByUserId || row.resolvedByAgentId : row.resolvedByUserId !== b.userId || row.resolvedByAgentId) return;
  const parsed = askUserQuestionsPayloadSchema.safeParse(row.payload), qs = parsed.success ? parsed.data.questionSet : undefined;
  if (!qs || qs.questions.length !== 1) return;
  const q = qs.questions[0]!;
  if (!q.required || (mode
    ? q.answerMode !== "text" || !!q.options?.length || !!q.customAnswer?.enabled || (q.initialText !== undefined && (mode !== "company-saved-secret-name" || (q.initialText !== "" && !/^[a-zA-Z0-9_.-]{1,120}$/.test(q.initialText))))
      || (mode === "company-environment-name" && (q.textValidation?.pattern !== "^[A-Za-z_][A-Za-z0-9_]*$" || q.textValidation.minLength !== 1
      || !q.textValidation.maxLength || q.textValidation.maxLength > 120 || q.textValidation.maxLength < "DEPLOYMENT_API_KEY".length))
    : q.answerMode !== "single_select" || !q.options?.length)) return;
  return { row: { ...row, id: row.id }, questionSet: qs, question: { ...q, options: q.options ?? [] },
    text: [qs.title, qs.description, q.header, q.prompt, q.helpText, q.customAnswer?.enabled ? q.customAnswer.label : undefined, q.customAnswer?.enabled ? q.customAnswer.placeholder : undefined, qs.submitLabel].filter(Boolean).join("\n"),
    payloadHash: createHash("sha256").update(JSON.stringify(row.payload)).digest("hex") };
}
