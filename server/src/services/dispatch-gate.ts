import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { dispatchGateState } from "@paperclipai/db";

/** The single scope this gate mediates today — one Claude Code install, one slot. */
export const CLAUDE_LOCAL_DEFAULT_SCOPE = "claude_local/default";

export interface DispatchGateOwner {
  kind: string;
  id: string;
}

export type DispatchGateBlockReason = "ownership_active" | "ownership_unknown" | "quota_blocked";

export interface DispatchGateBlockedResult {
  ok: false;
  reason: DispatchGateBlockReason;
  ownerKind?: string | null;
  ownerId?: string | null;
  blockedUntil?: Date | null;
  operatorResumeRequired?: boolean;
  blockReason?: string | null;
}

export type DispatchGateAcquireResult = { ok: true } | DispatchGateBlockedResult;

/** The confirmed transition a settled launch result maps to. */
export type DispatchGateSettlement =
  | { kind: "quota"; blockedUntil: Date | null; reason: string }
  | { kind: "idle" }
  | { kind: "unknown" };

let _db: Db | null = null;

/** Wire the shared database once at server startup (mirrors setPluginEventBus). */
export function setDispatchGateDb(db: Db): void {
  _db = db;
}

function requireDb(): Db {
  if (!_db) {
    throw new Error("Dispatch gate database not initialized — call setDispatchGateDb at startup");
  }
  return _db;
}

/**
 * Atomically claim the scope for `owner`. Runs entirely inside one DB
 * transaction: locks the scope row (creating it if absent), rejects an
 * active/unknown owner or a live quota block, and only then persists
 * ownership — so acquisition is never decided from in-memory state.
 */
export async function acquireDispatchGate(
  scopeKey: string,
  owner: DispatchGateOwner,
): Promise<DispatchGateAcquireResult> {
  const db = requireDb();
  return db.transaction(async (tx) => {
    await tx.insert(dispatchGateState).values({ scopeKey }).onConflictDoNothing();
    await tx.execute(
      sql`select 1 from ${dispatchGateState} where ${dispatchGateState.scopeKey} = ${scopeKey} for update`,
    );
    const [row] = await tx.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, scopeKey));
    if (!row) throw new Error(`dispatch gate row missing for scope ${scopeKey}`);

    const blockedUntil = row.blockedUntil ? new Date(row.blockedUntil) : null;
    const quotaActive = row.operatorResumeRequired || (blockedUntil !== null && blockedUntil.getTime() > Date.now());
    if (quotaActive) {
      return {
        ok: false,
        reason: "quota_blocked",
        blockedUntil,
        operatorResumeRequired: row.operatorResumeRequired,
        blockReason: row.blockReason,
      };
    }
    if (row.ownershipState === "active" || row.ownershipState === "unknown") {
      return {
        ok: false,
        reason: row.ownershipState === "active" ? "ownership_active" : "ownership_unknown",
        ownerKind: row.ownerKind,
        ownerId: row.ownerId,
      };
    }

    await tx
      .update(dispatchGateState)
      .set({
        ownershipState: "active",
        ownerKind: owner.kind,
        ownerId: owner.id,
        blockedUntil: null,
        operatorResumeRequired: false,
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(eq(dispatchGateState.scopeKey, scopeKey));
    return { ok: true };
  });
}

/**
 * Release to idle. Only takes effect if `owner` still holds the scope as
 * active — a single atomic UPDATE, no separate lock statement needed since
 * there is no read-then-write gap to protect.
 */
export async function releaseDispatchGate(scopeKey: string, owner: DispatchGateOwner): Promise<void> {
  await requireDb()
    .update(dispatchGateState)
    .set({ ownershipState: "idle", ownerKind: null, ownerId: null, updatedAt: new Date() })
    .where(
      and(
        eq(dispatchGateState.scopeKey, scopeKey),
        eq(dispatchGateState.ownerKind, owner.kind),
        eq(dispatchGateState.ownerId, owner.id),
        eq(dispatchGateState.ownershipState, "active"),
      ),
    );
}

/** Ambiguous outcome (crash, lost handle, unclear termination): active -> unknown. Never idle. */
export async function markDispatchGateUnknown(scopeKey: string, owner: DispatchGateOwner): Promise<void> {
  await requireDb()
    .update(dispatchGateState)
    .set({ ownershipState: "unknown", updatedAt: new Date() })
    .where(
      and(
        eq(dispatchGateState.scopeKey, scopeKey),
        eq(dispatchGateState.ownerKind, owner.kind),
        eq(dispatchGateState.ownerId, owner.id),
      ),
    );
}

/** Persist a confirmed structured quota result and free the ownership slot. */
export async function recordDispatchGateQuotaBlock(
  scopeKey: string,
  owner: DispatchGateOwner,
  block: { blockedUntil: Date | null; reason: string; operatorResumeRequired: boolean },
): Promise<void> {
  await requireDb()
    .update(dispatchGateState)
    .set({
      ownershipState: "idle",
      ownerKind: null,
      ownerId: null,
      blockedUntil: block.blockedUntil,
      operatorResumeRequired: block.operatorResumeRequired,
      blockReason: block.reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dispatchGateState.scopeKey, scopeKey),
        eq(dispatchGateState.ownerKind, owner.kind),
        eq(dispatchGateState.ownerId, owner.id),
      ),
    );
}

/** Explicit operator resume — the only way to clear an `operatorResumeRequired` block. */
export async function resumeDispatchGate(scopeKey: string): Promise<void> {
  await requireDb()
    .update(dispatchGateState)
    .set({ blockedUntil: null, operatorResumeRequired: false, blockReason: null, updatedAt: new Date() })
    .where(eq(dispatchGateState.scopeKey, scopeKey));
}

/**
 * Apply a settled outcome to the gate: a confirmed quota result persists the
 * block as part of the same transition that frees ownership, a confirmed
 * non-quota result releases to idle, and anything else — including the
 * classifier itself throwing — fails closed to `unknown` rather than being
 * assumed safe. Shared by every launch surface that settles a result outside
 * of `withDispatchGate`'s run()-wrapping shape: board chat and Claude login
 * both acquire the gate well before a result becomes available (an
 * event-driven child process, or a call awaited far from the acquire site),
 * so they cannot use `run()` to bracket acquisition and settlement.
 */
export async function settleDispatchGateResult<TResult>(
  scopeKey: string,
  owner: DispatchGateOwner,
  result: TResult,
  classify: (result: TResult) => DispatchGateSettlement,
): Promise<void> {
  let settlement: DispatchGateSettlement;
  try {
    settlement = classify(result);
  } catch {
    settlement = { kind: "unknown" };
  }

  if (settlement.kind === "quota") {
    await recordDispatchGateQuotaBlock(scopeKey, owner, {
      blockedUntil: settlement.blockedUntil,
      reason: settlement.reason,
      operatorResumeRequired: settlement.blockedUntil === null,
    });
  } else if (settlement.kind === "unknown") {
    await markDispatchGateUnknown(scopeKey, owner);
  } else {
    await releaseDispatchGate(scopeKey, owner);
  }
}

/**
 * Wrap an async launch function with the gate: acquire, run, then settle via
 * `settleDispatchGateResult`. A thrown/rejected `run` leaves ownership
 * ambiguous before a result even exists, so it transitions to `unknown`
 * directly — never inferred as a clean release.
 */
export async function withDispatchGate<TResult>(
  scopeKey: string,
  owner: DispatchGateOwner,
  run: () => Promise<TResult>,
  options: {
    onBlocked: (blocked: DispatchGateBlockedResult) => TResult;
    classifyQuota?: (result: TResult) => { blockedUntil: Date | null; reason: string } | null;
  },
): Promise<TResult> {
  const acquisition = await acquireDispatchGate(scopeKey, owner);
  if (!acquisition.ok) return options.onBlocked(acquisition);

  let result: TResult;
  try {
    result = await run();
  } catch (err) {
    await markDispatchGateUnknown(scopeKey, owner);
    throw err;
  }

  await settleDispatchGateResult(scopeKey, owner, result, (settled) => {
    const quota = options.classifyQuota?.(settled) ?? null;
    return quota ? { kind: "quota", ...quota } : { kind: "idle" };
  });
  return result;
}
