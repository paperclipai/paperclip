import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { RequestConfirmationInteraction } from "../../../packages/shared/src/types/issue.js";
import { requestConfirmationPayloadSchema } from "../../../packages/shared/src/validators/issue.js";
import { chatCatalogHumanQuestionPolicies } from "../chat-catalog-contract.js";
export interface PersonalConfirmationBinding { companyId: string; issueId: string; agentId: string; userId: string; runId: string; definitionId: string; canonicalCommentId: string }
export function personalSecretConfirmationHandoff(value: unknown, b: PersonalConfirmationBinding, guidance: (text: string) => boolean, status: "pending" | "accepted" = "pending") {
  const row = value as Partial<RequestConfirmationInteraction> | undefined, p = row?.payload;
  if (!row?.id || row.kind !== "request_confirmation" || row.status !== status || row.companyId !== b.companyId || row.issueId !== b.issueId
    || row.sourceRunId !== b.runId || row.createdByAgentId !== b.agentId || row.createdByUserId || row.addresseeAgentId
    || (row.addresseeUserId != null && row.addresseeUserId !== b.userId) || !row.originCommentIds?.includes(b.canonicalCommentId)
    || !chatCatalogHumanQuestionPolicies(row) || row.continuationPolicy !== "wake_assignee" || !p
    || p.target || p.toolAction || p.secretProposal || p.connectionAuthorization || p.qualityReview
    || !requestConfirmationPayloadSchema.safeParse(p).success || row.dismissedAt
    || (status === "pending" ? row.resolvedByUserId || row.resolvedByAgentId : row.resolvedByUserId !== b.userId || row.resolvedByAgentId || row.result?.outcome !== "accepted")) return;
  const text = [p.prompt, p.detailsMarkdown, p.acceptLabel].filter(Boolean).join("\n");
  if (!guidance(text) || !new RegExp(`\\bdefinition\\s+${b.definitionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text) || !/\bPERSONAL_PUBLISHING_KEY\b/.test(text) || !/my secrets/i.test(text)
    || !/\b(?:when|once|after)\b[^.!?]*\b(?:saved|set|entered)\b[^.!?]*\bconfirm\b|\bconfirm\b[^.!?]*\b(?:saved|set|entered)\b/i.test(text)
    || /\b(?:approve|authorize|permission|deploy|delete|execute|purchase)\b/i.test(text)) return;
  return { interactionId: row.id, payloadHash: createHash("sha256").update(JSON.stringify(p)).digest("hex"), acceptLabel: p.acceptLabel ?? "Approve", prompt: p.prompt };
}
export async function acceptPersonalSecretConfirmation(page: Page, issueId: string, interactionId: string, label: string, prompt: string, remaining: () => number) {
  const card = page.getByTestId("task-chat-composer-takeover");
  await expect(card.getByText(prompt, { exact: true })).toBeVisible({ timeout: remaining() });
  const [response] = await Promise.all([
    page.waitForResponse(res => new URL(res.url()).pathname === `/api/issues/${issueId}/interactions/${interactionId}/accept` && res.request().method() === "POST", { timeout: remaining() }),
    card.getByRole("button", { name: label, exact: true }).click({ timeout: remaining() }),
  ]);
  if (!response.ok()) throw new Error("Personal secure-entry confirmation failed");
  return response.json() as Promise<unknown>;
}

export async function confirmThenStartPersonalConsumer(confirm: () => Promise<void>, start: () => Promise<void>) {
  await confirm();
  await start();
}
