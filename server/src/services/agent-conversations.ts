import {
  persistActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import type { NativeStatusDecision } from "./native-runtime/status-arbiter.js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueTreeHolds,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";

import { sanitizeQuarantinedCommentForHigherTrust } from "./source-trust.js";

export type ConversationIdentity = {
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
  conversationState?: string | null;
  status?: string;
};
export function isConversation(
  issue: ConversationIdentity | null | undefined,
): boolean {
  return Boolean(issue?.conversationAgentId && issue.conversationUserId);
}
export function isWaitingConversation(
  issue: ConversationIdentity | null | undefined,
): boolean {
  return (
    isConversation(issue) &&
    issue?.conversationState === "waiting" &&
    issue.status === "in_review"
  );
}

/** Recovery for an older turn must not replace a reset or an answered chat. */
export function isSupersededConversationRun(
  issue: ConversationIdentity & {
    conversationSessionGeneration?: number;
    executionRunId?: string | null;
  },
  run: { id: string; contextSnapshot: Record<string, unknown> | null },
): boolean {
  if (!isConversation(issue)) return false;
  const generation = run.contextSnapshot?.conversationSessionGeneration;
  return (
    (typeof generation === "number" &&
      typeof issue.conversationSessionGeneration === "number" &&
      generation !== issue.conversationSessionGeneration) ||
    (typeof generation === "number" &&
      isWaitingConversation(issue) &&
      issue.executionRunId !== run.id)
  );
}
/** Execution tasks may link to a conversation, but never drive its turns.
 * Apply before enqueue, including while a reply is still running: waiting until
 * finalization is too late to prevent a deferred dependency follow-up.
 */
export function isConversationExecutionWake(
  issue: ConversationIdentity | null | undefined,
  reason: string | null | undefined,
): boolean {
  return isConversation(issue) && (
    reason === "issue_blockers_resolved" ||
    reason === "issue_children_completed" ||
    reason === "issue_unblock_requested"
  );
}

export function isConversationReset(body: string): boolean {
  return body.trim() === "/new";
}

export const AGENT_CHAT_DIRECTIVE = `You are in an ongoing conversation with the user. Help them clarify the outcome they want. Ask focused questions when missing information materially affects the task; when the request is already clear, do not require a ritual confirmation.

Research, clarify, and develop full plans here using the conversation's plan document. Revise the draft as the discussion develops. Planning alone does not create execution tasks. Put implementation and substantial execution into separate tasks.

When the user asks to approve a plan before handoff, publish the plan and create a revision-bound approval card before ending the turn. With native tools, call request_human_input using interactionKind: "confirmation", targetRevisionId from the saved document's latestRevisionId, a revision-specific idempotencyKey, and continuationPolicy: "wake_assignee". Set payload.target to { type: "issue_document", key: "plan", revisionId: latestRevisionId }. Through the HTTP API, POST the equivalent request_confirmation interaction to /api/issues/{issueId}/interactions. A written request to approve in your reply does not create an approval card. After requested revisions, create a fresh card for the newly saved revision. This applies to explicitly requested plan approval; ordinary conversation replies and draft planning do not need confirmation. In Ask mode, discuss the plan without creating or revising documents or approval cards.

Before handing off work, inspect available projects and repositories. Every task you create from this chat must belong to a suitable project. Reuse an appropriate existing project; otherwise use create_project. Consider all relevant available repositories and pass repositoryIds for one or multiple repositories when the work spans them. For existing GitHub repositories you can access that are absent from the catalog, pass their HTTPS repositoryUrls; this registers them with the project without creating remote GitHub repositories. You may combine known IDs and URLs and attach multiple repositories. The direct HTTP equivalent is POST /api/companies/{companyId}/projects with name, repositoryIds and/or repositoryUrls arrays, and an idempotencyKey. Include all selected repositories in that creation; do not combine these arrays with workspace. Never invent repository IDs or substitute inaccessible repositories. Ask when the choice is materially ambiguous or required access is missing. Non-code projects may need no repository.

Create ordinary assigned tasks, never subtasks of this conversation. Give each task a clear outcome, context, acceptance criteria, project, and appropriate assignee. Use create_task with initialPlan to copy the relevant plan into the new task before execution starts. If using the HTTP API directly, POST /api/companies/{companyId}/issues with projectId, assigneeAgentId, status: "todo", initialPlan containing the relevant plan Markdown, and an idempotencyKey; omit parentId. Putting a plan in description does not create the task's plan document. Verify the new task's plan document before claiming the handoff is complete. Preserve the original plan here. When splitting work, include the relevant part of the plan in each task. Create and link each task before claiming it exists.

Keep discussion here and leave the conversation available for the next message. Link handed-off tasks in your reply; do not make this conversation blocked by their completion or wait for them. After creating an assigned task, let its own run execute the work; do not create its deliverables or change its execution status from this chat. Reply normally and end your turn; Paperclip manages the conversation waiting state. Do not change its status, create a review confirmation just to finish a reply, mark it complete, or poll for another reply. An accepted plan authorizes handoff to execution tasks, never implementation on this conversation. Honor normal approvals. Ask mode is non-mutating. Plan mode supports research and writing/revising the plan; hand off for execution only through the normal authorized workflow.`;

/** A reset keeps history visible, but parked input from a stopped session cannot become a new turn. */
export function currentConversationCommentCondition() {
  return sql`not exists (
    select 1 from ${issues} conversation_issue
    join ${issueComments} conversation_boundary
      on conversation_boundary.id = conversation_issue.conversation_boundary_comment_id
      and conversation_boundary.company_id = conversation_issue.company_id
      and conversation_boundary.issue_id = conversation_issue.id
    where conversation_issue.id = ${issueComments.issueId}
      and conversation_issue.company_id = ${issueComments.companyId}
      and conversation_issue.conversation_agent_id is not null
      and (${issueComments.createdAt}, ${issueComments.id}) < (conversation_boundary.created_at, conversation_boundary.id)
  )`;
}

/** Runs under the normal issue execution lock, before any provider session is read. */
export async function prepareConversationTurn(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = { ...(run.contextSnapshot ?? {}) };
  const issueId = typeof context.issueId === "string" ? context.issueId : null;
  if (!issueId) return { context, reset: false, conversation: false };
  let publication: ActivityPublication | null = null;
  const result = await db.transaction(async (tx) => {
    const [issue] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .for("update");
    if (!isConversation(issue))
      return { context, reset: false, conversation: false };
    const commentId =
      typeof context.wakeCommentId === "string"
        ? context.wakeCommentId
        : typeof context.commentId === "string"
          ? context.commentId
          : null;
    const [comment] = commentId
      ? await tx
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.id, commentId),
              eq(issueComments.issueId, issueId),
              eq(issueComments.companyId, run.companyId),
            ),
          )
      : [];
    const reset = Boolean(
      comment && comment.authorUserId && isConversationReset(comment.body),
    );
    let generation = issue.conversationSessionGeneration;
    if (
      typeof context.conversationSessionGeneration === "number" &&
      context.conversationSessionGeneration !== generation
    ) {
      throw new Error(
        "Conversation session changed; this older turn cannot resume",
      );
    }
    // The boundary lives on the command comment. A crash/retry reuses it instead of resetting twice.
    if (reset && comment && comment.conversationSessionGeneration == null) {
      generation += 1;
      await tx
        .update(issues)
        .set({
          conversationSessionGeneration: generation,
          conversationBoundaryCommentId: comment.id,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));
      await tx
        .update(issueComments)
        .set({ conversationSessionGeneration: generation })
        .where(eq(issueComments.id, comment.id));
      // Questions from the previous session must not keep occupying the
      // composer or wake the old topic, even if they survive normal comments.
      const expiredQuestions = await tx.update(issueThreadInteractions).set({
        status: "expired", resolvedAt: new Date(), updatedAt: new Date(),
        resolvedByUserId: comment.authorUserId,
        result: { version: 1, outcome: "withdrawn", reason: "New conversation session", answers: [], summaryMarkdown: null },
      }).where(and(eq(issueThreadInteractions.companyId, issue.companyId),
        eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.kind, "ask_user_questions"))).returning({ id: issueThreadInteractions.id });
      publication = (
        await persistActivity(tx as unknown as Db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "conversation",
          action: "issue.conversation_session_started",
          entityType: "issue",
          entityId: issue.id,
          runId: run.id,
          details: { generation, boundaryCommentId: comment.id, expiredInteractionIds: expiredQuestions.map((row) => row.id) },
        })
      ).publication;
      // Deliberately do not touch agentRuntimeState or sessions belonging to other tasks.
      await tx
        .delete(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, issue.companyId),
            eq(agentTaskSessions.agentId, issue.conversationAgentId!),
            eq(agentTaskSessions.taskKey, issue.id),
          ),
        );
    }
    await tx
      .update(issues)
      .set({
        conversationState: "active",
        status: "in_progress",
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));
    const next = {
      ...context,
      conversationSessionGeneration: generation,
      conversationMode: true,
    };
    await tx
      .update(heartbeatRuns)
      .set({ contextSnapshot: next })
      .where(eq(heartbeatRuns.id, run.id));
    return { context: next, reset, conversation: true };
  });
  if (publication) publishActivity(publication);
  return result;
}

/** Finalizers only park a turn with a durable response, interaction, or processed /new. */
export async function settleConversationTurn(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
) {
  if (run.status !== "succeeded") return false;
  const context = run.contextSnapshot ?? {};
  const issueId = typeof context.issueId === "string" ? context.issueId : null;
  if (!issueId) return false;
  let publication: ActivityPublication | null = null;
  const settled = await db.transaction(async (tx) => {
    const [issue] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .for("update");
    if (
      !isConversation(issue) ||
      (issue.executionRunId && issue.executionRunId !== run.id)
    )
      return false;
    const [response] = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          eq(issueComments.createdByRunId, run.id),
          eq(issueComments.authorAgentId, issue.conversationAgentId!),
          isNull(issueComments.deletedAt),
        ),
      )
      .limit(1);
    // Native question/plan waits use the durable interaction as the reply;
    // their terminal prose is deliberately not materialized as a comment.
    const [interaction] = !response && context.conversationReset !== true
      ? await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.companyId, run.companyId),
            eq(issueThreadInteractions.issueId, issueId),
            eq(issueThreadInteractions.sourceRunId, run.id),
            eq(issueThreadInteractions.createdByAgentId, issue.conversationAgentId!),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .limit(1)
      : [];
    if (!response && !interaction && context.conversationReset !== true) return false;
    if (
      context.conversationSessionGeneration !==
      issue.conversationSessionGeneration
    )
      return false;
    // Messages arriving during the reply remain actionable, including the
    // crash window between their comment commit and wake enqueue.
    const wakeId =
      typeof context.wakeCommentId === "string"
        ? context.wakeCommentId
        : context.commentId;
    const [wake] =
      typeof wakeId === "string"
        ? await tx
            .select()
            .from(issueComments)
            .where(eq(issueComments.id, wakeId))
        : [];
    const [pending] = wake
      ? await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, issueId),
              isNull(issueComments.deletedAt),
              sql`${issueComments.authorUserId} is not null`,
              sql`(${issueComments.createdAt}, ${issueComments.id}) > (select cursor.created_at, cursor.id from issue_comments cursor where cursor.id = ${wake.id}::uuid)`,
            ),
          )
          .limit(1)
      : [];
    const status = pending ? "in_progress" : "in_review";
    const conversationState = pending ? "active" : "waiting";
    if (
      issue.status === status &&
      issue.conversationState === conversationState
    )
      return true;
    await tx
      .update(issues)
      .set({
        status,
        conversationState,
        statusVersion: sql`${issues.statusVersion} + 1`,
        completedAt: null,
        cancelledAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issues.id, issueId),
          sql`(${issues.executionRunId} is null or ${issues.executionRunId} = ${run.id})`,
        ),
      );
    publication = (
      await persistActivity(tx as unknown as Db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "conversation",
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        runId: run.id,
        details: {
          status,
          conversationState,
          conversationSessionGeneration: issue.conversationSessionGeneration,
        },
      })
    ).publication;
    return true;
  });
  if (publication) publishActivity(publication);
  return settled;
}

/** Fresh provider context uses only messages in this session, up to this turn. */
export async function conversationReplay(
  db: Db,
  companyId: string,
  issueId: string,
  wakeCommentId: string | null,
) {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  if (!isConversation(issue)) return "";
  const [boundary] = issue.conversationBoundaryCommentId
    ? await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, issue.conversationBoundaryCommentId))
    : [];
  const [wake] = wakeCommentId
    ? await db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.id, wakeCommentId),
            eq(issueComments.issueId, issueId),
          ),
        )
    : [];
  const rows = await db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
        boundary
          ? sql`(${issueComments.createdAt}, ${issueComments.id}) > (select cursor.created_at, cursor.id from issue_comments cursor where cursor.id = ${boundary.id}::uuid)`
          : undefined,
        wake
          ? sql`(${issueComments.createdAt}, ${issueComments.id}) < (select cursor.created_at, cursor.id from issue_comments cursor where cursor.id = ${wake.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(40);
  return rows
    .reverse()
    .map((row) =>
      JSON.stringify({
        author: row.authorAgentId ? "agent" : "user",
        body: sanitizeQuarantinedCommentForHigherTrust(row).body.slice(0, 8000),
      }),
    )
    .join("\n");
}

/** Comment rows form a durable outbox for the narrow commit-to-enqueue crash window. */
export async function undeliveredConversationComments(
  db: Db,
  companyId: string,
  issueId: string,
) {
  return db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
        sql`${issueComments.clientRequestId} is not null`,
        sql`not exists (select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${companyId}
      and ${agentWakeupRequests.idempotencyKey} = 'conversation-comment:' || ${issueComments.id}::text)`,
      ),
    )
    .orderBy(issueComments.createdAt, issueComments.id)
    .limit(100);
}

/** A user's /new resumes this chat without replaying the stopped turn. */
export async function resumeConversationForReset(db: Db, comment: typeof issueComments.$inferSelect) {
  if (!comment.authorUserId || !isConversationReset(comment.body)) return;
  const publications: ActivityPublication[] = [];
  await db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, comment.issueId), eq(issues.companyId, comment.companyId),
    )).for("update");
    if (!isConversation(issue) || comment.conversationSessionGeneration != null) return;
    const released = await tx.update(issueTreeHolds).set({
      status: "released", releasedAt: new Date(), updatedAt: new Date(),
      releasedByActorType: "user", releasedByUserId: comment.authorUserId,
      releaseReason: "Resumed by /new", releaseMetadata: { commentId: comment.id, wakeAgents: false },
    }).where(and(eq(issueTreeHolds.companyId, issue.companyId),
      eq(issueTreeHolds.rootIssueId, issue.id), eq(issueTreeHolds.mode, "pause"),
      eq(issueTreeHolds.status, "active"))).returning();
    for (const hold of released) {
      publications.push((await persistActivity(tx as unknown as Db, {
        companyId: issue.companyId, actorType: "user", actorId: comment.authorUserId!,
        action: "issue.tree_hold_released", entityType: "issue", entityId: issue.id,
        details: { holdId: hold.id, mode: "pause", reason: "Resumed by /new", commentId: comment.id },
      })).publication);
    }
  });
  for (const publication of publications) publishActivity(publication);
}

/** Serialize durable outbox delivery across API servers; the normal wake queue owns execution. */
export async function deliverConversationComments(
  db: Db,
  issue: { id: string; companyId: string; conversationAgentId: string | null },
  enqueue: (
    agentId: string,
    options: {
      source: "on_demand";
      triggerDetail: "manual";
      reason: string;
      idempotencyKey: string;
      requestedByActorType: "user";
      requestedByActorId: string | null;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    },
  ) => Promise<unknown>,
) {
  if (!issue.conversationAgentId) return;
  for (;;) {
    const delivered = await db.transaction(async (tx) => {
      // Contenders release their connection while waiting so concurrent sends
      // cannot exhaust the pool needed by normal wake admission.
      const locks = await tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${"conversation-delivery:" + issue.id}, 0)) as acquired`,
      );
      if (!locks[0]?.acquired) return false;
      for (const comment of await undeliveredConversationComments(
        tx as unknown as Db,
        issue.companyId,
        issue.id,
      )) {
        await resumeConversationForReset(db, comment);
        await enqueue(issue.conversationAgentId!, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "issue_commented",
          idempotencyKey: `conversation-comment:${comment.id}`,
          requestedByActorType: "user",
          requestedByActorId: comment.authorUserId,
          payload: { issueId: issue.id, commentId: comment.id },
          contextSnapshot: {
            issueId: issue.id,
            taskKey: issue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeCommentIds: [comment.id],
            source: "issue.comment",
          },
        });
      }
      return true;
    });
    if (delivered) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Conversation turns do not need execution-task completion evidence or a continuation. */
export function conversationNativeDecision(input: {
  conversation: boolean;
  terminalState: unknown;
  workspaceFinalizeStatus: string;
  hasGovernanceGate: boolean;
  priorStatus: NativeStatusDecision["toStatus"];
  decision: NativeStatusDecision;
}): NativeStatusDecision {
  if (
    !input.conversation ||
    input.terminalState !== "succeeded" ||
    input.workspaceFinalizeStatus !== "succeeded" ||
    input.hasGovernanceGate ||
    input.decision.statusAction === "blocked" ||
    input.decision.effects.some(
      (effect) =>
        effect.kind === "schedule_retry" ||
        effect.kind === "record_finalization_error",
    )
  )
    return input.decision;
  return {
    ...input.decision,
    statusAction: "preserve",
    toStatus: input.priorStatus,
    reasonCode: "conversation_turn_finished",
    unblockDescriptor: null,
    effects: [],
  };
}
