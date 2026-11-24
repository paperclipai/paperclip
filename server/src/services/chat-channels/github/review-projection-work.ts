import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { chatActions, chatDeliveries, chatGitHubReviews, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";

type Scope = { companyId: string; endpointId: string };
type Entry = Scope & { id: string; dueAt: number };

export async function notifyGitHubReviewProjection(tx: object, scope: Scope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatGitHubReviewProjection, JSON.stringify(scope));
}

function pendingProjection() {
  return and(
    sql`${chatGitHubReviews.state} in ('queued', 'running')`,
    isNull(chatGitHubReviews.assessment),
    sql`${chatGitHubReviews.deliveryId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    sql`(
      select action.id from ${chatActions} action
      where action.company_id = ${chatGitHubReviews.companyId}
        and action.endpoint_id = ${chatGitHubReviews.endpointId}
        and action.kind = 'github_review_check' and action.status = 'cancelled'
        and action.result->>'code' = 'stale_head'
        and action.payload->'event'->>'deliveryId' = (
          select delivery.normalized_event->'githubAutomatic'->'context'->>'deliveryId'
          from ${chatDeliveries} delivery
          where delivery.id = case
            when ${chatGitHubReviews.deliveryId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then ${chatGitHubReviews.deliveryId}::uuid end
            and delivery.endpoint_id = ${chatGitHubReviews.endpointId}
        )
      limit 1
    ) is not null`,
  );
}

export async function repairSupersededGitHubReviews(db: Db, id?: string) {
  await db.update(chatGitHubReviews).set({ state: "superseded", updatedAt: new Date() })
    .where(and(id ? eq(chatGitHubReviews.id, id) : undefined, pendingProjection()));
}

export function registerGitHubReviewProjectionWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean,
) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.chatGitHubReviewProjection,
    decodeScope: (hint: string): Scope | undefined => hint === "*" ? undefined : JSON.parse(hint),
    matches: (entry: Entry, scope?: Scope) => !scope ||
      (entry.companyId === scope.companyId && entry.endpointId === scope.endpointId),
    load: async (scope?: Scope, signal?: AbortSignal) => {
      const entries: Entry[] = [];
      let cursor: string | undefined;
      while (canRun() && !signal?.aborted) {
        const rows = await db.select({ id: chatGitHubReviews.id, companyId: chatGitHubReviews.companyId,
          endpointId: chatGitHubReviews.endpointId }).from(chatGitHubReviews).where(and(pendingProjection(),
          scope ? eq(chatGitHubReviews.companyId, scope.companyId) : undefined,
          scope ? eq(chatGitHubReviews.endpointId, scope.endpointId) : undefined,
          cursor ? gt(chatGitHubReviews.id, cursor) : undefined,
        )).orderBy(asc(chatGitHubReviews.id)).limit(100);
        entries.push(...rows.map(row => ({ ...row, dueAt: 0 })));
        if (rows.length < 100) return entries;
        cursor = rows[rows.length - 1].id;
      }
      throw signal?.reason ?? new Error("GitHub review projection recovery stopped");
    },
    check: async (entry: Entry, signal?: AbortSignal) => {
      if (!canRun() || signal?.aborted) return entry;
      await repairSupersededGitHubReviews(db, entry.id);
      return null;
    },
  }, canRun);
}
