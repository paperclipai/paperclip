import { and, eq, sql } from "drizzle-orm";
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
    and ${heartbeatRuns.resultJson}->>'finalizationReasonCode' in
      ('external_chat_response_waiting', 'preserved_result_status_unproven')
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
  const { issueId } = input;
  if (!issueId) return { latestRun: undefined, ownsLatestRequest: false };
  const latestRunId = sql`(select latest.id from (
      (select r.id, r.created_at from ${heartbeatRuns} r
        where r.company_id = ${input.companyId} and r.native_issue_id = ${issueId} and r.agent_id = ${input.agentId}
        order by r.created_at desc, r.id desc limit 1)
      union all
      (select r.id, r.created_at from ${heartbeatRuns} r
        where r.company_id = ${input.companyId} and r.native_issue_id is null
          and r.context_snapshot->>'issueId' = ${issueId} and r.agent_id = ${input.agentId}
        order by r.created_at desc, r.id desc limit 1)
    ) latest order by latest.created_at desc, latest.id desc limit 1)`;
  const wokeForRequest = sql<boolean>`exists (select 1 from ${chatMessageLinks} l
    where l.company_id = ${input.companyId} and l.endpoint_id = ${input.endpointId}
      and l.delivery_id = ${input.deliveryId} and l.direction = 'inbound'
      and (l.comment_id::text = ${heartbeatRuns.contextSnapshot}->>'wakeCommentId'
        or coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? l.comment_id::text))`;
  const [row] = await db.select({ ...responseRunColumns, wokeForRequest }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), sql`${heartbeatRuns.id} = ${latestRunId}`));
  if (!row) return { latestRun: undefined, ownsLatestRequest: false };
  const { wokeForRequest: requestRunIsLatest, ...latestRun } = row;
  const originMessageId = latestRun.activeIdentityContextId ? await chatRunSourceMessageId(db, latestRun,
    { allowLegacyWakeComment: true, provider: "github" }) : null;
  const ownsLatestRequest = requestRunIsLatest ||
    (!!input.sourceMessageId && originMessageId === input.sourceMessageId);
  return { latestRun, ownsLatestRequest };
}
