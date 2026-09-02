import { and, asc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { deliverAgentUnblockNotification, ROUTABLE_BLOCKED_ROLLOUT_AT } from "./routable-blocked.js";

// `deliverAgentUnblockNotification` has exactly one call site
// (routes/issues.ts, guarded by `enteringBlocked` — the not-blocked -> blocked
// edge). Every write site that can leave a row `status: "blocked"` with a
// stamp but without ever crossing that edge in the caller's process — a
// historical backfill, `deriveBlockedEntryPatch`'s own self-heal branches
// (issues.ts's `update()` third branch, `release()`, the heartbeat
// pre-dispatch guard, `create()`, `importIssues()`), a restore from backup,
// or a direct DB fix — stamps the row without ever attempting the
// notification. The row then looks healthy (`isProspectiveBlockedTransition`
// is true) but is permanently unnotifiable: nothing re-evaluates the
// predicate after the edge has passed.
//
// This sweep is that re-evaluation. It runs on the existing heartbeat
// scheduler tick (see index.ts) rather than standing up new scheduling
// infrastructure, and it is safe to run on every tick:
//
// - The candidate query is a narrow, indexed-friendly filter (status,
//   notified-at, descriptor presence), not a full-table scan.
// - `deliverAgentUnblockNotification` is itself idempotent — it no-ops on a
//   board-owned descriptor, an already-notified row, or a stamp older than
//   the rollout cutover — so calling it unconditionally for every candidate
//   is always safe, exactly like `deriveBlockedEntryPatch` being safe to
//   call unconditionally on every write to a blocked row.
// - The wakeup's own `issue-unblock:{id}:{stamp}` idempotency key already
//   prevents a duplicate wake if this sweep and the edge-triggered path in
//   routes/issues.ts ever race on the same transition.
export const MAX_BLOCKED_OWNER_NOTIFICATION_CANDIDATES = 250;

export function blockedOwnerNotificationReconcilerService(
  db: Db,
  deps: {
    wakeup: (
      agentId: string,
      opts: {
        source?: "timer" | "assignment" | "on_demand" | "automation";
        triggerDetail?: "manual" | "ping" | "callback" | "system";
        reason?: string | null;
        idempotencyKey?: string | null;
        payload?: Record<string, unknown> | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  },
) {
  async function reconcileBlockedOwnerNotifications(opts?: { companyId?: string }) {
    // The batch must contain only rows this sweep can actually deliver.
    // `deliverAgentUnblockNotification` no-ops on a board-owned descriptor and
    // on a stamp older than the rollout cutover, and those two classes are
    // permanent: the row never becomes deliverable by being looked at again.
    // Left in the query, enough of them fill the whole limit on every tick and
    // the deliverable rows behind them are never reached. Excluding them in SQL
    // means every row in the batch can make progress, so the backlog drains.
    // Oldest transition first, so a large backlog drains in a fair order rather
    // than an arbitrary one.
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
          visibleIssueCondition(),
          eq(issues.status, "blocked"),
          isNotNull(issues.unblockDescriptor),
          isNull(issues.blockedOwnerNotifiedAt),
          gte(issues.blockedTransitionAt, ROUTABLE_BLOCKED_ROLLOUT_AT),
          sql`${issues.unblockDescriptor} -> 'owner' ->> 'agentId' is not null`,
        ),
      )
      .orderBy(asc(issues.blockedTransitionAt))
      .limit(MAX_BLOCKED_OWNER_NOTIFICATION_CANDIDATES);

    const result = {
      scanned: candidates.length,
      notified: 0,
      skipped: 0,
      failed: 0,
      notifiedIssueIds: [] as string[],
      failedIssueIds: [] as string[],
    };

    for (const candidate of candidates) {
      try {
        // Both are guaranteed non-null by the candidate query's own filters;
        // the narrowing is for the type checker and for safety if that query
        // is ever loosened.
        const candidateStamp = candidate.blockedTransitionAt;
        const candidateOwner = candidate.unblockDescriptor?.owner;
        const candidateOwnerAgentId =
          candidateOwner && candidateOwner !== "board" && "agentId" in candidateOwner
            ? candidateOwner.agentId
            : null;
        if (!candidateStamp || !candidateOwnerAgentId) {
          result.skipped += 1;
          continue;
        }
        let notifiedAt: Date | null = null;
        const delivered = await deliverAgentUnblockNotification({
          issue: candidate,
          wakeup: deps.wakeup,
          markNotified: async (at) => {
            notifiedAt = at;
          },
        });
        if (!delivered || !notifiedAt) {
          // Board-owned descriptor (covered live by the attention feed, not
          // this sweep), a stamp predating the rollout cutover, or a race
          // with the edge-triggered path that already notified — all
          // legitimate no-ops, not failures.
          result.skipped += 1;
          continue;
        }
        // Compare-and-set against the snapshot this wake was built from. The
        // row can move between the select and this write: it can exit and
        // re-enter `blocked` (new stamp, new cycle), have its owner changed,
        // or be notified by the edge-triggered path in routes/issues.ts.
        // Without the fence, this write stamps whatever cycle is current now
        // as notified, using a wake that went to the previous cycle or the
        // previous owner — and the current cycle is then excluded from every
        // later sweep, so its owner is never woken. Matching the stamp, the
        // owner and the still-null notified-at makes the write apply only to
        // the exact row state that was delivered for.
        const applied = await db
          .update(issues)
          .set({ blockedOwnerNotifiedAt: notifiedAt })
          .where(and(
            eq(issues.id, candidate.id),
            eq(issues.companyId, candidate.companyId),
            eq(issues.blockedTransitionAt, candidateStamp),
            isNull(issues.blockedOwnerNotifiedAt),
            sql`${issues.unblockDescriptor} -> 'owner' ->> 'agentId' = ${candidateOwnerAgentId}`,
          ))
          .returning({ id: issues.id });
        if (applied.length === 0) {
          // The row moved under us. The wake we sent carries the cycle key of
          // the snapshot, so it cannot double-notify that cycle, and the
          // current state stays eligible for the next sweep.
          result.skipped += 1;
          continue;
        }
        result.notified += 1;
        result.notifiedIssueIds.push(candidate.id);
      } catch (err) {
        result.failed += 1;
        result.failedIssueIds.push(candidate.id);
        logger.warn(
          { err, companyId: candidate.companyId, issueId: candidate.id },
          "blocked-owner notification reconciliation failed for a candidate issue",
        );
      }
    }

    return result;
  }

  return { reconcileBlockedOwnerNotifications };
}
