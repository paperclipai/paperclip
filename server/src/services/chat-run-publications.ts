import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import {
  agents,
  chatConversations,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { projectSafeChatPublication } from "./chat-publication-projection.js";
import { safeChatTaskUrl } from "./chat-task-url.js";
import { hasChatRunOwnedProviderInteraction } from "./chat-interaction-arbitration.js";
import { CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON } from "./heartbeat-run-summary.js";
import { resolveChatOriginPublicationBindings } from "./issues.js";
import { authorizeNativeChatReviewPresentation } from "./native-runtime/native-chat-review-presentation.js";
import {
  SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
  safeNativeChatProgressForEvent,
} from "./safe-native-chat-progress.js";

type SafeRunMilestone =
  "queued" | "working" | "waiting_for_input" | "completed" | "failed";

const OWNERSHIP_ATTENTION_CODES = [
  "native_execution_ownership_unverified",
  "native_adopted_runner_authentication_timeout",
] as const;

export { CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON };

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
  const [run] = await db
    .select({ resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (
    run?.resultJson?.finalizationReasonCode === "governed_response_waiting" &&
    !(await authorizeNativeChatReviewPresentation(db, {
      ...input,
      resultJson: run.resultJson,
    }))
  ) {
    return "internal_agent_write";
  }
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
  if (await hasChatRunOwnedProviderInteraction(db, input)) {
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

type SafeNativeChatProgressCandidate = {
  eventId: number;
  eventSeq: number;
  eventType: string;
  eventCreatedAt: Date;
  runId: string;
  agentId: string;
  issueId: string;
  companyId: string;
  endpointId: string;
  conversationId: string;
  agentName: string;
};

const SAFE_NATIVE_CHAT_PROGRESS_CADENCE_MS = 20_000;

function milestoneForStatus(
  status: string,
  errorCode: string | null,
): SafeRunMilestone | null {
  if (status === "queued") return "queued";
  if (
    status === "running" &&
    OWNERSHIP_ATTENTION_CODES.some((code) => code === errorCode)
  )
    return "waiting_for_input";
  if (status === "running") return "working";
  if (status === "succeeded") return "completed";
  if (["interrupted", "failed", "timed_out", "cancelled"].includes(status))
    return "failed";
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
  if (input.errorCode === "slack_session_stopped")
    return `${input.agentName} stopped at your request.`;
  const taskUrl = safeChatTaskUrl(input.publicBaseUrl, input.issueId);
  const recovery =
    input.milestone === "waiting_for_input"
      ? `${input.agentName} needs a Paperclip admin to safely recover this turn before more work can start.`
      : input.errorCode === "low_trust_isolation_unavailable"
        ? `${input.agentName} couldn't safely start this turn because this task was started for an unlinked external guest and isolated guest execution isn't available. Ask a Paperclip admin to create a private identity link for this account or enable isolated guest execution, then start a new task.`
        : input.errorCode === "native_provider_usage_limit"
          ? `${input.agentName} couldn't complete this turn because the model provider's usage allowance is exhausted. A Paperclip admin needs to restore capacity before retrying.`
          : input.errorCode === "native_event_replay_conflict"
            ? `${input.agentName} couldn't safely continue this turn. A Paperclip admin needs to review the run before it can be retried.`
            : input.errorCode === "native_session_cleanup_quarantined"
              ? `${input.agentName} couldn't start this turn because an earlier session needs recovery. Your request is saved. Ask a Paperclip admin to recover that session before retrying; sending the request again won't repair it.`
              : `${input.agentName} stopped before completing this turn.`;
  return `${recovery}${
    taskUrl
      ? ` Open the task in Paperclip: ${taskUrl}`
      : " Open the task in Paperclip for details."
  }`;
}

/**
 * Projects a bounded sample of native activity into the existing run working
 * lane. The selector intentionally reads only event identity, type, sequence,
 * and time; native messages and payloads stay inside Paperclip.
 */
async function enqueueSafeNativeChatProgress(
  db: Db,
  input: { since: Date; limit: number },
): Promise<number> {
  const basePublication = alias(
    chatPublications,
    "safe_native_progress_base_publication",
  );
  const laterEvent = alias(
    heartbeatRunEvents,
    "safe_native_progress_later_event",
  );
  const issueIdFromContext = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  let inserted = 0;
  let cursor: {
    eventCreatedAt: Date;
    runId: string;
    conversationId: string;
  } | null = null;

  while (inserted < input.limit) {
    const pageSize = Math.max(25, Math.min(200, input.limit - inserted));
    const pageCursor: typeof cursor = cursor;
    const rows: SafeNativeChatProgressCandidate[] = await db
      .select({
        eventId: heartbeatRunEvents.id,
        eventSeq: heartbeatRunEvents.seq,
        eventType: heartbeatRunEvents.eventType,
        eventCreatedAt: heartbeatRunEvents.createdAt,
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        issueId: chatConversations.issueId,
        companyId: chatConversations.companyId,
        endpointId: chatConversations.endpointId,
        conversationId: chatConversations.id,
        agentName: agents.name,
      })
      .from(heartbeatRunEvents)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, heartbeatRunEvents.runId),
          eq(heartbeatRuns.companyId, heartbeatRunEvents.companyId),
          eq(heartbeatRuns.agentId, heartbeatRunEvents.agentId),
          eq(heartbeatRuns.runtimeMode, "native"),
          eq(heartbeatRuns.status, "running"),
        ),
      )
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
          eq(chatEndpoints.publicationMode, "automatic"),
          eq(chatEndpoints.assignedAgentId, heartbeatRuns.agentId),
        ),
      )
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .innerJoin(
        basePublication,
        and(
          eq(basePublication.companyId, heartbeatRuns.companyId),
          eq(basePublication.endpointId, chatConversations.endpointId),
          eq(basePublication.conversationId, chatConversations.id),
          eq(basePublication.issueId, chatConversations.issueId),
          sql`${basePublication.idempotencyKey} = 'run:' || ${heartbeatRuns.id}::text || ':working:' || ${chatConversations.endpointId}::text`,
          inArray(basePublication.state, [
            "pending",
            "retry",
            "streaming",
            "published",
          ]),
        ),
      )
      .where(
        and(
          inArray(heartbeatRunEvents.eventType, [
            ...SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
          ]),
          gte(heartbeatRunEvents.createdAt, input.since),
          sql`${heartbeatRunEvents.createdAt} >= ${basePublication.createdAt} + interval '20 seconds'`,
          notExists(
            db
              .select({ id: laterEvent.id })
              .from(laterEvent)
              .where(
                and(
                  eq(laterEvent.companyId, heartbeatRunEvents.companyId),
                  eq(laterEvent.runId, heartbeatRunEvents.runId),
                  gt(laterEvent.seq, heartbeatRunEvents.seq),
                  inArray(laterEvent.eventType, [
                    ...SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
                  ]),
                ),
              ),
          ),
          pageCursor
            ? or(
                gt(heartbeatRunEvents.createdAt, pageCursor.eventCreatedAt),
                and(
                  eq(heartbeatRunEvents.createdAt, pageCursor.eventCreatedAt),
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
        asc(heartbeatRunEvents.createdAt),
        asc(heartbeatRuns.id),
        asc(chatConversations.id),
      )
      .limit(pageSize);
    if (rows.length === 0) break;
    const lastRow = rows.at(-1)!;
    cursor = {
      eventCreatedAt: lastRow.eventCreatedAt,
      runId: lastRow.runId,
      conversationId: lastRow.conversationId,
    };

    for (const row of rows) {
      if (inserted >= input.limit) break;
      const result = await db.transaction(async (tx) => {
        // Keep the normal issue -> run order used by native finalization. The
        // publication insert takes an issue FK lock, so locking the run first
        // would invert that order against a concurrent terminal commit. A
        // contended issue/run is optional progress, not a reason to hold other
        // chats: skip it now and revisit it with a fresh cursor next sweep.
        const currentIssue = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.id, row.issueId),
              eq(issues.companyId, row.companyId),
            ),
          )
          .for("update", { skipLocked: true })
          .then((currentRows) => currentRows[0] ?? null);
        if (!currentIssue) return 0;
        // Native event admission serializes on the run row. Taking the same
        // short lock makes terminal status, a later event, or a final comment
        // win before this non-terminal projection can be inserted.
        const currentRun = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, row.runId),
              eq(heartbeatRuns.companyId, row.companyId),
              eq(heartbeatRuns.agentId, row.agentId),
              eq(heartbeatRuns.runtimeMode, "native"),
              eq(heartbeatRuns.status, "running"),
            ),
          )
          .for("update", { skipLocked: true })
          .then((currentRows) => currentRows[0] ?? null);
        if (!currentRun) return 0;

        const destination = await tx
          .select({ id: chatConversations.id })
          .from(chatConversations)
          .innerJoin(
            chatEndpoints,
            and(
              eq(chatEndpoints.companyId, chatConversations.companyId),
              eq(chatEndpoints.id, chatConversations.endpointId),
          eq(chatEndpoints.publicationMode, "automatic"),
              eq(chatEndpoints.assignedAgentId, row.agentId),
            ),
          )
          .where(
            and(
              eq(chatConversations.companyId, row.companyId),
              eq(chatConversations.id, row.conversationId),
              eq(chatConversations.endpointId, row.endpointId),
              eq(chatConversations.issueId, row.issueId),
              inArray(chatConversations.state, ["active", "waiting"]),
            ),
          )
          .limit(1)
          .then((currentRows) => currentRows[0] ?? null);
        if (!destination) return 0;

        const [currentEvent] = await tx
          .select({
            id: heartbeatRunEvents.id,
            seq: heartbeatRunEvents.seq,
            eventType: heartbeatRunEvents.eventType,
            createdAt: heartbeatRunEvents.createdAt,
          })
          .from(heartbeatRunEvents)
          .where(
            and(
              eq(heartbeatRunEvents.companyId, row.companyId),
              eq(heartbeatRunEvents.runId, row.runId),
              inArray(heartbeatRunEvents.eventType, [
                ...SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
              ]),
            ),
          )
          .orderBy(desc(heartbeatRunEvents.seq), desc(heartbeatRunEvents.id))
          .limit(1);
        if (
          !currentEvent ||
          currentEvent.id !== row.eventId ||
          currentEvent.seq !== row.eventSeq ||
          currentEvent.eventType !== row.eventType
        ) {
          return 0;
        }
        const progress = safeNativeChatProgressForEvent(
          currentEvent.eventType,
          row.agentName,
        );
        if (!progress) return 0;

        const baseKey = `run:${row.runId}:working:${row.endpointId}`;
        const [currentBase] = await tx
          .select({ createdAt: chatPublications.createdAt })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, row.companyId),
              eq(chatPublications.endpointId, row.endpointId),
              eq(chatPublications.conversationId, row.conversationId),
              eq(chatPublications.issueId, row.issueId),
              eq(chatPublications.idempotencyKey, baseKey),
              inArray(chatPublications.state, [
                "pending",
                "retry",
                "streaming",
                "published",
              ]),
            ),
          )
          .limit(1);
        if (!currentBase) return 0;

        const progressKeyPrefix = `${baseKey}:native:`;
        const previousProgress = await tx
          .select({
            createdAt: chatPublications.createdAt,
            idempotencyKey: chatPublications.idempotencyKey,
          })
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, row.companyId),
              eq(chatPublications.endpointId, row.endpointId),
              eq(chatPublications.conversationId, row.conversationId),
              eq(chatPublications.issueId, row.issueId),
              like(chatPublications.idempotencyKey, `${progressKeyPrefix}%`),
            ),
          );
        if (
          previousProgress.some((publication) =>
            publication.idempotencyKey.startsWith(
              `${progressKeyPrefix}${progress.phase}:`,
            ),
          )
        ) {
          return 0;
        }
        const lastProgressAt = Math.max(
          currentBase.createdAt.getTime(),
          ...previousProgress.map((publication) =>
            publication.createdAt.getTime(),
          ),
        );
        if (
          currentEvent.createdAt.getTime() - lastProgressAt <
          SAFE_NATIVE_CHAT_PROGRESS_CADENCE_MS
        ) {
          return 0;
        }

        const bindings = await resolveChatOriginPublicationBindings(
          tx,
          row.companyId,
          row.issueId,
          row.runId,
        );
        if (
          !bindings.some(
            (binding) =>
              binding.endpointId === row.endpointId &&
              binding.conversationId === row.conversationId,
          )
        ) {
          return 0;
        }
        if (
          await hasChatRunOwnedProviderInteraction(tx, {
            companyId: row.companyId,
            issueId: row.issueId,
            runId: row.runId,
          })
        ) {
          return 0;
        }
        const explicitlyAuthoredFinal = await tx
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
              eq(chatPublications.issueId, row.issueId),
              eq(issueComments.authorType, "agent"),
              eq(issueComments.createdByRunId, row.runId),
              sql`(
                ${issueComments.metadata} ->> 'authorizationReason' = 'paperclip_runner_protocol'
                or left(coalesce(${issueComments.metadata} ->> 'authorizationReason', ''), 6) = 'allow_'
              )`,
            ),
          )
          .limit(1);
        if (explicitlyAuthoredFinal.length > 0) return 0;

        const insertedRows = await tx
          .insert(chatPublications)
          .values({
            companyId: row.companyId,
            endpointId: row.endpointId,
            conversationId: row.conversationId,
            issueId: row.issueId,
            idempotencyKey: `${progressKeyPrefix}${progress.phase}:${currentEvent.seq}`,
            payload: projectSafeChatPublication({
              classification: "external",
              source: "safe_milestone",
              text: progress.text,
              progressState: "working",
            }),
            state: "pending",
          })
          .onConflictDoNothing()
          .returning({ id: chatPublications.id });
        return insertedRows.length;
      });
      inserted += result;
    }
    if (rows.length < pageSize) break;
  }
  return inserted;
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
    when ${heartbeatRuns.status} = 'running'
      and ${inArray(heartbeatRuns.errorCode, [...OWNERSHIP_ATTENTION_CODES])}
      then 'waiting_for_input'
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
  const providerInteractionCache = new Map<string, boolean>();
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
          eq(chatEndpoints.publicationMode, "automatic"),
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
            "interrupted",
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
          // A successful or interrupted run's selected final remains its
          // authoritative response. Filter it before LIMIT so a page of settled
          // runs cannot starve later milestones.
          or(
            and(
              ne(heartbeatRuns.status, "succeeded"),
              ne(heartbeatRuns.status, "interrupted"),
            ),
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
      const milestone = milestoneForStatus(row.runStatus, row.runErrorCode);
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
      if (milestone === "completed" || milestone === "failed") {
        let hasProviderInteraction =
          providerInteractionCache.get(bindingCacheKey);
        if (hasProviderInteraction === undefined) {
          hasProviderInteraction = await hasChatRunOwnedProviderInteraction(
            db,
            {
              companyId: row.companyId,
              issueId: row.issueId,
              runId: row.runId,
            },
          );
          providerInteractionCache.set(bindingCacheKey, hasProviderInteraction);
        }
        if (hasProviderInteraction) continue;
      }
      if (milestone === "completed" || row.runStatus === "interrupted") {
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
  if (inserted < limit) {
    inserted += await enqueueSafeNativeChatProgress(db, {
      since,
      limit: limit - inserted,
    });
  }
  return inserted;
}
