import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyTransferRuns } from "@paperclipai/db";

// Durable run ledger for chunked company transfers. A run tracks one export
// publish or import apply of a transfer container. Progress is recorded per
// container part (chunk or blob name) as each part finishes processing and
// verification, so an interrupted run — process restart, dropped connection,
// failed part — resumes from the parts it already completed. The transfer
// manifest's content-derived idempotency key ties retries of the same content
// to the same run instead of starting over.
//
// Status machine — every transition site, in one place:
//
//   (insert)                                  -> pending    resumeOrCreate
//   pending|running|failed  --start---------> running
//   pending|running|failed  --claimApply----> applying     exactly one winner of concurrent applies
//   applying                --complete------> completed    terminal; no path ever reopens it
//   applying                --releaseApplyClaim-> failed   guarded on "applying", so a cleanup error
//                                                          after complete() is a no-op release
//   applying                --recoverStrandedApplyingRuns-> failed
//                                                          startup only: in-memory applies died with the process
//   pending|running (idle)  --cancelIfIdle--> cancelled    sweep claim; also guarded on a stale updatedAt
//   pending|running|failed  --cancel--------> cancelled
//   (any)                   --fail----------> failed       unguarded settle; callers use it only on runs
//                                                          they know are open (else releaseApplyClaim)
//
//   failed:    retryable — in the resume lookup and claimable by claimApply.
//   completed: terminal — resumeOrCreate short-circuits with alreadyCompleted.
//   cancelled: terminal and unclaimable — excluded from the resume lookup, so
//              redeclaring the same content after a sweep starts a fresh run.
//   completePart records parts only under pending|running — never onto an
//   applying or terminal run.

export type CompanyTransferDirection = "export" | "import";
export type CompanyTransferRunStatus =
  | "pending"
  | "running"
  | "applying"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Minimal structural view of a transfer manifest's part index: the ledger only
 * ever needs part names and counts, so it stays decoupled from any particular
 * container format. Manifests without this shape (e.g. the chunked zip-upload
 * manifest, which carries its own part list) pass explicit counts to
 * `recordManifest` and track parts by their own names.
 */
export interface CompanyTransferPartsIndex {
  chunks: Array<{ name: string }>;
  blobs: Array<{ name: string }>;
}

function asPartsIndex(manifest: unknown): CompanyTransferPartsIndex | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const { chunks, blobs } = manifest as { chunks?: unknown; blobs?: unknown };
  const named = (value: unknown): value is Array<{ name: string }> =>
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string",
    );
  if (!named(chunks) || !named(blobs)) return null;
  return { chunks, blobs };
}

const RESUMABLE_STATUSES: CompanyTransferRunStatus[] = ["pending", "running", "failed"];
/** Statuses under which container parts may still be recorded as completed. */
const PART_UPLOAD_STATUSES: CompanyTransferRunStatus[] = ["pending", "running"];

export interface CompanyTransferRunRow {
  id: string;
  companyId: string | null;
  direction: CompanyTransferDirection;
  status: CompanyTransferRunStatus;
  actorKey: string;
  containerRef: unknown;
  idempotencyKey: string;
  manifestSha256: string | null;
  manifest: unknown;
  chunkCount: number;
  blobCount: number;
  completedParts: string[];
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResumeOrCreateTransferRunInput {
  direction: CompanyTransferDirection;
  actorKey: string;
  idempotencyKey: string;
  /** Credential-free container location descriptor. Never put secrets here. */
  containerRef: unknown;
  companyId?: string | null;
}

export interface ResumeOrCreateTransferRunResult {
  run: CompanyTransferRunRow;
  /** True when an existing run for the same content was picked up. */
  resumed: boolean;
  /** True when that existing run already finished — the caller can short-circuit. */
  alreadyCompleted: boolean;
}

function rowFromRecord(record: typeof companyTransferRuns.$inferSelect): CompanyTransferRunRow {
  return {
    ...record,
    direction: record.direction as CompanyTransferDirection,
    status: record.status as CompanyTransferRunStatus,
    manifest: record.manifest ?? null,
    completedParts: Array.isArray(record.completedParts) ? (record.completedParts as string[]) : [],
  };
}

async function getRun(db: Db, runId: string): Promise<CompanyTransferRunRow | null> {
  const [record] = await db
    .select()
    .from(companyTransferRuns)
    .where(eq(companyTransferRuns.id, runId))
    .limit(1);
  return record ? rowFromRecord(record) : null;
}

export const companyTransferRunService = {
  getRun,

  async getRunForActor(db: Db, runId: string, actorKey: string): Promise<CompanyTransferRunRow | null> {
    const run = await getRun(db, runId);
    return run && run.actorKey === actorKey ? run : null;
  },

  /**
   * Find the actor's run for this exact content (same idempotency key and
   * direction) or create a fresh one. A completed prior run is returned with
   * `alreadyCompleted` so the caller can skip the apply outright; a pending,
   * running, failed, or mid-apply prior run is resumed with its part progress
   * intact (an "applying" run resumes so a concurrent re-declaration never
   * spawns a duplicate, but `start` leaves it alone until the apply settles).
   */
  async resumeOrCreate(db: Db, input: ResumeOrCreateTransferRunInput): Promise<ResumeOrCreateTransferRunResult> {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // No unique index backs the (actor, direction, content key) lookup, so
      // two concurrent identical declarations could both miss the lookup and
      // both insert. Serialize them with a transaction-scoped advisory lock
      // on the key: the second caller waits here until the first commits and
      // then resumes the first caller's row.
      const lockKey = `${input.actorKey}|${input.direction}|${input.idempotencyKey}`;
      await txDb.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const matches = await txDb
        .select()
        .from(companyTransferRuns)
        .where(
          and(
            eq(companyTransferRuns.idempotencyKey, input.idempotencyKey),
            eq(companyTransferRuns.direction, input.direction),
            eq(companyTransferRuns.actorKey, input.actorKey),
            inArray(companyTransferRuns.status, [...RESUMABLE_STATUSES, "applying", "completed"]),
          ),
        )
        .orderBy(desc(companyTransferRuns.createdAt))
        .limit(1);
      const existing = matches[0] ? rowFromRecord(matches[0]) : null;
      if (existing) {
        return { run: existing, resumed: true, alreadyCompleted: existing.status === "completed" };
      }
      const [created] = await txDb
        .insert(companyTransferRuns)
        .values({
          direction: input.direction,
          actorKey: input.actorKey,
          idempotencyKey: input.idempotencyKey,
          containerRef: input.containerRef,
          companyId: input.companyId ?? null,
        })
        .returning();
      return { run: rowFromRecord(created!), resumed: false, alreadyCompleted: false };
    });
  },

  /**
   * Persist the parsed manifest so resume can re-verify parts without
   * refetching it. Counts default to the manifest's chunk/blob index when it
   * has one; manifests with a different part layout pass them explicitly.
   */
  async recordManifest(
    db: Db,
    runId: string,
    manifest: unknown,
    manifestSha256: string,
    counts?: { chunkCount: number; blobCount: number },
  ): Promise<void> {
    const index = asPartsIndex(manifest);
    const chunkCount = counts?.chunkCount ?? index?.chunks.length ?? 0;
    const blobCount = counts?.blobCount ?? index?.blobs.length ?? 0;
    await db
      .update(companyTransferRuns)
      .set({
        manifest,
        manifestSha256,
        chunkCount,
        blobCount,
        updatedAt: new Date(),
      })
      .where(eq(companyTransferRuns.id, runId));
  },

  /**
   * Atomically claim a run for apply. The apply itself is not idempotent, so
   * of any overlapping apply attempts exactly one caller gets `true` here —
   * a single guarded UPDATE moves the run to "applying" only while it is
   * still open (pending/running/failed). The winner settles the claim with
   * `complete` on success or `releaseApplyClaim`/`fail` on error (which makes
   * the run retryable again); every concurrent loser gets `false` and must
   * not run the apply.
   */
  async claimApply(db: Db, runId: string): Promise<boolean> {
    const claimed = await db
      .update(companyTransferRuns)
      .set({ status: "applying", error: null, updatedAt: new Date() })
      .where(
        and(eq(companyTransferRuns.id, runId), inArray(companyTransferRuns.status, RESUMABLE_STATUSES)),
      )
      .returning({ id: companyTransferRuns.id });
    return claimed.length > 0;
  },

  async start(db: Db, runId: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ status: "running", error: null, startedAt: new Date(), finishedAt: null, updatedAt: new Date() })
      .where(
        and(eq(companyTransferRuns.id, runId), inArray(companyTransferRuns.status, RESUMABLE_STATUSES)),
      );
  },

  async attachCompany(db: Db, runId: string, companyId: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ companyId, updatedAt: new Date() })
      .where(eq(companyTransferRuns.id, runId));
  },

  /**
   * Record one finished container part. Appends atomically in SQL and is
   * idempotent: re-completing an already recorded part leaves the ledger
   * unchanged, so a retried part never double-counts. Only open runs
   * (pending/running) accept parts; when the run has meanwhile gone terminal
   * (e.g. the abandoned-spool sweep cancelled it) or is mid-apply, nothing is
   * recorded and `false` comes back so the caller can discard the part.
   */
  async completePart(db: Db, runId: string, partName: string): Promise<boolean> {
    const partJson = JSON.stringify([partName]);
    const updated = await db
      .update(companyTransferRuns)
      .set({
        completedParts: sql`case when ${companyTransferRuns.completedParts} @> ${partJson}::jsonb then ${companyTransferRuns.completedParts} else ${companyTransferRuns.completedParts} || ${partJson}::jsonb end`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(companyTransferRuns.id, runId), inArray(companyTransferRuns.status, PART_UPLOAD_STATUSES)),
      )
      .returning({ id: companyTransferRuns.id });
    return updated.length > 0;
  },

  /** Container part names the run still has to process, in manifest order. */
  remainingParts(run: CompanyTransferRunRow, manifest: CompanyTransferPartsIndex): string[] {
    const completed = new Set(run.completedParts);
    const remaining: string[] = [];
    for (const chunk of manifest.chunks) {
      if (!completed.has(chunk.name)) remaining.push(chunk.name);
    }
    for (const blob of manifest.blobs) {
      if (!completed.has(blob.name)) remaining.push(blob.name);
    }
    return remaining;
  },

  async complete(db: Db, runId: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ status: "completed", error: null, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(companyTransferRuns.id, runId));
  },

  /**
   * Atomically claim an abandoned open run: cancel it only while it is still
   * open (pending/running) AND saw no activity since `idleSince` — one
   * guarded UPDATE, so any concurrent part upload or resume that bumped
   * `updatedAt` makes the guard miss and `false` comes back. Callers must
   * only touch the run's spooled data after a `true` claim.
   *
   * The terminal state is "cancelled", not "failed", precisely because failed
   * runs stay claimable: a failed sweep target could be claimed by an apply
   * and assembled while its spool is being deleted underneath it. A cancelled
   * run is unclaimable the instant this UPDATE commits — before any
   * filesystem deletion — and `resumeOrCreate` ignores it, so redeclaring the
   * same content afterwards starts a fresh run.
   */
  async cancelIfIdle(db: Db, runId: string, idleSince: Date, error: string): Promise<boolean> {
    const claimed = await db
      .update(companyTransferRuns)
      .set({ status: "cancelled", error, finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(companyTransferRuns.id, runId),
          inArray(companyTransferRuns.status, PART_UPLOAD_STATUSES),
          lt(companyTransferRuns.updatedAt, idleSince),
        ),
      )
      .returning({ id: companyTransferRuns.id });
    return claimed.length > 0;
  },

  /**
   * Release a held apply claim into "failed". Guarded on "applying", unlike
   * `fail`: catch-all error paths around an apply cannot know whether the run
   * already settled (a cleanup error thrown after `complete` reaches the same
   * catch as a real apply failure), and an unguarded fail there would flip a
   * completed run back to claimable and invite a duplicate import. When the
   * run already settled this is a no-op and returns false.
   */
  async releaseApplyClaim(db: Db, runId: string, error: string): Promise<boolean> {
    const released = await db
      .update(companyTransferRuns)
      .set({ status: "failed", error, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(companyTransferRuns.id, runId), eq(companyTransferRuns.status, "applying")))
      .returning({ id: companyTransferRuns.id });
    return released.length > 0;
  },

  /**
   * Fail every run stranded in "applying" by a dead process. Apply jobs run
   * in-memory in this single server process, so at boot any run still
   * "applying" belongs to an apply that died without settling its claim and
   * would otherwise 409 every retry forever. Failing it makes it claimable
   * again with its spooled parts intact. Startup only — running this while
   * applies may be live (e.g. from a periodic sweep) would kill them.
   */
  async recoverStrandedApplyingRuns(db: Db): Promise<string[]> {
    const recovered = await db
      .update(companyTransferRuns)
      .set({
        status: "failed",
        error: "apply interrupted by a restart — verify whether the import completed before retrying",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(companyTransferRuns.status, "applying"))
      .returning({ id: companyTransferRuns.id });
    return recovered.map((row) => row.id);
  },

  async fail(db: Db, runId: string, error: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ status: "failed", error, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(companyTransferRuns.id, runId));
  },

  async cancel(db: Db, runId: string): Promise<void> {
    await db
      .update(companyTransferRuns)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(companyTransferRuns.id, runId), inArray(companyTransferRuns.status, RESUMABLE_STATUSES)));
  },
};
