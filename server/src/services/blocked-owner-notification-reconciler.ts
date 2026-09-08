import { and, asc, desc, eq, gte, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
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

// A delivery that throws — an agent that was deleted, disabled, is over
// budget, or is otherwise uninvokable — leaves its row eligible, because
// nothing was delivered and so nothing may be marked notified. Ordering the
// batch by oldest transition then puts that row at the head of every
// subsequent batch: it fails again, stays eligible, and holds its slot
// forever. Enough of them fill the limit and the rows behind them are never
// reached — the same starvation the ordering was added to fix, arrived at
// from the other direction.
//
// So a row that fails delivery goes into a cooldown and is excluded from the
// candidate query until it expires. The backoff doubles per consecutive
// failure up to a cap, so a permanently broken row costs one attempt per cap
// window instead of one per tick, and a transiently broken one recovers
// quickly. The map is per process and is not persisted: losing it on restart
// only means one extra attempt per row, which is the safe direction to fail.
//
// The cooldown is a rate limit on retries, not what carries the sweep past a
// failing row. That is the cursor's job (below). The map is bounded, and once
// more rows fail than it can hold, every new failure evicts an older one,
// which is eligible again at once. If the batch always restarted from the
// oldest stamp, those evicted rows would head it on every tick and the rows
// behind them would never be reached — so the bound of an in-process map
// would decide whether a deliverable row was ever seen. With the cursor, an
// evicted row is only re-attempted when the sweep comes round to it again,
// and the bound decides only how often a broken row is retried.
export const DELIVERY_FAILURE_BASE_COOLDOWN_MS = 60_000;
export const DELIVERY_FAILURE_MAX_COOLDOWN_MS = 60 * 60_000;
export const MAX_TRACKED_DELIVERY_FAILURES = 5_000;

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
    /** Injectable clock, for exercising the delivery-failure backoff in tests. */
    now?: () => Date;
  },
) {
  const deliveryFailures = new Map<string, { consecutive: number; retryAfter: number }>();

  function recordDeliveryFailure(issueId: string, now: number) {
    const previous = deliveryFailures.get(issueId);
    const consecutive = (previous?.consecutive ?? 0) + 1;
    const backoff = Math.min(
      DELIVERY_FAILURE_BASE_COOLDOWN_MS * 2 ** (consecutive - 1),
      DELIVERY_FAILURE_MAX_COOLDOWN_MS,
    );
    deliveryFailures.set(issueId, { consecutive, retryAfter: now + backoff });
    // Bounded: drop the entries closest to being retried first, so the
    // longest-backed-off (most broken) rows keep their cooldown.
    if (deliveryFailures.size > MAX_TRACKED_DELIVERY_FAILURES) {
      const byRetrySoonest = [...deliveryFailures.entries()].sort((a, b) => a[1].retryAfter - b[1].retryAfter);
      for (const [id] of byRetrySoonest.slice(0, deliveryFailures.size - MAX_TRACKED_DELIVERY_FAILURES)) {
        deliveryFailures.delete(id);
      }
    }
  }

  function cooldownIssueIds(now: number): string[] {
    const cooling: string[] = [];
    for (const [issueId, state] of deliveryFailures) {
      if (state.retryAfter > now) cooling.push(issueId);
      else deliveryFailures.delete(issueId);
    }
    return cooling;
  }

  // Where the previous tick's batch ended, per sweep scope. The next tick
  // resumes strictly after it, so a batch never restarts from the head of the
  // queue while there are rows further along that have not had a turn. The
  // key is (stamp, id): stamps can tie, and id breaks the tie
  // deterministically so no row is skipped or repeated at a boundary.
  //
  // A pass is bounded to the rows that were eligible when it started: its
  // end key is read once, at the first tick of the pass, and the cursor wraps
  // to the head as soon as a batch reaches that key — or comes back short,
  // whichever is first. Without the bound, a backlog that refills every batch
  // (new rows arriving faster than a batch drains them) would keep the cursor
  // advancing forever, and a row behind it — a failure whose cooldown has
  // expired, or a row made eligible with an older stamp — would never be
  // reached. With it, a pass is at most ceil(N / batch) ticks for the N rows
  // that existed at its start, and every row behind the cursor gets its turn
  // on the next pass.
  const cursors = new Map<string, { blockedTransitionAt: Date; id: string; passEnd: CursorKey }>();

  type CursorKey = { blockedTransitionAt: Date; id: string };

  function compareCursorKeys(a: CursorKey, b: CursorKey): number {
    const byStamp = a.blockedTransitionAt.getTime() - b.blockedTransitionAt.getTime();
    if (byStamp !== 0) return byStamp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  // The greatest (stamp, id) among the rows the sweep could ever select, read
  // once at the start of a pass. Cooldown is deliberately not applied here: a
  // cooling row is still part of the queue, and excluding it would let the
  // pass end early whenever the tail happens to be failing.
  async function readPassEnd(companyId?: string): Promise<CursorKey | null> {
    const [row] = await db
      .select({ blockedTransitionAt: issues.blockedTransitionAt, id: issues.id })
      .from(issues)
      .where(and(...eligibilityConditions(companyId)))
      .orderBy(desc(issues.blockedTransitionAt), desc(issues.id))
      .limit(1);
    return row?.blockedTransitionAt ? { blockedTransitionAt: row.blockedTransitionAt, id: row.id } : null;
  }

  function eligibilityConditions(companyId?: string) {
    return [
      companyId ? eq(issues.companyId, companyId) : undefined,
      visibleIssueCondition(),
      eq(issues.status, "blocked"),
      isNotNull(issues.unblockDescriptor),
      isNull(issues.blockedOwnerNotifiedAt),
      gte(issues.blockedTransitionAt, ROUTABLE_BLOCKED_ROLLOUT_AT),
      sql`${issues.unblockDescriptor} -> 'owner' ->> 'agentId' is not null`,
    ];
  }

  async function reconcileBlockedOwnerNotifications(opts?: { companyId?: string }) {
    const tickStartedAt = (deps.now ?? (() => new Date()))().getTime();
    const coolingDown = cooldownIssueIds(tickStartedAt);
    const cursorKey = opts?.companyId ?? "";
    const cursor = cursors.get(cursorKey);
    // The batch must contain only rows this sweep can actually deliver.
    // `deliverAgentUnblockNotification` no-ops on a board-owned descriptor and
    // on a stamp older than the rollout cutover, and those two classes are
    // permanent: the row never becomes deliverable by being looked at again.
    // Left in the query, enough of them fill the whole limit on every tick and
    // the deliverable rows behind them are never reached. Excluding them in SQL
    // means every row in the batch can make progress, so the backlog drains.
    // Oldest transition first, so a large backlog drains in a fair order rather
    // than an arbitrary one; resumed from the cursor, so a row that stays
    // eligible after its turn — a delivery that failed, a fence that did not
    // apply — cannot take the head of the next batch away from the rows that
    // have not yet been reached. Every eligible row gets a turn per pass over
    // the queue, however many rows ahead of it are broken.
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          ...eligibilityConditions(opts?.companyId),
          coolingDown.length > 0 ? notInArray(issues.id, coolingDown) : undefined,
          cursor
            ? sql`(${issues.blockedTransitionAt}, ${issues.id}) > (${cursor.blockedTransitionAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(issues.blockedTransitionAt), asc(issues.id))
      .limit(MAX_BLOCKED_OWNER_NOTIFICATION_CANDIDATES);

    const last = candidates.at(-1);
    const passEnd = cursor?.passEnd ?? (last?.blockedTransitionAt ? await readPassEnd(opts?.companyId) : null);
    if (
      candidates.length < MAX_BLOCKED_OWNER_NOTIFICATION_CANDIDATES ||
      !last?.blockedTransitionAt ||
      !passEnd ||
      compareCursorKeys({ blockedTransitionAt: last.blockedTransitionAt, id: last.id }, passEnd) >= 0
    ) {
      // Short batch, or the batch reached the last row that was eligible when
      // this pass began: the pass is complete. Start from the head next tick.
      cursors.delete(cursorKey);
    } else {
      cursors.set(cursorKey, { blockedTransitionAt: last.blockedTransitionAt, id: last.id, passEnd });
    }

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
        // re-enter `blocked` (new stamp, new cycle), have its descriptor
        // changed, or be notified by the edge-triggered path in
        // routes/issues.ts. Without the fence, this write stamps whatever
        // state is current now as notified, using a wake built for the
        // previous one — and the current state is then excluded from every
        // later sweep, so its owner is never woken.
        //
        // The descriptor is matched whole, not just its owner. `action` is
        // delivered in the wake payload, so a descriptor whose action changed
        // during delivery is a different request even when the owner and the
        // stamp are unchanged: the wake carried the old action, and marking
        // the new one notified would retire a request nobody was told about.
        // jsonb equality is key-order insensitive, and matching the whole
        // value also covers fields added to the descriptor later.
        const applied = await db
          .update(issues)
          .set({ blockedOwnerNotifiedAt: notifiedAt })
          .where(and(
            eq(issues.id, candidate.id),
            eq(issues.companyId, candidate.companyId),
            eq(issues.blockedTransitionAt, candidateStamp),
            isNull(issues.blockedOwnerNotifiedAt),
            sql`${issues.unblockDescriptor} = ${JSON.stringify(candidate.unblockDescriptor)}::jsonb`,
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
        recordDeliveryFailure(candidate.id, tickStartedAt);
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
