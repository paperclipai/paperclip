import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  chatConversations,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
} from "@paperclipai/db";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { resolveChatOriginPublicationBindings } from "./issues.js";

type SafeRunMilestone = "queued" | "working" | "completed" | "failed";

export const CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON =
  "allow_chat_run_presentation";

async function hasExternalInteractionForRun(
  db: Db,
  input: { companyId: string; issueId: string; runId: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .innerJoin(
      chatPublications,
      and(
        eq(chatPublications.companyId, issueThreadInteractions.companyId),
        eq(chatPublications.issueId, issueThreadInteractions.issueId),
        sql`${chatPublications.payload} ->> 'interactionId' = ${issueThreadInteractions.id}::text`,
        sql`${chatPublications.idempotencyKey} = 'interaction:' || ${issueThreadInteractions.id}::text || ':' || ${chatPublications.endpointId}::text`,
      ),
    )
    .where(
      and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.sourceRunId, input.runId),
        inArray(issueThreadInteractions.kind, [
          "ask_user_questions",
          "request_confirmation",
        ]),
        inArray(chatPublications.state, [
          "pending",
          "streaming",
          "published",
          "retry",
          "delivery_unknown",
        ]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Heartbeat's presentation resolver may externalize its selected final prose
 * only when the run has an exact causal path back to a live chat binding.
 * Keeping this decision beside milestone lineage makes the publication and
 * generic-completion paths share the same origin proof.
 */
export async function resolveChatRunPresentationAuthorizationReason(
  db: Db,
  input: { companyId: string; issueId: string; runId: string },
): Promise<
  typeof CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON | "internal_agent_write"
> {
  const bindings = await resolveChatOriginPublicationBindings(
    db,
    input.companyId,
    input.issueId,
    input.runId,
  );
  if (bindings.length === 0) return "internal_agent_write";
  // A native question/confirmation is the provider-visible result of its
  // originating run. Keep the runner's final presentation as an internal
  // Paperclip comment even if a fast provider answer resolves the interaction
  // before this check; otherwise model metadata can appear as a noisy sibling
  // beside the card or its continuation response.
  if (await hasExternalInteractionForRun(db, input)) {
    return "internal_agent_write";
  }
  return CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON;
}

type ChatRunMilestoneCandidate = {
  runId: string;
  runStatus: string;
  runErrorCode: string | null;
  runUpdatedAt: Date;
  issueId: string;
  companyId: string;
  endpointId: string;
  conversationId: string;
  agentName: string;
};

function milestoneForStatus(status: string): SafeRunMilestone | null {
  if (status === "queued") return "queued";
  if (status === "running") return "working";
  if (status === "succeeded") return "completed";
  if (["failed", "timed_out", "cancelled"].includes(status)) return "failed";
  return null;
}

export function safeMilestoneText(input: {
  agentName: string;
  errorCode?: string | null;
  milestone: SafeRunMilestone;
  issueId: string;
  publicBaseUrl?: string | null;
}): string {
  if (input.milestone === "queued") return `${input.agentName} is queued.`;
  if (input.milestone === "working") return `${input.agentName} is working…`;
  if (input.milestone === "completed")
    return `${input.agentName} completed this turn.`;
  let taskUrl: string | null = null;
  if (input.publicBaseUrl) {
    try {
      const origin = new URL(input.publicBaseUrl).origin;
      taskUrl = `${origin}/issues/${input.issueId}`;
    } catch {
      taskUrl = null;
    }
  }
  const recovery =
    input.errorCode === "low_trust_isolation_unavailable"
      ? `${input.agentName} couldn't safely start this turn because this external identity isn't linked to Paperclip and isolated guest execution isn't available. Link your identity to Paperclip, or ask a Paperclip admin to enable isolated guest execution.`
      : `${input.agentName} stopped before completing this turn.`;
  return `${recovery}${
    taskUrl
      ? ` Open the task in Paperclip: ${taskUrl}`
      : " Open the task in Paperclip for details."
  }`;
}

/**
 * Project only coarse run lifecycle into bound external conversations. Raw
 * output, errors, tool events, and reasoning stay in Paperclip. Idempotency is
 * keyed by run, milestone, and endpoint so polling and restarts are harmless.
 */
export async function enqueueChatRunMilestones(
  db: Db,
  input: {
    publicBaseUrl?: string | null;
    since?: Date;
    limit?: number;
  } = {},
): Promise<number> {
  const since = input.since ?? new Date(Date.now() - 24 * 60 * 60_000);
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
  const issueIdFromContext = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const explicitlyAuthoredCommentReason = sql<boolean>`(
    ${issueComments.metadata} ->> 'authorizationReason' = 'paperclip_runner_protocol'
    or left(coalesce(${issueComments.metadata} ->> 'authorizationReason', ''), 6) = 'allow_'
  )`;
  const milestoneFromStatus = sql<string>`case
    when ${heartbeatRuns.status} = 'queued' then 'queued'
    when ${heartbeatRuns.status} = 'running' then 'working'
    when ${heartbeatRuns.status} = 'succeeded' then 'completed'
    else 'failed'
  end`;
  const hasQuestionContinuationTarget = sql<boolean>`exists (
    select 1
    from issue_question_response_deliveries question_delivery
    inner join issue_thread_interactions question_interaction
      on question_interaction.company_id = question_delivery.company_id
      and question_interaction.issue_id = question_delivery.issue_id
      and question_interaction.id = question_delivery.interaction_id
    inner join chat_publications question_prompt
      on question_prompt.company_id = question_delivery.company_id
      and question_prompt.issue_id = question_delivery.issue_id
      and question_prompt.payload ->> 'interactionId' = question_delivery.interaction_id::text
      and question_prompt.idempotency_key = 'interaction:' || question_delivery.interaction_id::text || ':' || question_prompt.endpoint_id::text
      and question_prompt.state = 'published'
    where question_delivery.company_id = ${heartbeatRuns.companyId}
      and question_delivery.issue_id::text = ${issueIdFromContext}
      and question_delivery.target_run_id = ${heartbeatRuns.id}
      and question_delivery.status in ('delivered', 'fallback_queued')
      and question_interaction.kind = 'ask_user_questions'
      and question_interaction.status = 'answered'
  )`;
  const hasDirectInteractionContinuation = sql<boolean>`exists (
    select 1
    from issue_thread_interactions interaction
    inner join chat_publications interaction_prompt
      on interaction_prompt.company_id = interaction.company_id
      and interaction_prompt.issue_id = interaction.issue_id
      and interaction_prompt.payload ->> 'interactionId' = interaction.id::text
      and interaction_prompt.idempotency_key = 'interaction:' || interaction.id::text || ':' || interaction_prompt.endpoint_id::text
      and interaction_prompt.state = 'published'
    inner join agent_wakeup_requests continuation_wake
      on continuation_wake.company_id = interaction.company_id
      and continuation_wake.run_id = ${heartbeatRuns.id}
      and continuation_wake.agent_id = ${heartbeatRuns.agentId}
      and continuation_wake.status <> 'skipped'
      and continuation_wake.idempotency_key = case
        when interaction.kind = 'ask_user_questions'
          and interaction.status = 'answered'
          then 'question-response:' || interaction.id::text
        else 'interaction:' || interaction.id::text || ':' || interaction.status
      end
    where interaction.company_id = ${heartbeatRuns.companyId}
      and interaction.issue_id::text = ${issueIdFromContext}
      and interaction.id::text = ${heartbeatRuns.contextSnapshot} ->> 'interactionId'
      and interaction.source_run_id::text = ${heartbeatRuns.contextSnapshot} ->> 'sourceRunId'
      and (
        (
          interaction.kind = 'ask_user_questions'
          and interaction.status in ('answered', 'cancelled')
        )
        or (
          interaction.kind = 'request_confirmation'
          and interaction.status in ('accepted', 'rejected', 'cancelled')
        )
      )
  )`;
  let inserted = 0;
  let cursor: {
    updatedAt: Date;
    runId: string;
    conversationId: string;
  } | null = null;
  const bindingsCache = new Map<
    string,
    Awaited<ReturnType<typeof resolveChatOriginPublicationBindings>>
  >();
  const externalInteractionCache = new Map<string, boolean>();
  while (inserted < limit) {
    const pageSize = Math.max(25, Math.min(200, limit - inserted));
    const pageCursor: typeof cursor = cursor;
    const rows: ChatRunMilestoneCandidate[] = await db
      .select({
        runId: heartbeatRuns.id,
        runStatus: heartbeatRuns.status,
        runErrorCode: heartbeatRuns.errorCode,
        runUpdatedAt: heartbeatRuns.updatedAt,
        issueId: chatConversations.issueId,
        companyId: chatConversations.companyId,
        endpointId: chatConversations.endpointId,
        conversationId: chatConversations.id,
        agentName: agents.name,
      })
      .from(heartbeatRuns)
      .innerJoin(
        chatConversations,
        and(
          eq(chatConversations.companyId, heartbeatRuns.companyId),
          sql`${issueIdFromContext} = ${chatConversations.issueId}::text`,
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      )
      .innerJoin(
        chatEndpoints,
        and(
          eq(chatEndpoints.companyId, chatConversations.companyId),
          eq(chatEndpoints.id, chatConversations.endpointId),
          eq(chatEndpoints.assignedAgentId, heartbeatRuns.agentId),
        ),
      )
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .leftJoin(
        chatPublications,
        and(
          eq(chatPublications.companyId, heartbeatRuns.companyId),
          eq(chatPublications.endpointId, chatConversations.endpointId),
          sql`${chatPublications.idempotencyKey} = 'run:' || ${heartbeatRuns.id}::text || ':' || ${milestoneFromStatus} || ':' || ${chatConversations.endpointId}::text`,
        ),
      )
      .where(
        and(
          inArray(heartbeatRuns.status, [
            "queued",
            "running",
            "succeeded",
            "failed",
            "timed_out",
            "cancelled",
          ]),
          or(
            and(
              sql`${heartbeatRuns.contextSnapshot} ->> 'source' like 'chat:%'`,
              sql`not (${hasQuestionContinuationTarget})`,
            ),
            and(
              inArray(
                sql<string>`${heartbeatRuns.contextSnapshot} ->> 'source'`,
                [
                  "issue.interaction.respond",
                  "issue.interaction.accept",
                  "issue.interaction.reject",
                  "issue.interaction.cancel",
                  "issue.interaction.withdraw",
                  "external_chat.interaction.resolve",
                ],
              ),
              hasDirectInteractionContinuation,
            ),
            hasQuestionContinuationTarget,
          ),
          // Heartbeat marks a run succeeded before the presentation resolver
          // finishes. Waiting for its durable decision prevents a generic
          // completion from racing an explicitly authored final comment.
          sql`(
            ${heartbeatRuns.status} <> 'succeeded'
            or ${heartbeatRuns.resultJson} -> 'presentationDecision' is not null
          )`,
          // Exclude successful runs that already produced an explicit external
          // reply before applying the batch limit. Otherwise a page of settled
          // runs could permanently starve later milestones.
          or(
            ne(heartbeatRuns.status, "succeeded"),
            notExists(
              db
                .select({ id: chatPublications.id })
                .from(chatPublications)
                .innerJoin(
                  issueComments,
                  and(
                    eq(issueComments.companyId, chatPublications.companyId),
                    eq(issueComments.id, chatPublications.commentId),
                  ),
                )
                .where(
                  and(
                    eq(chatPublications.companyId, heartbeatRuns.companyId),
                    eq(
                      chatPublications.endpointId,
                      chatConversations.endpointId,
                    ),
                    eq(chatPublications.conversationId, chatConversations.id),
                    eq(issueComments.authorType, "agent"),
                    eq(issueComments.createdByRunId, heartbeatRuns.id),
                    explicitlyAuthoredCommentReason,
                  ),
                ),
            ),
          ),
          or(
            sql`exists (
              select 1
              from ${chatMessageLinks}
              where ${chatMessageLinks.companyId} = ${heartbeatRuns.companyId}
                and ${chatMessageLinks.conversationId} = ${chatConversations.id}
                and ${chatMessageLinks.direction} = 'inbound'
                and (
                  ${chatMessageLinks.commentId}::text = (${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId')
                  or ${chatMessageLinks.commentId}::text = (${heartbeatRuns.contextSnapshot} ->> 'commentId')
                  or (${heartbeatRuns.contextSnapshot} -> 'wakeCommentIds') ? ${chatMessageLinks.commentId}::text
                )
            )`,
            sql`exists (
              select 1
              from chat_publications prompt
              where prompt.company_id = ${heartbeatRuns.companyId}
                and prompt.conversation_id = ${chatConversations.id}
                and prompt.issue_id = ${chatConversations.issueId}
                and prompt.state = 'published'
                and prompt.payload ->> 'interactionId' = ${heartbeatRuns.contextSnapshot} ->> 'interactionId'
                and prompt.idempotency_key = 'interaction:' || (prompt.payload ->> 'interactionId') || ':' || prompt.endpoint_id::text
            )`,
            sql`exists (
              select 1
              from issue_question_response_deliveries target_delivery
              inner join chat_publications target_prompt
                on target_prompt.company_id = target_delivery.company_id
                and target_prompt.issue_id = target_delivery.issue_id
                and target_prompt.conversation_id = ${chatConversations.id}
                and target_prompt.payload ->> 'interactionId' = target_delivery.interaction_id::text
                and target_prompt.idempotency_key = 'interaction:' || target_delivery.interaction_id::text || ':' || target_prompt.endpoint_id::text
                and target_prompt.state = 'published'
              where target_delivery.company_id = ${heartbeatRuns.companyId}
                and target_delivery.target_run_id = ${heartbeatRuns.id}
                and target_delivery.status in ('delivered', 'fallback_queued')
            )`,
          ),
          gte(heartbeatRuns.updatedAt, since),
          isNull(chatPublications.id),
          pageCursor
            ? or(
                gt(heartbeatRuns.updatedAt, pageCursor.updatedAt),
                and(
                  eq(heartbeatRuns.updatedAt, pageCursor.updatedAt),
                  or(
                    gt(heartbeatRuns.id, pageCursor.runId),
                    and(
                      eq(heartbeatRuns.id, pageCursor.runId),
                      gt(chatConversations.id, pageCursor.conversationId),
                    ),
                  ),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(heartbeatRuns.updatedAt),
        asc(heartbeatRuns.id),
        asc(chatConversations.id),
      )
      .limit(pageSize);
    if (rows.length === 0) break;
    const lastRow = rows.at(-1)!;
    cursor = {
      updatedAt: lastRow.runUpdatedAt,
      runId: lastRow.runId,
      conversationId: lastRow.conversationId,
    };

    for (const row of rows) {
      if (inserted >= limit) break;
      const milestone = milestoneForStatus(row.runStatus);
      if (!milestone) continue;
      const bindingCacheKey = `${row.companyId}:${row.issueId}:${row.runId}`;
      let bindings = bindingsCache.get(bindingCacheKey);
      if (!bindings) {
        bindings = await resolveChatOriginPublicationBindings(
          db,
          row.companyId,
          row.issueId,
          row.runId,
        );
        bindingsCache.set(bindingCacheKey, bindings);
      }
      if (
        !bindings.some(
          (binding) =>
            binding.endpointId === row.endpointId &&
            binding.conversationId === row.conversationId,
        )
      ) {
        continue;
      }
      if (milestone === "completed") {
        let hasExternalInteraction =
          externalInteractionCache.get(bindingCacheKey);
        if (hasExternalInteraction === undefined) {
          hasExternalInteraction = await hasExternalInteractionForRun(db, {
            companyId: row.companyId,
            issueId: row.issueId,
            runId: row.runId,
          });
          externalInteractionCache.set(bindingCacheKey, hasExternalInteraction);
        }
        if (hasExternalInteraction) continue;
        const explicitlyAuthoredPublication = await db
          .select({ id: chatPublications.id })
          .from(chatPublications)
          .innerJoin(
            issueComments,
            and(
              eq(issueComments.companyId, chatPublications.companyId),
              eq(issueComments.id, chatPublications.commentId),
            ),
          )
          .where(
            and(
              eq(chatPublications.companyId, row.companyId),
              eq(chatPublications.endpointId, row.endpointId),
              eq(chatPublications.conversationId, row.conversationId),
              eq(issueComments.authorType, "agent"),
              eq(issueComments.createdByRunId, row.runId),
              explicitlyAuthoredCommentReason,
            ),
          )
          .limit(1);
        if (explicitlyAuthoredPublication.length > 0) continue;
      }
      const result = await db
        .insert(chatPublications)
        .values({
          companyId: row.companyId,
          endpointId: row.endpointId,
          conversationId: row.conversationId,
          issueId: row.issueId,
          idempotencyKey: `run:${row.runId}:${milestone}:${row.endpointId}`,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "safe_milestone",
            text: safeMilestoneText({
              agentName: row.agentName,
              errorCode: row.runErrorCode,
              milestone,
              issueId: row.issueId,
              publicBaseUrl: input.publicBaseUrl,
            }),
            progressState: milestone,
          }),
          state: "pending",
        })
        .onConflictDoNothing()
        .returning({ id: chatPublications.id });
      inserted += result.length;
    }
    if (rows.length < pageSize) break;
  }
  return inserted;
}
