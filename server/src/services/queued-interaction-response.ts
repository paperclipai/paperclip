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

/**
 * One readable line for a queued response. The steering body also carries the
 * typed JSON receipt for the agent; people only ever see this line.
 */
export function queuedInteractionSummary(interaction: {
  kind: string; status: string; title?: string | null; payload?: unknown;
}): string {
  const p = record(interaction.payload);
  if (interaction.kind === "connection_intent") {
    const service = typeof p.serviceName === "string" && p.serviceName.trim() ? p.serviceName.trim() : null;
    const subject = service ? `${service} connection` : interaction.title ?? "Connection request";
    return interaction.status === "rejected" ? `Declined: ${subject}` : `Connected: ${subject}`;
  }
  const label = interaction.status === "accepted" ? "Accepted" : interaction.status === "rejected" ? "Rejected" : "Answered";
  const subject = interaction.title ?? (typeof p.prompt === "string" ? p.prompt : null) ?? "Questions";
  return `${label}: ${subject}`;
}

/**
 * A run that started with this exact response in its context already received
 * it. The run must carry the resolved status: the card-creation wake carries
 * the same interaction id while the card is still pending, so it never counts.
 * Any other wake that still carries the same receipt (for example a recovery
 * continuation that raced the response's own wake) is redundant: it is not
 * pending input, so it must not hold the composer queue or the issue.
 * A cancelled or failed start does not count; that response is still owed.
 */
// Table-qualified on purpose: inside a select list Drizzle renders columns
// unqualified, which would bind them to the subquery's own run row.
function deliveredInteractionRunExists(companyId: string, issueId: string) {
  return sql<boolean>`EXISTS (SELECT 1 FROM heartbeat_runs delivered_run
    WHERE delivered_run.company_id = ${companyId}
      AND delivered_run.context_snapshot->>'issueId' = ${issueId}
      AND delivered_run.context_snapshot->>'interactionId' = issue_thread_interactions.id::text
      AND delivered_run.context_snapshot->>'interactionStatus' = issue_thread_interactions.status
      AND delivered_run.started_at IS NOT NULL
      AND delivered_run.status IN ('running', 'succeeded'))`;
}

/**
 * The explicit steering message for a resolved interaction. It preserves the
 * question labels, selected options, custom answers, approval target and exact
 * revision.
 */
export function queuedInteractionSteeringBody(interaction: {
  id: string; kind: string; status: string; title?: string | null; payload?: unknown; result?: unknown;
}): string {
  return `${queuedInteractionSummary(interaction)}\n\n${JSON.stringify({
    interactionId: interaction.id, kind: interaction.kind, status: interaction.status,
    payload: interaction.payload, result: record(interaction.result),
  }, null, 2)}`;
}

export type QueuedInteractionResponse = NonNullable<Awaited<ReturnType<typeof readQueuedInteractionResponse>>>;

/** A stored human answer can reach its assignee while dependency work stays blocked. */
export async function isVerifiedDependencyInteractionResponse(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown;
}): Promise<boolean> {
  const id = queuedInteractionId(input.context);
  if (!id) return false;
  const context = record(input.context);
  const [interaction] = await db.select({ status: issueThreadInteractions.status, kind: issueThreadInteractions.kind,
    resolvedByUserId: issueThreadInteractions.resolvedByUserId, resolvedAt: issueThreadInteractions.resolvedAt })
    .from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId), eq(issueThreadInteractions.createdByAgentId, input.agentId),
    )).limit(1);
  return Boolean(interaction?.resolvedByUserId && interaction.resolvedAt
    && interaction.status === context.interactionStatus
    && (context.interactionKind === undefined || interaction.kind === context.interactionKind));
}

export async function readQueuedInteractionResponse(db: Db, companyId: string, issueId: string, payload: unknown) {
  const id = queuedInteractionId(payload);
  if (!id) return null;
  const [row] = await db.select({
    interaction: issueThreadInteractions,
    delivered: deliveredInteractionRunExists(companyId, issueId),
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, companyId),
    eq(issueThreadInteractions.issueId, issueId),
    inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"]),
  ));
  const interaction = row?.interaction;
  if (!interaction || interaction.status !== record(payload).interactionStatus || row.delivered) return null;
  const heading = queuedInteractionSummary(interaction);
  const body = queuedInteractionSteeringBody(interaction);
  const comment: IssueComment = {
    id: interaction.id, companyId, issueId, authorType: interaction.resolvedByUserId ? "user" : "agent",
    authorUserId: interaction.resolvedByUserId, authorAgentId: interaction.resolvedByAgentId,
    body, presentation: null, metadata: null,
    createdAt: interaction.resolvedAt ?? interaction.updatedAt, updatedAt: interaction.updatedAt,
  };
  const source: NonNullable<IssueQueuedCommentEntry["source"]> = {
    kind: "interaction", interactionId: interaction.id, interactionKind: interaction.kind,
    requiresFreshSession: record(record(payload)._paperclipWakeContext).forceFreshSession === true,
    summary: heading,
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
      sql`NOT ${deliveredInteractionRunExists(companyId, issueId)}`,
    )).limit(1);
  return Boolean(row);
}
