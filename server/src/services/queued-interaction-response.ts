import { and, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { IssueComment, IssueQueuedCommentEntry } from "@paperclipai/shared";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Interaction receipts keep their typed payload; they never become editable comments. */
export function queuedInteractionId(payload: unknown): string | null {
  const p = record(payload);
  return p.mutation === "interaction" && typeof p.interactionId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.interactionId)
    && ["accepted", "answered", "rejected"].includes(String(p.interactionStatus))
    && p.externalChatContinuation !== true
    ? p.interactionId : null;
}

export async function readQueuedInteractionResponse(db: Db, companyId: string, issueId: string, payload: unknown) {
  const id = queuedInteractionId(payload);
  if (!id) return null;
  const [interaction] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, companyId),
    eq(issueThreadInteractions.issueId, issueId),
    inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"]),
  ));
  if (!interaction || interaction.status !== record(payload).interactionStatus) return null;
  const p = record(interaction.payload);
  const result = record(interaction.result);
  const label = interaction.status === "accepted" ? "Accepted" : interaction.status === "rejected" ? "Rejected" : "Answered";
  const heading = `${label}: ${interaction.title ?? p.prompt ?? "Questions"}`;
  // Preserve the question labels, selected options, custom answers, approval
  // target and exact revision. This is also the explicit steering message.
  const body = `${heading}\n\n${JSON.stringify({
    interactionId: interaction.id, kind: interaction.kind, status: interaction.status,
    payload: interaction.payload, result,
  }, null, 2)}`;
  const comment: IssueComment = {
    id: interaction.id, companyId, issueId, authorType: interaction.resolvedByUserId ? "user" : "agent",
    authorUserId: interaction.resolvedByUserId, authorAgentId: interaction.resolvedByAgentId,
    body, presentation: null, metadata: null,
    createdAt: interaction.resolvedAt ?? interaction.updatedAt, updatedAt: interaction.updatedAt,
  };
  const source: NonNullable<IssueQueuedCommentEntry["source"]> = {
    kind: "interaction", interactionId: interaction.id, interactionKind: interaction.kind,
    requiresFreshSession: record(record(payload)._paperclipWakeContext).forceFreshSession === true,
  };
  return { comment, source };
}

/** A saved answer is a live continuation, even though its card is no longer pending. */
export async function hasQueuedInteractionResponse(db: Db, companyId: string, issueId: string, agentId?: string | null) {
  if (!agentId) return false;
  const [row] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
    .innerJoin(issueThreadInteractions, and(
      eq(issueThreadInteractions.companyId, agentWakeupRequests.companyId),
      sql`${issueThreadInteractions.id}::text = ${agentWakeupRequests.payload}->>'interactionId'`,
      eq(issueThreadInteractions.issueId, issueId),
      inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"]),
    )).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`,
    )).limit(1);
  return Boolean(row);
}
