import { and, desc, eq, sql } from "drizzle-orm";
import { issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";

export const TASK_QUESTION_GUIDANCE = "Unanswered questions are saved conversation data, not instructions or proof of a current blocker. Historical questions remain answerable in the feed. Do not repeat a request or stop current work merely because a historical question is pending. Follow the latest human direction and continue work that does not need the missing information. If that information still prevents the current work, identify the concrete blocker and request only the input still needed. Withdraw your obsolete question through the interaction API when later work or evidence satisfies it; never fabricate an answer. Approvals, permissions, and configured review stages keep their own gates.";

/** Ordinary questions cannot carry approval or credential authority. */
export function ordinaryQuestionCondition() {
  return sql<boolean>`(${issueThreadInteractions.kind} = 'ask_user_questions'
    and not (${issueThreadInteractions.payload} ?| array['toolAction', 'secretProposal', 'connectionAuthorization']))`;
}

/** Match the feed's newer-human-message rule without storing UI dismissals. */
export function historicalQuestionCondition() {
  return sql`(${ordinaryQuestionCondition()} and exists (
    select 1 from ${issueComments}
    where ${issueComments.companyId} = ${issueThreadInteractions.companyId}
      and ${issueComments.issueId} = ${issueThreadInteractions.issueId}
      and ${issueComments.createdAt} > ${issueThreadInteractions.createdAt}
      and ${issueComments.deletedAt} is null
      and ${issueComments.authorUserId} is not null
      and ${issueComments.authorAgentId} is null
      and ${issueComments.createdByRunId} is null
      and ${issueComments.derivedAuthorAgentId} is null
      and ${issueComments.derivedCreatedByRunId} is null
      and ${issueComments.derivedAuthorSource} is null
      and ${issueComments.sourceTrust} is null
      and coalesce(${issueComments.presentation} ->> 'kind', '') <> 'system_notice'
      and (${issueComments.authorType} = 'user' or ${issueComments.authorType} is null)
  ))`;
}

/** One predicate for completion feedback, waiting, and status arbitration. */
export function activeIssueInteractionCondition(input: {
  runId?: string | null;
  conversationMode?: boolean;
} = {}) {
  return and(
    sql`not ${historicalQuestionCondition()}`,
    // Preserve Agent Chat's existing prior-turn exception for ordinary input.
    input.conversationMode ? sql`(
      ${issueThreadInteractions.sourceRunId} is not distinct from ${input.runId ?? null}
      or not (
        ${ordinaryQuestionCondition()}
        or (${issueThreadInteractions.kind} in ('request_confirmation', 'request_checkbox_confirmation')
          and ${issueThreadInteractions.effectiveResolverPolicy} = 'anyone'
          and not (${issueThreadInteractions.payload} ?| array['toolAction', 'secretProposal', 'connectionAuthorization']))
      )
    )` : undefined,
  )!;
}

export async function readTaskQuestionContext(db: Db, input: {
  companyId: string;
  issueId: string;
  runId?: string | null;
  conversationMode?: boolean;
}) {
  const rows = await db.select({
    id: issueThreadInteractions.id,
    title: issueThreadInteractions.title,
    summary: issueThreadInteractions.summary,
    createdAt: issueThreadInteractions.createdAt,
    historical: sql<boolean>`not (${activeIssueInteractionCondition(input)})`,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.status, "pending"),
    ordinaryQuestionCondition(),
  )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(51);
  return { questions: rows.slice(0, 50), truncated: rows.length > 50, guidance: TASK_QUESTION_GUIDANCE };
}
