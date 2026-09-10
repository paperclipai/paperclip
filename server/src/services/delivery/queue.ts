import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  deliveryDependencies,
  deliveryQueueEntries,
  deliveryUnits,
  type Db,
} from "@paperclipai/db";
import type { DeliveryQueueEntry, DeliveryQueueStatus } from "@paperclipai/shared";

export const DELIVERY_QUEUE_LEASE_MS = 5 * 60 * 1000;
export const DELIVERY_QUEUE_MAX_ATTEMPTS = 5;

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function deliveryPriorityRank(priority: string) {
  return PRIORITY_RANK[priority] ?? PRIORITY_RANK.medium!;
}

/**
 * Durable merge queue, keyed by canonical repository + target branch.
 *
 * The queue is shared by every company project that delivers into the same
 * repository, so cross-project collisions serialize on the same rows. A lease
 * always expires; `reconcileExpiredLeases` returns abandoned work to `queued`
 * rather than leaving an indefinite local lock.
 */
export function deliveryQueueService(db: Db): DeliveryQueueService {
  async function enqueue(input: {
    companyId: string;
    repositoryId: string;
    targetBranch: string;
    unitId: string;
    priority: string;
    readyAt?: Date | null;
  }) {
    const now = new Date();
    const [entry] = await db
      .insert(deliveryQueueEntries)
      .values({
        companyId: input.companyId,
        repositoryId: input.repositoryId,
        targetBranch: input.targetBranch,
        unitId: input.unitId,
        priority: input.priority,
        status: "queued",
        enqueuedAt: now,
        readyAt: input.readyAt ?? now,
      })
      .onConflictDoUpdate({
        target: [deliveryQueueEntries.repositoryId, deliveryQueueEntries.targetBranch, deliveryQueueEntries.unitId],
        set: {
          status: "queued",
          priority: input.priority,
          readyAt: input.readyAt ?? now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      })
      .returning();
    return entry!;
  }

  async function getEntry(companyId: string, unitId: string) {
    return await db
      .select()
      .from(deliveryQueueEntries)
      .where(and(eq(deliveryQueueEntries.companyId, companyId), eq(deliveryQueueEntries.unitId, unitId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function setStatus(input: {
    companyId: string;
    unitId: string;
    status: DeliveryQueueStatus;
    lastErrorCode?: string | null;
    lastError?: string | null;
  }) {
    const now = new Date();
    await db
      .update(deliveryQueueEntries)
      .set({
        status: input.status,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.lastErrorCode !== undefined ? { lastErrorCode: input.lastErrorCode } : {}),
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        updatedAt: now,
      })
      .where(and(eq(deliveryQueueEntries.companyId, input.companyId), eq(deliveryQueueEntries.unitId, input.unitId)));
  }

  /** Return expired leases to `queued` and report the affected units. */
  async function reconcileExpiredLeases(now = new Date()) {
    const expired = await db
      .update(deliveryQueueEntries)
      .set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(
        eq(deliveryQueueEntries.status, "leased"),
        lt(deliveryQueueEntries.leaseExpiresAt, now),
      ))
      .returning({ unitId: deliveryQueueEntries.unitId, companyId: deliveryQueueEntries.companyId });
    return expired;
  }

  async function listOrdered(companyId: string, repositoryId: string, targetBranch: string, reader: Pick<Db, "select"> = db) {
    const rows = await reader
      .select()
      .from(deliveryQueueEntries)
      .where(and(
        eq(deliveryQueueEntries.companyId, companyId),
        eq(deliveryQueueEntries.repositoryId, repositoryId),
        eq(deliveryQueueEntries.targetBranch, targetBranch),
        inArray(deliveryQueueEntries.status, ["queued", "leased"]),
      ));
    return rows.sort(compareQueueEntries);
  }

  function compareQueueEntries(
    left: typeof deliveryQueueEntries.$inferSelect,
    right: typeof deliveryQueueEntries.$inferSelect,
  ) {
    const priority = deliveryPriorityRank(left.priority) - deliveryPriorityRank(right.priority);
    if (priority !== 0) return priority;
    const ready = left.readyAt.getTime() - right.readyAt.getTime();
    if (ready !== 0) return ready;
    const enqueued = left.enqueuedAt.getTime() - right.enqueuedAt.getTime();
    if (enqueued !== 0) return enqueued;
    return left.id.localeCompare(right.id);
  }

  /** Units whose `must_merge_after` dependencies are not yet delivered. */
  async function listUnsatisfiedMustMergeAfter(unitIds: string[], reader: Pick<Db, "select"> = db) {
    if (unitIds.length === 0) return new Map<string, string[]>();
    const rows = await reader
      .select({
        unitId: deliveryDependencies.unitId,
        dependsOnUnitId: deliveryDependencies.dependsOnUnitId,
        status: deliveryUnits.status,
      })
      .from(deliveryDependencies)
      .innerJoin(deliveryUnits, eq(deliveryUnits.id, deliveryDependencies.dependsOnUnitId))
      .where(and(
        eq(deliveryDependencies.kind, "must_merge_after"),
        inArray(deliveryDependencies.unitId, unitIds),
        sql`${deliveryUnits.status} not in ('merged', 'cancelled')`,
      ));
    const byUnit = new Map<string, string[]>();
    for (const row of rows) {
      const list = byUnit.get(row.unitId) ?? [];
      list.push(row.dependsOnUnitId);
      byUnit.set(row.unitId, list);
    }
    return byUnit;
  }

  /**
   * Lease the next ready entry for a repository+branch. Topology is enforced by
   * refusing to lease an entry whose `must_merge_after` dependencies are still
   * open; independent repositories never contend because the key includes the
   * repository. A transaction-scoped repository lock serializes the held-lease
   * check and candidate update across sweeps and server processes. The row CAS
   * still rejects candidates cancelled or changed during selection.
   */
  async function leaseNext(input: {
    companyId: string;
    repositoryId: string;
    targetBranch: string;
    leaseOwner: string;
    leaseMs?: number;
    now?: Date;
  }) {
    await reconcileExpiredLeases(input.now);
    return db.transaction(async (tx) => {
      const lockKey = `delivery-queue:${input.repositoryId}:${input.targetBranch}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const now = input.now ?? new Date();
      const held = await tx
        .select({ id: deliveryQueueEntries.id })
        .from(deliveryQueueEntries)
        .where(and(
          eq(deliveryQueueEntries.companyId, input.companyId),
          eq(deliveryQueueEntries.repositoryId, input.repositoryId),
          eq(deliveryQueueEntries.targetBranch, input.targetBranch),
          eq(deliveryQueueEntries.status, "leased"),
        ))
        .limit(1);
      if (held.length > 0) return null;
      const ordered = await listOrdered(input.companyId, input.repositoryId, input.targetBranch, tx);
      if (ordered.length === 0) return null;
      const blocked = await listUnsatisfiedMustMergeAfter(ordered.map((entry) => entry.unitId), tx);
      for (const candidate of ordered) {
        if (blocked.has(candidate.unitId) || candidate.status !== "queued") continue;
        const [leased] = await tx
          .update(deliveryQueueEntries)
          .set({
            status: "leased",
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: new Date(now.getTime() + (input.leaseMs ?? DELIVERY_QUEUE_LEASE_MS)),
            leaseEpoch: candidate.leaseEpoch + 1,
            attemptCount: candidate.attemptCount + 1,
            updatedAt: now,
          })
          .where(and(
            eq(deliveryQueueEntries.id, candidate.id),
            eq(deliveryQueueEntries.status, "queued"),
            eq(deliveryQueueEntries.leaseEpoch, candidate.leaseEpoch),
          ))
          .returning();
        if (leased) return leased;
      }
      return null;
    });
  }

  /** Release a lease held by `leaseOwner` at the expected epoch. */
  async function releaseLease(input: {
    companyId: string;
    unitId: string;
    leaseOwner: string;
    leaseEpoch: number;
    reasonCode?: string;
    reason?: string;
  }) {
    const now = new Date();
    const [released] = await db
      .update(deliveryQueueEntries)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(input.reasonCode ? { lastErrorCode: input.reasonCode } : {}),
        ...(input.reason ? { lastError: input.reason } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(deliveryQueueEntries.companyId, input.companyId),
        eq(deliveryQueueEntries.unitId, input.unitId),
        eq(deliveryQueueEntries.leaseOwner, input.leaseOwner),
        eq(deliveryQueueEntries.leaseEpoch, input.leaseEpoch),
      ))
      .returning();
    return released ?? null;
  }

  async function position(input: { companyId: string; unitId: string }) {
    const entry = await getEntry(input.companyId, input.unitId);
    if (!entry || (entry.status !== "queued" && entry.status !== "leased")) return null;
    const ordered = await listOrdered(input.companyId, entry.repositoryId, entry.targetBranch);
    const index = ordered.findIndex((candidate) => candidate.unitId === input.unitId);
    return index >= 0 ? index + 1 : null;
  }

  function toQueueEntry(
    entry: typeof deliveryQueueEntries.$inferSelect,
    issueId: string,
    repository: string,
    position: number,
  ): DeliveryQueueEntry {
    return {
      unitId: entry.unitId,
      issueId,
      repository,
      targetBranch: entry.targetBranch,
      status: entry.status,
      priority: entry.priority,
      position,
      leaseOwner: entry.leaseOwner,
      leaseExpiresAt: entry.leaseExpiresAt?.toISOString() ?? null,
      enqueuedAt: entry.enqueuedAt.toISOString(),
    };
  }

  async function listForCompany(companyId: string, repositoryId?: string) {
    return await db
      .select()
      .from(deliveryQueueEntries)
      .where(and(
        eq(deliveryQueueEntries.companyId, companyId),
        ...(repositoryId ? [eq(deliveryQueueEntries.repositoryId, repositoryId)] : []),
        inArray(deliveryQueueEntries.status, ["queued", "leased"]),
      ))
      .orderBy(asc(deliveryQueueEntries.readyAt), asc(deliveryQueueEntries.enqueuedAt));
  }

  /** Repositories with at least one open queue entry, for the sweep loop. */
  async function listActiveRepositoryKeys(companyId: string) {
    return await db
      .selectDistinct({
        repositoryId: deliveryQueueEntries.repositoryId,
        targetBranch: deliveryQueueEntries.targetBranch,
      })
      .from(deliveryQueueEntries)
      .where(and(
        eq(deliveryQueueEntries.companyId, companyId),
        inArray(deliveryQueueEntries.status, ["queued", "leased"]),
      ));
  }

  /** Units blocked behind a lease held by another controller instance. */
  async function countLeased(companyId: string, repositoryId: string, targetBranch: string) {
    return await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryQueueEntries)
      .where(and(
        eq(deliveryQueueEntries.companyId, companyId),
        eq(deliveryQueueEntries.repositoryId, repositoryId),
        eq(deliveryQueueEntries.targetBranch, targetBranch),
        eq(deliveryQueueEntries.status, "leased"),
      ))
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function clearForUnit(companyId: string, unitId: string, status: DeliveryQueueStatus) {
    await setStatus({ companyId, unitId, status });
  }

  async function hasOpenEntryForUnit(companyId: string, unitId: string) {
    return await db
      .select({ id: deliveryQueueEntries.id })
      .from(deliveryQueueEntries)
      .where(and(
        eq(deliveryQueueEntries.companyId, companyId),
        eq(deliveryQueueEntries.unitId, unitId),
        inArray(deliveryQueueEntries.status, ["queued", "leased"]),
      ))
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  return {
    enqueue,
    getEntry,
    setStatus,
    clearForUnit,
    reconcileExpiredLeases,
    listOrdered,
    listUnsatisfiedMustMergeAfter,
    leaseNext,
    releaseLease,
    position,
    toQueueEntry,
    listForCompany,
    listActiveRepositoryKeys,
    countLeased,
    hasOpenEntryForUnit,
  };
}

export type DeliveryQueueEntryRow = typeof deliveryQueueEntries.$inferSelect;

export interface DeliveryQueueService {
  enqueue(input: {
    companyId: string;
    repositoryId: string;
    targetBranch: string;
    unitId: string;
    priority: string;
    readyAt?: Date | null;
  }): Promise<DeliveryQueueEntryRow>;
  getEntry(companyId: string, unitId: string): Promise<DeliveryQueueEntryRow | null>;
  setStatus(input: {
    companyId: string;
    unitId: string;
    status: DeliveryQueueStatus;
    lastErrorCode?: string | null;
    lastError?: string | null;
  }): Promise<void>;
  clearForUnit(companyId: string, unitId: string, status: DeliveryQueueStatus): Promise<void>;
  reconcileExpiredLeases(now?: Date): Promise<Array<{ unitId: string; companyId: string }>>;
  listOrdered(companyId: string, repositoryId: string, targetBranch: string): Promise<DeliveryQueueEntryRow[]>;
  listUnsatisfiedMustMergeAfter(unitIds: string[]): Promise<Map<string, string[]>>;
  leaseNext(input: {
    companyId: string;
    repositoryId: string;
    targetBranch: string;
    leaseOwner: string;
    leaseMs?: number;
    now?: Date;
  }): Promise<DeliveryQueueEntryRow | null>;
  releaseLease(input: {
    companyId: string;
    unitId: string;
    leaseOwner: string;
    leaseEpoch: number;
    reasonCode?: string;
    reason?: string;
  }): Promise<DeliveryQueueEntryRow | null>;
  position(input: { companyId: string; unitId: string }): Promise<number | null>;
  toQueueEntry(
    entry: DeliveryQueueEntryRow,
    issueId: string,
    repository: string,
    position: number,
  ): DeliveryQueueEntry;
  listForCompany(companyId: string, repositoryId?: string): Promise<DeliveryQueueEntryRow[]>;
  listActiveRepositoryKeys(companyId: string): Promise<Array<{ repositoryId: string; targetBranch: string }>>;
  countLeased(companyId: string, repositoryId: string, targetBranch: string): Promise<number>;
  hasOpenEntryForUnit(companyId: string, unitId: string): Promise<boolean>;
}
