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
 * Wrap an async launch function with the gate: acquire, run, then release on
 * confirmed settlement or classify a quota block. A thrown/rejected `run`
 * leaves ownership ambiguous, so it transitions to `unknown` rather than
 * `idle` — never inferred as a clean release.
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

  const quota = options.classifyQuota?.(result) ?? null;
  if (quota) {
    await recordDispatchGateQuotaBlock(scopeKey, owner, {
      blockedUntil: quota.blockedUntil,
      reason: quota.reason,
      operatorResumeRequired: quota.blockedUntil === null,
    });
  } else {
    await releaseDispatchGate(scopeKey, owner);
  }
  return result;
}
