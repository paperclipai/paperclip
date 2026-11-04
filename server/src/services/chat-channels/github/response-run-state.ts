import { and, desc, eq, or, sql } from "drizzle-orm";
import { chatMessageLinks, heartbeatRuns, type Db } from "@paperclipai/db";
import { chatRunSourceMessageId } from "../run-origin.js";

export const responseRunColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  responsibleUserId: heartbeatRuns.responsibleUserId,
  activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
  nativeIssueId: heartbeatRuns.nativeIssueId,
  issueId: heartbeatRuns.issueId,
  status: heartbeatRuns.status,
  updatedAt: heartbeatRuns.updatedAt,
  // Terminal execution can precede native presentation commit. Until its
  // durable decision exists, missing output is undecided rather than failure.
  nativePresentationPending: sql<boolean>`coalesce(
    ${heartbeatRuns.status} = 'succeeded'
    and ${heartbeatRuns.runtimeMode} = 'native'
    and (${heartbeatRuns.nativePhase} is distinct from 'committed'
      or ${heartbeatRuns.resultJson}->'presentationDecision'->>'schema' is distinct from 'paperclip.run_presentation_decision.v1'
      or coalesce(${heartbeatRuns.resultJson}->'presentationDecision'->>'commentAction', '') not in ('none', 'create', 'reuse')),
    false
  )`,
  // Project only the server-committed no-publication decision, never the
  // potentially large native result or model-authored summary.
  passiveResponseWait: sql<boolean>`coalesce(
    ${heartbeatRuns.status} = 'succeeded'
    and ${heartbeatRuns.runtimeMode} = 'native'
    and ${heartbeatRuns.nativePhase} = 'committed'
    and ${heartbeatRuns.resultJson}->>'finalizationPhase' = 'committed'
    and ${heartbeatRuns.resultJson}->>'finalizationReasonCode' = 'external_chat_response_waiting'
    and ${heartbeatRuns.resultJson}->'nativeResult'->>'schema' = 'paperclip.run_result.v1'
    and ${heartbeatRuns.resultJson}->'nativeResult'->>'reportedWorkDisposition' = 'yielded'
    and ${heartbeatRuns.resultJson}->'nativeResult'->'continuation'->>'kind' = 'response_wake'
    and ${heartbeatRuns.resultJson}->'presentationDecision'->>'schema' = 'paperclip.run_presentation_decision.v1'
    and ${heartbeatRuns.resultJson}->'presentationDecision'->>'chosenSource' = 'none'
    and ${heartbeatRuns.resultJson}->'presentationDecision'->>'commentAction' = 'none'
    and ${heartbeatRuns.resultJson}->'presentationDecision'->'reasonCodes' @> '["yielded_control_plane_wait"]'::jsonb,
    false
  )`,
  contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
    'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
    'taskId', ${heartbeatRuns.contextSnapshot}->'taskId',
    'wakeCommentId', ${heartbeatRuns.contextSnapshot}->'wakeCommentId',
    'wakeCommentIds', ${heartbeatRuns.contextSnapshot}->'wakeCommentIds'
  )`,
};
/** Shared request ownership and presentation state for delivery and recovery. */
export async function readGitHubResponseRun(db: Db, input: {
  companyId: string; endpointId: string; agentId: string; issueId: string | null;
  deliveryId: string; sourceMessageId: string | null;
}) {
  const [requestRun] = await db.select({ runId: heartbeatRuns.id }).from(heartbeatRuns).innerJoin(chatMessageLinks, and(
    eq(chatMessageLinks.companyId, input.companyId), eq(chatMessageLinks.endpointId, input.endpointId),
    eq(chatMessageLinks.deliveryId, input.deliveryId), eq(chatMessageLinks.direction, "inbound"),
    or(sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot}->>'wakeCommentId'`,
      sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${chatMessageLinks.commentId}::text`),
  )).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  const [latestRun] = await db.select(responseRunColumns).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  const originMessageId = latestRun?.activeIdentityContextId ? await chatRunSourceMessageId(db, latestRun,
    { allowLegacyWakeComment: true, provider: "github" }) : null;
  const ownsLatestRequest = !!latestRun && (requestRun?.runId === latestRun.id ||
    (!!input.sourceMessageId && originMessageId === input.sourceMessageId));
  return { latestRun, ownsLatestRequest };
}
