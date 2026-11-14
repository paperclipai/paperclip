import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, chatActions, chatPublications, type Db } from "@paperclipai/db";
import type { DbOrTransaction } from "./runtime-types.js";
import { notifyChatPublicationWork } from "../chat-work-notifications.js";
import { projectSafeChatPublication } from "../chat-publication-projection.js";
import { inboundWakePublicationKey } from "../chat-inbound-wakeup-publications.js";
import { NativeChatReviewPresentationContentionError } from "../native-runtime/native-chat-review-presentation.js";
import { isExternalChatWaitAuthorizationContention } from "../native-runtime/chat-attachment-reuse.js";

export type FailedRetryNoticeScope = { companyId: string; issueId?: string };
export type FailedRetryNoticeCursor = { createdAt: string; id: string };
type Options = {
  authorize: (tx: DbOrTransaction, action: typeof chatActions.$inferSelect) => Promise<{
    endpointId: string; conversationId: string; issueId: string; commentIds: string[];
  }>;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  isShuttingDown: () => boolean;
};

export function createFailedRetryNotices(db: Db, options: Options) {
  let manualCursor: FailedRetryNoticeCursor | null = null;
  function candidateQuery(cursor: FailedRetryNoticeCursor | null, scope?: FailedRetryNoticeScope) {
    return db.select({ action: chatActions, receipt: agentWakeupRequests,
      cursorCreatedAt: sql<string>`${chatActions.createdAt}::text`,
      companyId: sql<string>`${chatActions.companyId}`.as("retry_notice_company_id"),
      issueId: sql<string>`${chatActions.payload}->>'issueId'`.as("retry_notice_issue_id"),
    }).from(chatActions).innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.id, chatActions.id), eq(agentWakeupRequests.companyId, chatActions.companyId),
    )).where(and(
      eq(chatActions.kind, "failed_run_retry"), isNull(agentWakeupRequests.runId),
      scope ? eq(chatActions.companyId, scope.companyId) : undefined,
      scope?.issueId ? sql`${chatActions.payload}->>'issueId' = ${scope.issueId}` : undefined,
      sql`${chatActions.payload}->>'issueId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
      cursor ? sql`(${chatActions.createdAt}, ${chatActions.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "cancelled", "failed", "skipped"]),
      sql`not exists (select 1 from chat_publications retry_notice where retry_notice.company_id = ${chatActions.companyId}
        and retry_notice.idempotency_key = 'wake:' || ${chatActions.id}::text || ':' ||
        case when ${agentWakeupRequests.status} = 'deferred_issue_execution' then 'queued' else 'not_started' end || ':' ||
        ${chatActions.endpointId}::text || ':' || ${chatActions.conversationId}::text)`,
    ));
  }
  async function candidates(limit: number, cursor: FailedRetryNoticeCursor | null, scope?: FailedRetryNoticeScope) {
    return candidateQuery(cursor, scope).orderBy(asc(chatActions.createdAt), asc(chatActions.id)).limit(limit);
  }
  type Candidates = Awaited<ReturnType<typeof candidates>>;
  function continuation(rows: Candidates, limit: number): FailedRetryNoticeCursor | null {
    const last = rows.at(-1);
    return rows.length === limit && last ? { createdAt: last.cursorCreatedAt, id: last.action.id } : null;
  }
  async function project(rows: Candidates, signal?: AbortSignal) {
    let inserted = 0, contended = false;
    for (const { action, receipt } of rows) {
      signal?.throwIfAborted();
      if (options.isShuttingDown()) throw new Error("Failed retry notice reconciliation stopped");
      try {
        inserted += await db.transaction(async tx => {
          const source = await options.authorize(tx, action);
          const [current] = await tx.select().from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, receipt.id)).for("update", { noWait: true });
          if (!current || current.runId || current.status !== receipt.status) return 0;
          const state = current.status === "deferred_issue_execution" ? "queued" : "not_started";
          await notifyChatPublicationWork(tx);
          return (await tx.insert(chatPublications).values({
            companyId: action.companyId, endpointId: source.endpointId, conversationId: source.conversationId,
            issueId: source.issueId, commentId: source.commentIds.at(-1)!,
            idempotencyKey: inboundWakePublicationKey(action.id, state, source.endpointId, source.conversationId),
            payload: projectSafeChatPublication({ classification: "external", source: "safe_milestone",
              text: state === "queued" ? "Your retry is queued."
                : "This retry was not started. Open the task in Paperclip for details.",
              progressState: state === "queued" ? "queued" : "failed",
            }), state: "pending",
          }).onConflictDoNothing().returning({ id: chatPublications.id })).length;
        });
      } catch (error) {
        if (isExternalChatWaitAuthorizationContention(error)
          || error instanceof NativeChatReviewPresentationContentionError) contended = true;
        else if (options.isExternalActionAuthorizationChange(error)
          || (error && typeof error === "object" && "status" in error && error.status === 409)) continue;
        else throw error;
      }
    }
    return { inserted, contended };
  }
  async function enqueueFailedChatRetryPublications(limit: number) {
    if (options.isShuttingDown()) return 0;
    const size = Math.max(1, Math.min(50, limit));
    const rows = await candidates(size, manualCursor);
    manualCursor = continuation(rows, size);
    return (await project(rows)).inserted;
  }
  async function loadFailedRetryNoticeScopes(scope?: FailedRetryNoticeScope, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (scope?.issueId) return [{ companyId: scope.companyId, issueId: scope.issueId }];
    const candidates = candidateQuery(null, scope).as("failed_retry_notice_candidates");
    return db.selectDistinct({ companyId: candidates.companyId, issueId: candidates.issueId })
      .from(candidates);
  }
  async function reconcileFailedRetryNotices(input: {
    scope: FailedRetryNoticeScope; limit?: number; cursor?: FailedRetryNoticeCursor | null; signal?: AbortSignal;
  }) {
    input.signal?.throwIfAborted();
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const rows = await candidates(limit, input.cursor ?? null, input.scope);
    return { ...await project(rows, input.signal), nextCursor: continuation(rows, limit) };
  }
  return { enqueueFailedChatRetryPublications, loadFailedRetryNoticeScopes, reconcileFailedRetryNotices };
}
