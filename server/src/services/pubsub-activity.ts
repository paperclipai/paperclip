import { and, asc, eq, inArray, notExists } from "drizzle-orm";
import { activityLog, pubsubActivityReceipts, type Db } from "@paperclipai/db";
import type { PubsubService } from "./pubsub.js";
import { logger } from "../middleware/logger.js";

const issueActions = ["issue.created", "issue.updated", "issue.comment_added"];

/** Read the committed journal, not live notifications: restart and late commits cannot lose events. */
export function startPubsubActivityWorker(db: Db, pubsub: PubsubService) {
  let stopped = false;
  let pending: Promise<void> | null = null;

  async function sweep() {
    const rows = await db.select().from(activityLog).where(and(
      eq(activityLog.entityType, "issue"),
      inArray(activityLog.action, issueActions),
      notExists(db.select({ id: pubsubActivityReceipts.eventId }).from(pubsubActivityReceipts).where(and(
        eq(pubsubActivityReceipts.eventId, activityLog.id),
        // The base event is recorded last, after any status-transition event.
        inArray(pubsubActivityReceipts.topic, ["fleet.task.created", "fleet.task.updated", "fleet.task.comment_added"]),
      ))),
    )).orderBy(asc(activityLog.createdAt), asc(activityLog.id)).limit(100);

    for (const row of rows) {
      if (stopped) return;
      const details = row.details ?? {};
      const changes = details.changes as Record<string, { from?: unknown; to?: unknown }> | undefined;
      const previous = details._previous as Record<string, unknown> | undefined;
      const patch = details.patch as Record<string, unknown> | undefined;
      // Producers journal status transitions in different shapes: route updates
      // carry changes plus _previous, the native status committer journals
      // fromStatus/toStatus, and plugin updates carry patch plus _previous.
      // Normalize before topic selection so none of them is silently dropped
      // by the base task receipt recorded for this event.
      const status = changes?.status?.to ?? details.status ?? details.toStatus ?? patch?.status;
      const previousStatus = changes?.status?.from ?? previous?.status ?? details.fromStatus;
      const payload = {
        eventId: row.id,
        issueId: row.entityId,
        action: row.action,
        actorType: row.actorType,
        actorId: row.actorId,
        // Carry stable references, not potentially unbounded issue descriptions
        // or comment text. Consumers fetch the source issue for its full content.
        details: {
          identifier: row.details?.identifier ?? null,
          commentId: row.details?.commentId ?? null,
          status: status ?? null,
          previousStatus: previousStatus ?? null,
        },
        createdAt: row.createdAt.toISOString(),
      };
      const input = { companyId: row.companyId, agentId: null, role: "system" as const, payload };
      if (row.action === "issue.updated") {
        const stateTopic = status !== previousStatus
          ? status === "done" ? "fleet.task.completed"
            : status === "blocked" ? "fleet.task.blocked"
              : status === "cancelled" ? "fleet.task.cancelled"
                : null
          : null;
        if (stateTopic) {
          // Status-transition events carry the fleet task-state marker: peers
          // persist them to inbox/history without a CEO wake.
          await pubsub.publishActivity(row.id, {
            ...input,
            topic: stateTopic,
            payload: { ...input.payload, review: "none" },
          });
        }
      }
      await pubsub.publishActivity(row.id, { ...input, topic: `fleet.task.${row.action.slice("issue.".length)}` });
    }
  }

  function tick() {
    if (stopped || pending) return;
    pending = sweep().catch((err) => {
      logger.error({ err }, "PubSub activity journal delivery failed; retrying durable events");
    }).finally(() => { pending = null; });
  }
  const timer = setInterval(tick, 250);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
