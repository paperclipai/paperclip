import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueConnectionContentDeletions, issues, toolAccessAuditEvents, toolCallEvents, toolInvocations, type Db } from "@paperclipai/db";
import { initialContentDeletionProgress, runUsedToolsSql, settledRunSql, uuidList } from "./content-deletion.js";
import { requestIssueAttachmentObjectDeletion } from "./stored-object-deletion.js";

export async function requestIssueConnectionContentDeletion(
  tx: Db,
  input: { companyId: string; issueId: string; actorAgentId?: string | null },
) {
  await requestIssueAttachmentObjectDeletion(tx, input);
  const [issue] = await tx.select({ createdAt: issues.createdAt }).from(issues).where(eq(issues.id, input.issueId));
  const runs = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      sql`(${heartbeatRuns.issueId} = ${input.issueId} or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}::text)`,
      sql`(${runUsedToolsSql(input.companyId)} or not ${settledRunSql(sql`${heartbeatRuns.id}`)})`,
    ));
  const runIds = runs.map((row) => row.id);
  const calls = await tx
    .select({ id: toolInvocations.id })
    .from(toolInvocations)
    .where(and(
      eq(toolInvocations.companyId, input.companyId),
      eq(toolInvocations.issueId, input.issueId),
      sql`(${toolInvocations.runId} is null or not (${toolInvocations.runId} = any(${uuidList(runIds)})))`,
    ));
  const invocationIds = calls.map((row) => row.id);
  const events = await tx
    .select({ id: toolCallEvents.id })
    .from(toolCallEvents)
    .where(and(
      eq(toolCallEvents.companyId, input.companyId),
      eq(toolCallEvents.issueId, input.issueId),
      sql`(${toolCallEvents.runId} is null or not (${toolCallEvents.runId} = any(${uuidList(runIds)})))`,
      sql`(${toolCallEvents.invocationId} is null or not (${toolCallEvents.invocationId} = any(${uuidList(invocationIds)})))`,
    ));
  const eventIds = events.map((row) => row.id);
  if (runIds.length === 0 && invocationIds.length === 0 && eventIds.length === 0) {
    const [audit] = await tx
      .select({ id: toolAccessAuditEvents.id })
      .from(toolAccessAuditEvents)
      .where(and(
        eq(toolAccessAuditEvents.companyId, input.companyId),
        sql`${toolAccessAuditEvents.createdAt} >= (select created_at from issues where id = ${input.issueId})`,
        sql`${toolAccessAuditEvents.details}->>'issueId' = ${input.issueId}::text`,
        sql`jsonb_typeof(${toolAccessAuditEvents.details}->'argumentsSummary') = 'object'`,
        sql`${toolAccessAuditEvents.details}->'argumentsSummary'->>'contentDeletedAt' is null`,
      ))
      .limit(1);
    if (!audit) return null;
  }
  const now = new Date();
  const [created] = await tx
    .insert(issueConnectionContentDeletions)
    .values({
      requestedAt: now,
      notBefore: now,
      createdAt: now,
      updatedAt: now,
      companyId: input.companyId,
      issueId: input.issueId,
      scope: { runIds, invocationIds, eventIds, createdAfter: issue?.createdAt.toISOString() ?? null },
      requestedByActorType: input.actorAgentId ? "agent" : "system",
      requestedByActorId: input.actorAgentId ?? null,
      progress: initialContentDeletionProgress() as unknown as Record<string, unknown>,
    })
    .returning({ id: issueConnectionContentDeletions.id });
  return created!.id;
}
